import { randomUUID } from 'node:crypto';
import type { BodyTransaction } from './body-transaction.ts';
import type { ModelResources, ModelEditorState, ModelConfiguration } from './model-contract.ts';

export const MODEL_FIT_FIELDS = Object.freeze([
  { path: 'fit.zoom', type: 'number', min: .1, max: 5, step: .01 },
  { path: 'fit.offset.0', type: 'number', min: -2, max: 2, step: .01 },
  { path: 'fit.offset.1', type: 'number', min: -2, max: 2, step: .01 },
  { path: 'fit.padding.0', type: 'number', min: 0, max: .45, step: .01 },
  { path: 'fit.padding.1', type: 'number', min: 0, max: .45, step: .01 },
]);
export const MODEL_BEHAVIOR_FIELDS = Object.freeze([
  { path: 'crop.mode', type: 'enum', options: ['full','upper'], default:'full', owner:'body' },
  { path: 'crop.edge', type: 'enum', options: ['flat','round'], default:'flat', owner:'body' },
  { path: 'crop.line', type: 'number', min:.2,max:.95,step:.01,default:.6,owner:'body' },
  { path: 'crop.curve', type: 'number', min:0,max:2,step:.05,default:1,owner:'body' },
  { path: 'crop.feather', type: 'number', min:0,max:.25,step:.01,default:.05,owner:'body' },
  { path: 'crop.transition', type: 'number', min:0,max:1.2,step:.01,default:.24,owner:'body' },
  { path: 'motion.kind', type: 'enum', options: ['roam', 'stand'], default: 'roam', owner: 'body' },
  { path: 'facing', type: 'enum', options: ['fixed', 'mirror'], default: 'fixed', owner: 'body' },
  { path: 'gaze.enabled', type: 'boolean', default: true, owner: 'body' },
  { path: 'gaze.speed', type: 'number', min: .25, max: 2.5, step: .05, default: 1, owner: 'body' },
  { path: 'emotionEffect', type: 'enum', options: ['native', 'kaomoji', 'orb', 'flow', 'bubbles', 'softglow'], default: 'native', owner: 'body' },
  { path: 'emotionEffectSize', type: 'enum', options: ['small', 'medium', 'large'], default: 'medium', owner: 'body' },
]);
export interface ModelOperation {
  operationId?: string;
  bodyId?: string;
  sequence: number; phase: 'idle'|'saving'|'preparing'|'applying'|'completed'|'failed'|'cancelled';
  saved: boolean; applied: boolean; candidate: string|null; error: string|null;
  application?: 'configuration'|'replacement';
  revision?: string;
}
type ModelSelection = { file: string } | { figure: string };
type ModelRequest<Selection> =
  | { kind: 'open' | 'import'; file: unknown }
  | { kind: 'select'; figure: unknown; options?: Selection }
  | { kind: 'save'; figure: string; profile: unknown; revision: string; catalogFingerprint?: string; library?: boolean }
  | { kind: 'apply'; figure: string; revision: string };

/** Node-side model domain. Resource compilation, durable profile and active renderer are distinct. */
export function createModelDomain<Receipt, Selection = never>(ports: {
  bodyId?: string;
  externallyBusy?: () => boolean;
  transaction?: BodyTransaction;
  resources?: ModelResources;
  selected: () => string;
  behavior?: () => unknown;
  framing?: () => unknown;
  prepare: (file: string, signal: AbortSignal, options?: { librarySelection: string }) => Promise<string>;
  available: () => boolean;
  resolveSelection?: (figure: string, signal: AbortSignal) => Promise<ModelSelection>;
  load: (figure: string, signal: AbortSignal, options?: Selection) => Promise<Receipt|undefined>;
  configure?: (figure:string,configuration:ModelConfiguration,signal:AbortSignal)=>Promise<Receipt|undefined>;
  applied: (receipt: Receipt|undefined) => boolean;
  commit: (figure: string, receipt: Receipt|undefined, options?: Selection) => void;
}) {
  let state: ModelOperation = { sequence: 0, phase: 'idle', saved: false, applied: false, candidate: null, error: null };
  let pending: { controller: AbortController; task: Promise<ModelOperation> }|null = null;
  const history = new Map<string, { signature: string; state: ModelOperation; task: Promise<ModelOperation> }>();
  const editorParameters = new Map<string, { revision: string; fingerprint?: string; parameters: Array<{ id:string; roles:string[] }> }>();
  const snapshot = () => ({ ...state, available: ports.available(), editable: !!ports.resources?.saveProfile,
    selected: ports.selected(), provider: ports.resources?.provider ?? 'unavailable', busy: pending !== null });
  async function run(request: ModelRequest<Selection>, requestedId?: unknown): Promise<ModelOperation> {
    if (requestedId !== undefined && (typeof requestedId !== 'string' || !/^[\w-]{1,80}$/.test(requestedId))) {
      throw Error('Invalid operation ID');
    }
    const operationId = requestedId as string | undefined ?? randomUUID();
    const signature = JSON.stringify(request);
    const previousOperation = history.get(operationId);
    if (previousOperation) {
      if (previousOperation.signature !== signature) throw Error('Operation ID already belongs to a different request');
      return previousOperation.task;
    }
    if (pending || ports.externallyBusy?.()) throw Error('A model is already loading');
    if (request.kind !== 'select' && !ports.available()) throw Error('No model resource implementation is available');
    if (request.kind === 'open' || request.kind === 'import') {
      if (typeof request.file !== 'string' || !/(?:\.scml|\.model3\.json|(?:^|[/\\])figure\.json)$/i.test(request.file)) {
        throw Error('Select a .model3.json, figure.json or .scml file');
      }
    }
    const previous = ports.selected();
    if (request.kind === 'save' || request.kind === 'apply') {
      if (((request.kind === 'apply' || !request.library) && previous !== request.figure) || !ports.resources?.editor || (request.kind === 'save' && !ports.resources.saveProfile)) {
        throw Error('The active model changed; reload the editor');
      }
    }
    const release = ports.transaction?.reserve('model');
    const controller = new AbortController(), { signal } = controller;
    state = {
      operationId, bodyId: ports.bodyId,
      sequence: state.sequence + 1, phase: request.kind === 'save' ? 'saving' : 'preparing',
      saved: false, applied: false, candidate: null, error: null,
    };
    function assertCurrent() {
      signal.throwIfAborted();
      if (ports.selected() !== previous) throw Error('The active model changed during preparation');
    }
    // Reserve before invoking any implementation, including the resource lookup.
    const task = Promise.resolve().then(async () => {
      try {
        let selection: ModelSelection;
        if ('file' in request) selection = { file: request.file as string };
        else if (request.kind === 'select') {
          if (typeof request.figure !== 'string' || !request.figure || !ports.resolveSelection) {
            throw Error('The resource is no longer available');
          }
          selection = await ports.resolveSelection(request.figure, signal);
        } else {
          const resources = ports.resources!;
          const editor = await resources.editor!(request.figure);
          assertCurrent();
          if (!editor) throw Error('Open an owned raw Live2D model first');
          let saved: ModelEditorState;
          if (request.kind === 'save') {
            validateMouth(request.profile, editor, previous === request.figure, request.figure);
            saved = request.catalogFingerprint === undefined
              ? await resources.saveProfile!(request.figure, request.profile, request.revision)
              : await resources.saveProfile!(request.figure, request.profile, request.revision, request.catalogFingerprint);
          } else {
            if (!editor.saved || !request.revision || editor.revision !== request.revision) {
              throw Error('The saved model configuration changed; reload the editor');
            }
            saved = editor;
          }
          state.saved = true;
          state.revision = saved.revision;
          assertCurrent();
          if (request.figure !== previous) {
            state.candidate = request.figure;
            state.phase = 'completed';
            return { ...state };
          }
          if (ports.configure && resources.prepareConfiguration) {
            const configuration = await resources.prepareConfiguration(request.figure, saved);
            assertCurrent();
            if (configuration) {
              state.application = 'configuration';
              state.phase = 'applying';
              state.candidate = previous;
              const receipt = await ports.configure(previous, configuration, signal);
              state.applied = ports.applied(receipt);
              if (!state.applied) signal.throwIfAborted();
              state.phase = 'completed';
              return { ...state };
            }
          }
          selection = { file: editor.modelFile };
        }

        assertCurrent();
        state.phase = 'preparing';
        state.application = 'replacement';
        const figure = 'figure' in selection ? selection.figure
          : request.kind === 'import' ? await ports.prepare(selection.file, signal, { librarySelection: previous })
          : await ports.prepare(selection.file, signal);
        state.candidate = figure;
        assertCurrent();
        if (request.kind === 'import') {
          state.phase = 'completed';
          return { ...state };
        }
        state.phase = 'applying';
        const options = request.kind === 'select' ? request.options : undefined;
        const receipt = await (options === undefined ? ports.load(figure, signal) : ports.load(figure, signal, options));
        state.applied = ports.applied(receipt);
        // A matching first-frame receipt already committed in the renderer.
        if (!state.applied) signal.throwIfAborted();
        if (options === undefined) ports.commit(figure, receipt);
        else ports.commit(figure, receipt, options);
        state.phase = 'completed';
        return { ...state };
      } catch (error) {
        state.phase = signal.aborted ? 'cancelled' : 'failed';
        state.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        pending = null;
        release?.();
      }
    });
    pending = { controller, task };
    history.set(operationId, { signature, state, task });
    if (history.size > 64) history.delete(history.keys().next().value!);
    return task;
  }
  function validateMouth(profile: unknown, editor: ModelEditorState, active = true, figure?: string) {
    const mouth = (profile as {mouth?:{mode?:unknown;targets?:unknown}}|null)?.mouth;
    if (mouth?.mode !== 'mapped' || JSON.stringify(mouth) === JSON.stringify(editor.profile.mouth)) return;
    const preview = figure && editorParameters.get(figure);
    const behavior = (active ? ports.behavior?.() : null) as {mouth?:{parameters?:Array<{id:string;roles:string[]}>}}|null;
    const parameters = behavior?.mouth?.parameters ?? (preview && preview.revision === editor.revision && preview.fingerprint === editor.catalogFingerprint ? preview.parameters : null);
    if (!Array.isArray(mouth.targets) || !mouth.targets.length || !parameters) throw Error('Open the live model preview to choose real mouth parameters');
    for (const id of mouth.targets) {
      const parameter = parameters.find(p => p.id === id);
      if (!parameter) throw Error('Mouth target is not in the active model parameter catalogue');
      if (parameter.roles.some(role => role !== 'mouthOpen')) throw Error('Mouth target is owned by another semantic role');
    }
  }
  return {
    snapshot,
    previewParameters(figure: string, revision: string, fingerprint: string | undefined, parameters: Array<{ id:string; roles:string[] }>) {
      editorParameters.set(figure, { revision, fingerprint, parameters });
      if(editorParameters.size>32)editorParameters.delete(editorParameters.keys().next().value!);
    },
    open: (file: unknown, operationId?: unknown) => run({ kind: 'open', file }, operationId),
    import: (file: unknown, operationId?: unknown) => run({ kind: 'import', file }, operationId),
    select: (figure: unknown, options?: Selection, operationId?: unknown) => run({ kind: 'select', figure, options }, operationId),
    applySaved: (figure: string, revision: string, operationId?: unknown) => run({ kind: 'apply', figure, revision }, operationId),
    operation(id: unknown) {
      const entry = typeof id === 'string' ? history.get(id) : undefined;
      return entry ? { ...entry.state } : null;
    },
    async cancel(id: unknown) {
      const work = pending;
      if (work && state.operationId === id) {
        work.controller.abort();
        await work.task.catch(() => {});
      }
      const entry = typeof id === 'string' ? history.get(id) : undefined;
      return entry ? { ...entry.state } : null;
    },
    async editor(target?: unknown) {
      const active = ports.selected();
      const figure = typeof target === 'string' ? target : active;
      const editor = await ports.resources?.editor?.(figure) ?? null;
      if (target === undefined && ports.selected() !== figure) throw Error('The active model changed; reload the editor');
      const activeTarget = ports.selected() === figure;
      return { figure, editor, active: activeTarget, fields: [...MODEL_FIT_FIELDS, ...MODEL_BEHAVIOR_FIELDS], behavior: activeTarget ? ports.behavior?.() ?? null : null, framing: activeTarget ? ports.framing?.() ?? null : null, operation: snapshot() };
    },
    async validate(figure: string, profile: unknown, revision: string, catalogFingerprint?: string) {
      if (!ports.resources?.validateProfile) throw Error('Open an owned raw Live2D model first');
      const editor = await ports.resources.editor?.(figure);
      if (!editor || editor.revision !== revision) throw Error('The active model or configuration changed');
      validateMouth(profile, editor, ports.selected() === figure, figure);
      return ports.resources.validateProfile(figure, profile, revision, catalogFingerprint);
    },
    async save(figure: string, profile: unknown, revision: string, catalogFingerprint?: string, operationId?: unknown, library = false) {
      const result = await run({ kind: 'save', figure, profile, revision, catalogFingerprint, library }, operationId);
      return { saved: result.saved, applied: result.applied, operation: result, editor: await ports.resources?.editor?.(result.applied || result.candidate === ports.selected() ? ports.selected() : figure) ?? null };
    },
    async stop() { const work = pending; work?.controller.abort(); await work?.task.catch(() => {}); },
  };
}
