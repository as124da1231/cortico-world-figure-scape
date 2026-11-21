import { randomUUID } from 'node:crypto';
import type { createModelDomain } from './model-domain.ts';
import type { createBodyControls } from './body-controls.ts';
import type { createDraftActionDomain } from './draft-action-domain.ts';
import type { createAppearanceDomain } from './appearance-domain.ts';
// @ts-expect-error Shared Figure conflict metadata.
import { ParameterConflict } from '../../live2d-runtime/pack/backends/native-combination.js';
import type { ModelProfile } from './model-contract.ts';

interface EditSession {
  id: string;
  figure: string;
  sourceId: string;
  revision: string;
  catalogFingerprint?: string;
  draft?: ModelProfile;
}

/** The editing scope survives navigation. The body owns temporary playback and its cleanup. */
export function createEditService(ports: {
  model: Pick<ReturnType<typeof createModelDomain>, 'editor' | 'save' | 'validate'>;
  body: ReturnType<typeof createBodyControls>;
  actions: ReturnType<typeof createDraftActionDomain>;
  appearance: ReturnType<typeof createAppearanceDomain>;
  previewVisual: (figure: string, owner: string, value: ModelProfile['visual']) => string;
  previewAppearance: (figure: string, owner: string, scheme: string) => boolean;
  previewDraftWardrobe: (figure: string, owner: string, profile: ModelProfile, picks: Record<string, string>, requestId: string) => boolean;
  selected: () => string;
  release: (figure: string, owner: string) => void;
}) {
  let session: EditSession | null = null;
  let editing = false;

  function get(id: unknown, needsBody = false): EditSession {
    if (!session || session.id !== id) throw Error('Open an edit session first');
    if (needsBody && session.figure !== ports.selected()) throw Error('The active model changed; reopen the editor');
    return session;
  }
  function release() {
    const previous = session;
    session = null;
    if (previous) ports.release(previous.figure, previous.id);
    return { released: previous !== null };
  }
  return {
    release,
    releasePreview() { if (session) ports.release(session.figure, session.id); },
    async invoke(method: string, args: unknown[]) {
      switch (method) {
        case 'edit.state': return session ? structuredClone(session) : null;
        case 'edit.open': {
          const current = await ports.model.editor(args[0]);
          const editor = current.editor;
          if (!editor) throw Error('Open an owned raw Live2D model first');
          if (session?.figure !== current.figure) {
            release();
            session = {
              id: randomUUID(), figure: current.figure, sourceId: editor.sourceId,
              revision: editor.revision, catalogFingerprint: editor.catalogFingerprint,
            };
          }
          return { session: structuredClone(session), editor };
        }
        case 'edit.inspectConflict': {
          const target = get(args[0]);
          try {
            await ports.model.validate(target.figure, args[1], target.revision, target.catalogFingerprint);
            return { compatible: true, conflict: null };
          } catch (error) {
            if (!(error instanceof ParameterConflict)) throw error;
            return { compatible: false, conflict: (error as Error & { detail: unknown }).detail };
          }
        }
        case 'edit.validate': {
          const target = get(args[0]);
          if (editing) throw Error('The model configuration is being saved');
          const validated = await ports.model.validate(target.figure, args[1], target.revision, target.catalogFingerprint);
          if (get(args[0]) !== target) throw Error('The edit session changed');
          target.draft = validated;
          return { session: structuredClone(target), profile: validated };
        }
        case 'edit.previewAction': {
          const target = get(args[0], true);
          const word = args[1];
          const binding = target.draft?.bindings?.find(binding => binding.word === word);
          if (!binding) throw Error('Validate a draft with this action binding first');
          return ports.actions.run(target.figure, { kind: 'play', owner: target.id, binding, ...(args[2] !== undefined ? { mode: args[2] } : {}) });
        }
        case 'edit.previewAppearance': {
          const target = get(args[0], true);
          const scheme = ports.appearance.selection(target.figure, args[1]);
          if (!ports.previewAppearance(target.figure, target.id, scheme)) throw Error('The main window is not connected');
          return { accepted: true, owner: target.id, scheme };
        }
        case 'edit.previewDraftWardrobe': {
          const target = get(args[0], true);
          const profile = target.draft;
          if (!profile?.wardrobe) throw Error('Validate a draft with wardrobe groups first');
          const raw = args[1];
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Choose wardrobe options');
          const picks: Record<string, string> = {};
          for (const [id, option] of Object.entries(raw)) {
            const group = profile.wardrobe.find(group => group.id === id);
            if (!group || typeof option !== 'string' || (option !== 'default' && !group.options.some(item => item.id === option))) {
              throw Error('Unknown draft wardrobe option');
            }
            picks[id] = option;
          }
          const requestId = randomUUID();
          if (!ports.previewDraftWardrobe(target.figure, target.id, profile, picks, requestId)) throw Error('The main window is not connected');
          return { accepted: true, owner: target.id, requestId };
        }
        case 'edit.previewVisual': {
          const target = get(args[0], true);
          if (!target.draft?.visual) throw Error('Validate a draft with visual settings first');
          return { accepted: true, owner: target.id, requestId: ports.previewVisual(target.figure, target.id, target.draft.visual) };
        }
        case 'edit.previewFraming': {
          const target = get(args[0], true);
          return ports.body.previewFraming(target.figure, args[1], target.id);
        }
        case 'edit.save': {
          const target = get(args[0]);
          if (editing) throw Error('The model configuration is already being saved');
          if (!target.draft) throw Error('Validate a draft before saving');
          editing = true;
          try {
            const result = await ports.model.save(target.figure, target.draft, target.revision, target.catalogFingerprint, args[1]);
            if (session === target && result.editor) {
              const previousFigure = target.figure;
              if (result.applied) target.figure = ports.selected();
              target.revision = result.editor.revision;
              target.catalogFingerprint = result.editor.catalogFingerprint;
              target.draft = undefined;
              ports.release(previousFigure, target.id);
            }
            return result;
          } finally { editing = false; }
        }
        case 'edit.release': {
          if (session?.id !== args[0]) return { released: false };
          return release();
        }
        default: throw Error('Unknown model editing command');
      }
    },
  };
}
