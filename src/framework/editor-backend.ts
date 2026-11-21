import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { createModelDomain } from './model-domain.ts';
import type { FigureEditorState, FigureSaveResult } from './model-contract.ts';
import { live2dCharacter } from './character-source.ts';

export type EditorDraft<T = unknown> = { revision: string; catalogFingerprint?: string; profile: T };
type StoredDraft = EditorDraft & { version: string };
const versionId = /^[a-f0-9]{64}$|^[a-f0-9-]{36}$/;

export class EditorDraftConflict extends Error {
  constructor() { super('The draft changed in another editor tab.'); }
}
type EditorSession = { sourceId: string; revision: string; catalogFingerprint?: string };
type FigureEditor = {
  read(id: string): FigureEditorState | null;
  save(id: string, profile: unknown, expectedRevision?: string): Promise<FigureSaveResult>;
  apply(id: string, revision: string, applyOutfit?: boolean): Promise<FigureSaveResult>;
};

/** The editor window has its own draft and transport. ModelDomain owns committed settings. */
export function createEditorBackend(model: Pick<ReturnType<typeof createModelDomain>, 'editor' | 'save' | 'applySaved' | 'snapshot' | 'operation' | 'previewParameters'>, directory: () => string, touchPolicy?: () => unknown, figures?: FigureEditor) {
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
  async function read(sourceId: string): Promise<StoredDraft | null> {
    try {
      const raw = await readFile(pathFor(sourceId), 'utf8');
      const value = JSON.parse(raw) as StoredDraft;
      return { ...value, version: value.version ?? createHash('sha256').update(raw).digest('hex') };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async function openDraft(sourceId: string) {
    await pending.get(sourceId)?.catch(() => {});
    const draft = await read(sourceId);
    return { draft, draftVersion: draft?.version ?? null, policy: touchPolicy?.() ?? null };
  }
  function expectVersion(draft: StoredDraft | null, expected: unknown) {
    if ((draft?.version ?? null) !== expected) throw new EditorDraftConflict();
  }
  return {
    async invoke(method: string, args: unknown[]): Promise<unknown> {
      const [figure, profile, revision, catalog, operation, draftVersion] = args;
      switch (method) {
        case 'character.open':
        case 'figure.open':
        case 'modelEditor': {
          const result = method !== 'modelEditor' && typeof figure === 'string' ? figures?.read(figure) : null;
          if (result) {
            const { id, sourceId } = result.character;
            sessions.set(id, { sourceId, revision: result.revision });
            return { ...result, ...await openDraft(sourceId) };
          }
          if (method === 'figure.open') throw Error('形象包已移出角色库');
          const raw = await model.editor(figure);
          if (!raw.editor) throw Error('Model is unavailable');
          const { sourceId, revision, catalogFingerprint } = raw.editor;
          sessions.set(raw.figure, { sourceId, revision, catalogFingerprint });
          const character = live2dCharacter(raw.figure,sourceId);
          return { ...raw, character, ...await openDraft(sourceId) };
        }
        case 'figure.save':
        case 'character.saveFigure': {
          if (!figures || typeof figure !== 'string' || !figures.read(figure)) throw Error('形象包已移出角色库');
          if (method === 'character.saveFigure' && typeof revision !== 'string') throw Error('Invalid character revision');
          const settings = method === 'figure.save' && profile && typeof profile === 'object' && !Array.isArray(profile)
            ? { scheme: null, touch: null, ...profile } : profile;
          return serialize(figure, async () => {
            if (method === 'character.saveFigure') expectVersion(await read(figure), catalog);
            const result = await figures.save(figure, settings, typeof revision === 'string' ? revision : undefined);
            sessions.set(figure, { sourceId: figure, revision: result.revision });
            if (method === 'character.saveFigure') await rm(pathFor(figure), { force: true });
            return { ...result, draftVersion: null };
          });
        }
        case 'edit.draftVersion': {
          const { sourceId } = identity(figure);
          await pending.get(sourceId)?.catch(() => {});
          return { draftVersion: (await read(sourceId))?.version ?? null };
        }
        case 'character.applyFigure':
          if (!figures || typeof figure !== 'string' || typeof profile !== 'string') throw Error('Invalid character revision');
          return serialize(figure, () => figures.apply(figure, profile, revision !== false));
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
          const fingerprint = catalog ?? undefined;
          if (session.revision !== revision || session.catalogFingerprint !== fingerprint) throw Error('The draft base changed');
          if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Error('Invalid model draft');
          if (typeof draftVersion !== 'string' || !versionId.test(draftVersion)) throw Error('Invalid draft write ID');
          return serialize(session.sourceId, async () => {
            if (identity(figure) !== session) {
              const current = identity(figure);
              if (current.revision !== revision || current.catalogFingerprint !== fingerprint) throw Error('The draft base changed');
            }
            const previous = await read(session.sourceId);
            // Retrying after a lost response returns the existing receipt without writing again.
            if (previous?.version === draftVersion && previous.revision === revision && previous.catalogFingerprint === fingerprint
              && JSON.stringify(previous.profile) === JSON.stringify(profile)) return { retained: true, draftVersion };
            expectVersion(previous, operation);
            const file = pathFor(session.sourceId), temporary = file + '.' + randomUUID() + '.tmp';
            await mkdir(directory(), { recursive: true });
            try {
              await writeFile(temporary, JSON.stringify({ revision, catalogFingerprint: fingerprint, profile, version: draftVersion }), { flag: 'wx' });
              await rename(temporary, file);
            } finally { await rm(temporary, { force: true }); }
            return { retained: true, draftVersion };
          });
        }
        case 'edit.clearDraft': {
          const { sourceId } = identity(figure);
          return serialize(sourceId, async () => {
            expectVersion(await read(sourceId), profile);
            await rm(pathFor(sourceId), { force: true });
            return { retained: false, draftVersion: null };
          });
        }
        case 'saveLibraryModel':
        case 'saveModel': {
          const { sourceId } = identity(figure);
          if (typeof figure !== 'string' || typeof revision !== 'string') throw Error('Invalid model revision');
          return serialize(sourceId, async () => {
            const existing = operation === undefined ? null : model.operation(operation);
            if (!existing) expectVersion(await read(sourceId), draftVersion);
            let saved = false;
            try {
              const status = await model.save(figure, profile, revision, typeof catalog === 'string' ? catalog : undefined, operation, method === 'saveLibraryModel');
              saved = !existing && status.saved;
              return status;
            } catch (error) {
              saved = !existing && operation !== undefined && model.operation(operation)?.saved === true;
              throw error;
            } finally {
              if (saved) await rm(pathFor(sourceId), { force: true });
            }
          });
        }
        case 'applySavedModel':
          identity(figure);
          return model.applySaved(String(figure), String(profile), revision);
        case 'operation.get': return model.operation(figure);
        case 'state': return { model: model.snapshot() };
        case 'edit.touchPolicy': return touchPolicy?.() ?? null;
        default: throw Error('Unknown model editor command');
      }
    },
  };
}
