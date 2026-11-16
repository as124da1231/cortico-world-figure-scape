import { createHash } from 'node:crypto';
import { assertTouchAreaChange } from '../../web/framework/touch-geometry.js';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_MODEL_PROFILE, readModelProfile, writeModelProfile, type ModelProfile } from './model-profile.ts';
import type { ModelEditorState, NativeBinding } from '../framework/model-contract.ts';
// @ts-expect-error Shared wardrobe validator is implemented in JavaScript.
import { wardrobeConfig, wardrobeChannels, wardrobeTracks } from '../../live2d-runtime/pack/backends/wardrobe.js';
// @ts-expect-error Shared native action catalog is implemented in JavaScript.
import { inspectNative, publicCatalog, validateBindings, FACE_WORDS, MOTION_WORDS } from '../../live2d-runtime/tools/native-catalog.mjs';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function createModelProfileStore(modelDirectory: string, sources: string) {
  const readSaved = async (sourceId: string) => {
    try { return readModelProfile(JSON.parse(await readFile(join(sources, sourceId, 'profile.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const editorWithCatalog = async (figure: string): Promise<{ state: ModelEditorState; catalog: any } | null> => {
    if (!/^live2d-[a-f0-9]{16}-[a-f0-9]{8}$/.test(figure)) return null;
    let record;
    try { record = JSON.parse(await readFile(join(modelDirectory, figure, 'source-record.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (record.provider !== 'direct-live2d' || !/^live2d-[a-f0-9]{16}$/.test(record.sourceId) || typeof record.modelFile !== 'string') throw Error('Invalid source record');
    return inspectRecord(record);
  };
  async function inspectRecord(record: { sourceId: string; modelFile: string; catalogFingerprint?: string }) {
    const saved = await readSaved(record.sourceId);
    const catalog = await inspectNative({ kind: 'live2d', dir: dirname(record.modelFile), file: basename(record.modelFile) });
    const exposed = publicCatalog(catalog);
    const state: ModelEditorState = { loadedCatalogFingerprint: record.catalogFingerprint, sourceId: record.sourceId, modelFile: record.modelFile, profile: saved ?? structuredClone(DEFAULT_MODEL_PROFILE), saved: !!saved, revision: saved ? hash(JSON.stringify(saved)) : 'initial',
      catalogFingerprint: catalog.fingerprint, catalog: { fingerprint: catalog.fingerprint, resources: exposed.resources.map((r: any) => { const original = catalog.resources.find((x: any) => x.id === r.id); let wardrobeError = ''; try { wardrobeTracks(original); } catch (error) { wardrobeError = String((error as Error).message); } return { ...r, channels: wardrobeChannels(original), wardrobeError }; }), warnings: catalog.warnings, truncated: catalog.truncated,
        words: { expressions: [...FACE_WORDS], motions: [...MOTION_WORDS] } } };
    return { state, catalog };
  }
  const editor = async (figure: string) => (await editorWithCatalog(figure))?.state ?? null;
  function validateProfile(current: ModelEditorState, catalog: any, value: unknown, expectedCatalogFingerprint?: string) {
    const profile = readModelProfile(value);
    if (profile.mouth === undefined && current.profile.mouth !== undefined) { profile.mouth = current.profile.mouth; profile.catalogFingerprint ??= current.profile.catalogFingerprint; }
    if (profile.crop === undefined && current.profile.crop !== undefined) profile.crop = current.profile.crop;
    if (profile.motion === undefined && current.profile.motion !== undefined) profile.motion = current.profile.motion;
    if (profile.facing === undefined && current.profile.facing !== undefined) profile.facing = current.profile.facing;
    profile.touch ??= current.profile.touch;
    if (profile.touch) assertTouchAreaChange(profile.touch.areas, current.profile.touch?.areas);
    if (profile.touch) for (const rule of profile.touch.rules) {
      const action = rule.action;
      if (action?.word && ![...FACE_WORDS, ...MOTION_WORDS].includes(action.word)) throw Error('Touch rule references an unavailable action');
      if (action?.resource) {
        const binding = { word: 'happy', resource: action.resource, overlays: action.overlays, release:action.release, nativeOnly:false };
        validateBindings(catalog, [binding]);
        wardrobeConfig(catalog, profile.wardrobe ?? [], [...(profile.bindings ?? []).filter(item => item.word !== binding.word), binding]);
      }
    }
    profile.visual ??= current.profile.visual;
    profile.emotionEffect ??= current.profile.emotionEffect;
    profile.emotionEffectSize ??= current.profile.emotionEffectSize;
    if (profile.gaze === undefined && current.profile.gaze !== undefined) profile.gaze = current.profile.gaze;
    // Older fit-only clients cannot silently erase the source's action bindings.
    if (profile.bindings === undefined && current.profile.bindings !== undefined) {
      profile.bindings = current.profile.bindings;
      profile.catalogFingerprint = current.profile.catalogFingerprint;
    }
    if (profile.wardrobe === undefined && current.profile.wardrobe !== undefined) {
      profile.wardrobe = current.profile.wardrobe;
      profile.catalogFingerprint ??= current.profile.catalogFingerprint;
    }
    if (profile.bindings !== undefined || profile.wardrobe !== undefined) {
      const expected = expectedCatalogFingerprint ?? profile.catalogFingerprint;
      if (expected !== catalog.fingerprint) throw Error('Model resources changed; reload the action editor before saving');
      if (profile.bindings !== undefined) profile.bindings = validateBindings(catalog, profile.bindings);
      if (profile.wardrobe !== undefined) profile.wardrobe = wardrobeConfig(catalog, profile.wardrobe, profile.bindings ?? []).groups;
      profile.catalogFingerprint = catalog.fingerprint;
    }
    if (profile.mouth?.mode === 'mapped') {
      if ((expectedCatalogFingerprint ?? profile.catalogFingerprint) !== catalog.fingerprint || current.loadedCatalogFingerprint !== catalog.fingerprint) throw Error('Model resources changed; load the model again before mapping mouth parameters');
      const wardrobe = wardrobeConfig(catalog, profile.wardrobe ?? [], profile.bindings ?? []);
      if (wardrobe.resources.some((r: any) => r.tracks.some((t: any) => t.target === 'Parameter' && profile.mouth!.targets.includes(t.id)))) throw Error('Mouth parameter conflicts with wardrobe ownership');
      profile.catalogFingerprint = catalog.fingerprint;
    }

    return readModelProfile(profile);
  }
  async function inspectSource(file: string) {
    const modelFile = await realpath(file);
    if (!/\.model3\.json$/i.test(modelFile) || !(await stat(modelFile)).isFile()) throw Error('Choose a valid model entry');
    const sourceId = 'live2d-' + hash(process.platform === 'win32' ? modelFile.toLowerCase() : modelFile).slice(0, 16);
    return inspectRecord({ sourceId, modelFile });
  }
  let saving = false;
  async function save(inspect: () => ReturnType<typeof editorWithCatalog>, patch: (profile: ModelProfile) => unknown, revision: string, fingerprint?: string, signal?: AbortSignal) {
    if (saving) throw Error('A profile save is already in progress');
    saving = true;
    try {
      const inspected = await inspect();
      if (!inspected || revision !== inspected.state.revision) throw Error('Profile changed; reload the editor before saving');
      const { state: current, catalog } = inspected;
      if (fingerprint !== undefined && fingerprint !== catalog.fingerprint) throw Error('Model resources changed; reload the editor before saving');
      const normalized = validateProfile(current, catalog, patch(current.profile), fingerprint);
      const sourceDir = join(sources, current.sourceId);
      await mkdir(sourceDir, { recursive: true });
      signal?.throwIfAborted();
      await writeModelProfile(join(sourceDir, 'profile.json'), normalized);
      return { ...current, profile: normalized, saved: true, revision: hash(JSON.stringify(normalized)) };
    } finally { saving = false; }
  }
  return {
    editor, readSaved,
    async source(file: string) { return (await inspectSource(file)).state; },
    async validateProfile(figure: string, value: unknown, expectedRevision: string, expectedCatalogFingerprint?: string) {
      const inspected = await editorWithCatalog(figure);
      if (!inspected || expectedRevision !== inspected.state.revision) throw Error('Profile changed; reload the editor');
      return validateProfile(inspected.state, inspected.catalog, value, expectedCatalogFingerprint);
    },
    saveProfile(figure: string, value: unknown, revision: string, fingerprint?: string) {
      return save(() => editorWithCatalog(figure), () => value, revision, fingerprint);
    },
    saveSourceProfile(file: string, bindings: NativeBinding[], revision: string, fingerprint: string, signal?: AbortSignal) {
      return save(async () => {
        const inspected = await inspectSource(file);
        // This changes bindings only. An existing mouth mapping still belongs to the same catalog.
        inspected.state.loadedCatalogFingerprint = inspected.state.profile.catalogFingerprint;
        return inspected;
      }, (current: ModelProfile) => ({ ...current, bindings }), revision, fingerprint, signal);
    },
  };
}
