import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { createModelDomain } from './model-domain.ts';
import type { CharacterEditorSource, FigureEditorState, FigureSaveResult } from './model-contract.ts';

export type EditorDraft<T = unknown> = { revision: string; catalogFingerprint?: string; profile: T };
type EditorSession = { sourceId: string; revision: string; catalogFingerprint?: string };
type FigureEditor = {
  read(id: string): FigureEditorState | null;
  save(id: string, profile: unknown, expectedRevision?: string): Promise<FigureSaveResult>;
  apply(id: string, revision: string): Promise<FigureSaveResult>;
};

/** The editor window has its own draft and transport. ModelDomain owns committed settings. */
export function createEditorBackend(model: Pick<ReturnType<typeof createModelDomain>, 'editor' | 'save' | 'applySaved' | 'snapshot' | 'previewParameters'>, directory: () => string, touchPolicy?: () => unknown, figures?: FigureEditor) {
  const sessions = new Map<string, EditorSession>();
  const pending = new Map<string, Promise<unknown>>();
  const pathFor = (sourceId: string) => join(directory(), sourceId + '.json');
  function identity(figure: unknown) {
    const session = typeof figure === 'string' ? sessions.get(figure) : undefined;
    if (!session) throw Error('Open the model editor first');
    return session;
  }
  function serialize<T>(sourceId: string, write: () => Promise<T>): Promise<T> {
    const result = (pending.get(sourceId) ?? Promise.resolve()).catch(() => {}).then(write);
    pending.set(sourceId, result);
    const forget = () => { if (pending.get(sourceId) === result) pending.delete(sourceId); };
    void result.then(forget, forget);
    return result;
  }
  async function read(sourceId: string): Promise<EditorDraft | null> {
    await pending.get(sourceId)?.catch(() => {});
    try { return JSON.parse(await readFile(pathFor(sourceId), 'utf8')) as EditorDraft; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  return {
    async invoke(method: string, args: unknown[]): Promise<unknown> {
      const [figure, profile, revision, catalog, operation] = args;
      switch (method) {
        case 'character.open':
        case 'figure.open':
        case 'modelEditor': {
          const result = method !== 'modelEditor' && typeof figure === 'string' ? figures?.read(figure) : null;
          if (result) {
            const { id, sourceId } = result.character;
            sessions.set(id, { sourceId, revision: result.revision });
            return { ...result, draft: await read(sourceId), policy: touchPolicy?.() ?? null };
          }
          if (method === 'figure.open') throw Error('形象包已移出角色库');
          const raw = await model.editor(figure);
          if (!raw.editor) throw Error('Model is unavailable');
          const { sourceId, revision, catalogFingerprint } = raw.editor;
          sessions.set(raw.figure, { sourceId, revision, catalogFingerprint });
          const character: CharacterEditorSource = { id: raw.figure, sourceId, kind: 'live2d-model', tasks: ['framing', 'bindings', 'wardrobe', 'touch', 'behavior', 'mouth'] };
          return { ...raw, character, draft: await read(sourceId), policy: touchPolicy?.() ?? null };
        }
        case 'figure.save':
        case 'character.saveFigure': {
          if (!figures || typeof figure !== 'string' || !figures.read(figure)) throw Error('形象包已移出角色库');
          if (method === 'character.saveFigure' && typeof revision !== 'string') throw Error('Invalid character revision');
          const settings = method === 'figure.save' && profile && typeof profile === 'object' && !Array.isArray(profile)
            ? { scheme: null, touch: null, ...profile } : profile;
          return serialize(figure, async () => {
            const result = await figures.save(figure, settings, typeof revision === 'string' ? revision : undefined);
            sessions.set(figure, { sourceId: figure, revision: result.revision });
            if (method === 'character.saveFigure') await rm(pathFor(figure), { force: true });
            return result;
          });
        }
        case 'character.applyFigure':
          if (!figures || typeof figure !== 'string' || typeof profile !== 'string') throw Error('Invalid character revision');
          return serialize(figure, () => figures.apply(figure, profile));
        case 'edit.previewParameters': {
          const session = identity(figure);
          if (!Array.isArray(profile) || profile.length > 1024 || profile.some(item => !item || typeof item.id !== 'string'
            || item.id.length > 128 || !Array.isArray(item.roles) || item.roles.length > 30
            || item.roles.some((role: unknown) => typeof role !== 'string' || role.length > 128))) throw Error('Invalid model parameter report');
          model.previewParameters(String(figure), session.revision, session.catalogFingerprint, profile);
          return { ready: true };
        }
        case 'edit.updateDraft': {
          const session = identity(figure);
          if (session.revision !== revision || session.catalogFingerprint !== catalog) throw Error('The draft base changed');
          if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Error('Invalid model draft');
          return serialize(session.sourceId, async () => {
            const file = pathFor(session.sourceId), temporary = file + '.' + randomUUID() + '.tmp';
            await mkdir(directory(), { recursive: true });
            try {
              await writeFile(temporary, JSON.stringify({ revision, catalogFingerprint: catalog, profile }), { flag: 'wx' });
              await rename(temporary, file);
            } finally { await rm(temporary, { force: true }); }
            return { retained: true };
          });
        }
        case 'edit.clearDraft': {
          const { sourceId } = identity(figure);
          return serialize(sourceId, async () => { await rm(pathFor(sourceId), { force: true }); return { retained: false }; });
        }
        case 'saveLibraryModel':
        case 'saveModel': {
          const { sourceId } = identity(figure);
          if (typeof figure !== 'string' || typeof revision !== 'string') throw Error('Invalid model revision');
          const status = await model.save(figure, profile, revision, typeof catalog === 'string' ? catalog : undefined, operation, method === 'saveLibraryModel');
          if (status.saved) await serialize(sourceId, () => rm(pathFor(sourceId), { force: true }));
          return status;
        }
        case 'applySavedModel':
          identity(figure);
          return model.applySaved(String(figure), String(profile), revision);
        case 'state': return { model: model.snapshot() };
        case 'edit.touchPolicy': return touchPolicy?.() ?? null;
        default: throw Error('Unknown model editor command');
      }
    },
  };
}
