import { DEFAULT_MODEL_PROFILE, readModelProfile } from '../src/live2d/model-profile.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLocalSdk, validSdk } from '../src/live2d/local-sdk.ts';
import { createDirectModelService } from '../src/live2d/direct-model-service.ts';
import { createSdkService } from '../src/live2d/sdk-service.ts';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pet-raw-')); dirs.push(root);
  const model = join(root, 'source'), sdk = join(root, 'sdk');
  await mkdir(model); await mkdir(sdk);
  const moc = Buffer.alloc(64); moc.write('MOC3');
  await writeFile(join(model, 'test.moc3'), moc);
  await writeFile(join(model, 'texture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const file = join(model, 'test.model3.json');
  await writeFile(file, JSON.stringify({Version:3, FileReferences:{Moc:'test.moc3', Textures:['texture.png']}}));
  for (const name of ['live2dcubismcore.min.js', 'framework.js', 'shaders.js']) await writeFile(join(sdk,name), '// test fixture, never executes');
  return { root, model, file, sdk, service: createDirectModelService({ dataDir: root, sdkProvider: async () => sdk }) };
}
describe('owned raw Live2D model adapter', () => {
  it('saves per-source framing across revisions and rejects stale editor writes', async () => {
    const f = await fixture(), signal = new AbortController().signal;
    const first = await f.service.prepare(f.file, signal);
    const editor = await f.service.editor!(first.id); expect(editor?.saved).toBe(false);
    const profile = structuredClone(DEFAULT_MODEL_PROFILE); profile.fit.zoom = 1.17; profile.fit.offset = [.12, -.08];
    const saved = await f.service.saveProfile!(first.id, profile, editor!.revision);
    await expect(f.service.saveProfile!(first.id, profile, editor!.revision)).rejects.toThrow('changed');
    const second = await f.service.prepare(f.file, signal);
    expect((await f.service.editor!(second.id))?.profile).toEqual(profile);
    expect((await f.service.editor!(second.id))?.revision).toEqual(saved.revision);
    const generated = await readFile(join(second.directory,'models',second.id,'profile.js'),'utf8');
    expect(generated).toContain('"zoom":1.17'); expect(generated).toContain('"autoFit":false');
    expect(await f.service.editor!('../outside')).toBeNull();
  }, 30000);
  it('validates profile inputs before renderer compilation', () => {
    const profile=structuredClone(DEFAULT_MODEL_PROFILE);
    expect(readModelProfile(profile)).toEqual(profile);
    for(const value of [NaN,Infinity,0,6]) {profile.fit.zoom=value;expect(()=>readModelProfile(profile)).toThrow();}
  });

  it('builds immutable model data without modifying the original source', async () => {
    const f = await fixture(), signal = new AbortController().signal;
    const before = await readFile(f.file);
    const a = await f.service.prepare(f.file, signal), b = await f.service.prepare(f.file, signal);
    expect(a.id).not.toBe(b.id); expect(a.sourceId).toBe(b.sourceId);
    expect(a.id.length).toBeLessThanOrEqual(32);
    expect(await readdir(a.directory)).not.toContain('figure.json');
    expect(JSON.parse(await readFile(join(a.directory,'model-resource.json'),'utf8')).id).toBe(a.id);
    expect(await readFile(f.file)).toEqual(before);
    expect(await readdir(join(f.root,'desktop-live2d-pet/work'))).toEqual([]);
    expect(f.service.provider).toBe('direct-live2d');
  }, 30000);
  it('rejects cancelled and invalid input without publishing candidates', async () => {
    const f = await fixture(), controller = new AbortController(); controller.abort();
    await expect(f.service.prepare(f.file, controller.signal)).rejects.toThrow();
    await expect(f.service.prepare(join(f.model,'test.moc3'),new AbortController().signal)).rejects.toThrow();
  });
  it('refuses missing/unverified SDK and never overwrites an existing corrupt cache', async () => {
    const f = await fixture(); expect(validSdk([Buffer.from('fake')])).toBe(false);
    await expect(prepareLocalSdk(join(f.root,'new-sdk'),[f.sdk],new AbortController().signal)).rejects.toThrow();
    await expect(prepareLocalSdk(f.sdk,[],new AbortController().signal)).rejects.toThrow();
    expect(await readFile(join(f.sdk,'framework.js'),'utf8')).toBe('// test fixture, never executes');
  });
  it('direct import requires consent when no verified runtime exists', async () => {
    const { root, file } = await fixture();
    const sdk = createSdkService(root);
    const service = createDirectModelService({ dataDir: root, sdkProvider: sdk.prepare, sdkCache: sdk.verifiedCache });
    expect(await sdk.state()).toMatchObject({ local: false, reusable: false, consentAt: null });
    await expect(service.prepare(file, new AbortController().signal)).rejects.toThrow('同意 Live2D');
    expect(await service.runtimeAsset?.('sdk/live2dcubismcore.min.js')).toBeNull();
    expect(await sdk.state()).toMatchObject({ local: false, running: false, consentAt: null });
    expect(service.directModels?.()).toEqual([]);
  });
  it('persists source action bindings and compiles the real native runtime and vocabulary', async () => {
    const f = await fixture(), signal = new AbortController().signal;
    await writeFile(join(f.model, 'wave.motion3.json'), JSON.stringify({ Meta: { Duration: 1, Loop: false }, Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, .5, 15, 0, 1, 0] }] }));
    const first = await f.service.prepare(f.file, signal);
    const edit = (await f.service.editor!(first.id))!;
    const motion = edit.catalog!.resources.find(r => r.kind === 'motion')!;
    expect(motion).toBeDefined(); expect(motion).not.toHaveProperty('raw');
    expect(edit.catalog!.words.motions).toContain('wave');
    const profile = { ...edit.profile, bindings: [{ word: 'wave', resource: motion.id, nativeOnly: true }] };
    const saved = await f.service.saveProfile!(first.id, profile, edit.revision, edit.catalogFingerprint);
    const second = await f.service.prepare(f.file, signal);
    const generated = await readFile(join(second.directory, 'models', second.id, 'profile.js'), 'utf8');
    expect(generated).toContain('"word":"wave"'); expect(generated).toContain('"nativeOnly":true');
    expect(f.service.directModels!().find(model => model.id === second.id)!.actions.some((w: any) => w.id === 'wave')).toBe(true);
    // A legacy framing-only editor cannot erase saved bindings.
    const fitOnly = structuredClone(DEFAULT_MODEL_PROFILE); fitOnly.fit.zoom = 1.2;
    const kept = await f.service.saveProfile!(second.id, fitOnly, saved.revision);
    expect(kept.profile.bindings).toEqual(saved.profile.bindings);
    expect(kept.profile.fit.zoom).toBe(1.2);
    const before = await readFile(join(f.root, 'desktop-live2d-pet', 'sources', first.sourceId, 'profile.json'), 'utf8');
    await writeFile(join(f.model, 'wave.motion3.json'), JSON.stringify({ Meta: { Duration: 2 }, Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 1, 20, 0, 2, 0] }] }));
    await expect(f.service.saveProfile!(second.id, kept.profile, kept.revision, edit.catalogFingerprint)).rejects.toThrow('resources changed');
    await expect(f.service.prepare(f.file, signal)).rejects.toThrow('resources changed');
    expect(await readFile(join(f.root, 'desktop-live2d-pet', 'sources', first.sourceId, 'profile.json'), 'utf8')).toBe(before);
  }, 30000);
  it('rejects unknown binding fields, resources and appearance mappings before saving', async () => {
    const f = await fixture(), signal = new AbortController().signal;
    await writeFile(join(f.model, 'glasses.exp3.json'), JSON.stringify({ Parameters: [{ Id: 'ParamGlasses', Value: 1, Blend: 'Overwrite' }] }));
    const first = await f.service.prepare(f.file, signal), edit = (await f.service.editor!(first.id))!;
    const base = { ...edit.profile, bindings: [{ word: 'happy', resource: edit.catalog!.resources[0].id }] };
    await expect(f.service.saveProfile!(first.id, base, edit.revision, edit.catalogFingerprint)).rejects.toThrow();
    await expect(f.service.saveProfile!(first.id, { ...base, bindings: [{ word: 'happy', resource: 'expr-0000000000000000' }] }, edit.revision, edit.catalogFingerprint)).rejects.toThrow();
    expect(() => readModelProfile({ ...base, bindings: [{ ...base.bindings[0], file: '../other.json' }] })).toThrow('binding');
    expect((await f.service.editor!(first.id))!.saved).toBe(false);
  }, 30000);

});

it('compiles source wardrobe axes and restores defaults, preserving legacy edits', async () => {
  const f = await fixture(), signal = new AbortController().signal;
  await writeFile(join(f.model, 'glasses.exp3.json'), JSON.stringify({ Parameters: [{ Id: 'ParamGlasses', Value: 1, Blend: 'Overwrite' }] }));
  const first = await f.service.prepare(f.file, signal), edit = (await f.service.editor!(first.id))!;
  const resource = edit.catalog!.resources[0];
  expect(resource.channels).toEqual(['Parameter:ParamGlasses']); expect(resource.wardrobeError).toBe('');
  const groups = [{ id: 'lookaccessories', slot: 'accessories' as const, name: 'Accessories', options: [{ id: 'glasses', name: 'Glasses', resource: resource.id }] }];
  const saved = await f.service.saveProfile!(first.id, { ...edit.profile, wardrobe: groups }, edit.revision, edit.catalogFingerprint);
  const kept = await f.service.saveProfile!(first.id, DEFAULT_MODEL_PROFILE, saved.revision);
  expect(kept.profile.wardrobe).toEqual(saved.profile.wardrobe);
  expect(kept.profile.catalogFingerprint).toBe(edit.catalogFingerprint);
  const next = await f.service.prepare(f.file, signal);
  const manifest = f.service.directModels!().find(model => model.id === next.id)!;
  expect(manifest.appearance.map((a: any) => a.id)).toEqual(['lookaccessories']);
  expect(manifest.appearance[0].options.map(o => o.id)).toEqual(['default', 'glasses']);
  const text = await readFile(join(next.directory, 'models', next.id, 'profile.js'), 'utf8');
  const config = JSON.parse(text.match(/^  wardrobe: (.*),$/m)![1]);
  expect(config.axisOffset).toBe(0); expect(config.groups).toHaveLength(1);
  // Exercise the actual shipped state compositor, including clearing its channels.
  // @ts-expect-error Owned Figure ESM renderer.
  const { createWardrobe } = await import('../live2d-runtime/pack/backends/wardrobe.js');
  let value = 0;
  const model = { getParameterDefaultValue: () => 0, getParameterMinimumValue: () => 0, getParameterMaximumValue: () => 1, setParameterValueByIndex: (_: number, v: number) => { value = v; } };
  const runtime = createWardrobe(model, new Map([['ParamGlasses', 0]]), new Map());
  runtime.configure(config); runtime.scheme('glasses'); runtime.apply(); expect(value).toBe(1);
  runtime.scheme('default'); runtime.apply(); expect(value).toBe(0);
  await expect(f.service.saveProfile!(next.id, { ...kept.profile, wardrobe: [...groups, { id: 'other', name: 'Other', custom: true, options: groups[0].options }] }, kept.revision, edit.catalogFingerprint)).rejects.toThrow();
  await expect(f.service.saveProfile!(next.id, { ...kept.profile, wardrobe: [{ ...groups[0], options: [{ id: 'bad', name: 'Bad', resource: 'expr-0000000000000000' }] }] }, kept.revision, edit.catalogFingerprint)).rejects.toThrow();
  await writeFile(join(f.model, 'glasses.exp3.json'), JSON.stringify({ Parameters: [{ Id: 'ParamGlasses', Value: .5, Blend: 'Overwrite' }] }));
  await expect(f.service.prepare(f.file, signal)).rejects.toThrow('resources changed');
}, 30000);

it('rejects wardrobe-action channel conflicts and unknown wardrobe fields', async () => {
  const f = await fixture(), signal = new AbortController().signal;
  await writeFile(join(f.model, 'happy.exp3.json'), JSON.stringify({ Parameters: [{ Id: 'ParamEyeSmile', Value: 1, Blend: 'Overwrite' }] }));
  const first = await f.service.prepare(f.file, signal), edit = (await f.service.editor!(first.id))!;
  const resource = edit.catalog!.resources[0].id;
  const wardrobe = [{ id: 'customlook', name: 'Look', custom: true, options: [{ id: 'on', name: 'On', resource }] }];
  await expect(f.service.saveProfile!(first.id, { ...edit.profile, bindings: [{ word: 'happy', resource }], wardrobe }, edit.revision, edit.catalogFingerprint)).rejects.toThrow();
  expect(() => readModelProfile({ ...edit.profile, wardrobe: [{ ...wardrobe[0], code: 'bad' }] })).toThrow('wardrobe');
  expect((await f.service.editor!(first.id))!.saved).toBe(false);
}, 30000);

it('persists source gaze in real generated profiles and preserves omitted settings', async () => {
  const f = await fixture(), signal = new AbortController().signal;
  const first = await f.service.prepare(f.file, signal), edit = (await f.service.editor!(first.id))!;
  expect(edit.profile.gaze).toBeUndefined();
  const initialText = await readFile(join(first.directory, 'models', first.id, 'profile.js'), 'utf8');
  expect(initialText).not.toMatch(/^  gaze:/m);
  const saved = await f.service.saveProfile!(first.id, { ...edit.profile, gaze: { enabled: false, speed: .25 } }, edit.revision);
  const kept = await f.service.saveProfile!(first.id, DEFAULT_MODEL_PROFILE, saved.revision);
  expect(kept.profile.gaze).toEqual({ enabled: false, speed: .25 });
  const second = await f.service.prepare(f.file, signal);
  expect(await readFile(join(second.directory, 'models', second.id, 'profile.js'), 'utf8')).toContain('gaze: {"enabled":false,"speed":0.25}');
  const reset = await f.service.saveProfile!(second.id, { ...kept.profile, gaze: { enabled: true, speed: 1 } }, kept.revision);
  expect((await f.service.editor!(second.id))!.profile.gaze).toEqual({ enabled: true, speed: 1 });
  expect((await f.service.editor!(second.id))!.revision).toBe(reset.revision);
}, 30000);

it('rejects invalid gaze fields rather than silently clamping saves', () => {
  for (const gaze of [null, { enabled: 1, speed: 1 }, { enabled: true, speed: .24 }, { enabled: true, speed: 2.51 }, { enabled: false, speed: NaN }, { enabled: false, speed: Infinity }, { enabled: true, speed: '1' }, { enabled: true, speed: 1, script: 'no' }]) {
    expect(() => readModelProfile({ ...DEFAULT_MODEL_PROFILE, gaze })).toThrow('gaze');
  }
  expect(readModelProfile({ ...DEFAULT_MODEL_PROFILE, gaze: { enabled: true, speed: 2.5 } }).gaze?.speed).toBe(2.5);
});

it('compiles source movement policy and preserves it across legacy saves', async () => {
  const f = await fixture(), signal = new AbortController().signal;
  const first = await f.service.prepare(f.file, signal), edit = (await f.service.editor!(first.id))!;
  const before = await readFile(join(first.directory, 'models', first.id, 'profile.js'), 'utf8');
  expect(before).toContain('motion: {"kind":"roam","speed":1}');
  const saved = await f.service.saveProfile!(first.id, { ...edit.profile, motion: { kind: 'stand' }, facing: 'fixed' }, edit.revision);
  const kept = await f.service.saveProfile!(first.id, DEFAULT_MODEL_PROFILE, saved.revision);
  expect(kept.profile.motion).toEqual({ kind: 'stand' }); expect(kept.profile.facing).toBe('fixed');
  const second = await f.service.prepare(f.file, signal);
  const generated = await readFile(join(second.directory, 'models', second.id, 'profile.js'), 'utf8');
  expect(generated).toContain('motion: {"kind":"stand","speed":1}'); expect(generated).toContain('facing: "fixed"');
  const changed = await f.service.saveProfile!(second.id, { ...kept.profile, motion: { kind: 'roam' }, facing: 'mirror' }, kept.revision);
  const third = await f.service.prepare(f.file, signal);
  const updated = await readFile(join(third.directory, 'models', third.id, 'profile.js'), 'utf8');
  expect(updated).toContain('motion: {"kind":"roam","speed":1}'); expect(updated).toContain('facing: "mirror"');
  expect((await f.service.editor!(third.id))!.revision).toBe(changed.revision);
}, 30000);

it('rejects unsupported movement policy values and speed setting', () => {
  for (const motion of [null, [], { kind: 'fly' }, { kind: 'stand', speed: 2 }, { kind: 'roam', unknown: true }]) expect(() => readModelProfile({ ...DEFAULT_MODEL_PROFILE, motion })).toThrow('motion');
  for (const facing of [null, false, 'left', { value: 'fixed' }]) expect(() => readModelProfile({ ...DEFAULT_MODEL_PROFILE, facing })).toThrow('facing');
});

it('compiles source crop with real framing axis and wardrobe offset', async () => {
  const f = await fixture(), signal = new AbortController().signal;
  await writeFile(join(f.model, 'glasses.exp3.json'), JSON.stringify({ Parameters: [{ Id: 'ParamGlasses', Value: 1, Blend: 'Overwrite' }] }));
  const first = await f.service.prepare(f.file, signal), edit = (await f.service.editor!(first.id))!;
  const crop = { mode: 'upper' as const, edge: 'round' as const, line: .65, curve: 1.2, feather: .08, transition: .4 };
  const wardrobe = [{ id: 'lookaccessories', slot: 'accessories' as const, name: 'Accessories', options: [{ id: 'glasses', name: 'Glasses', resource: edit.catalog!.resources[0].id }] }];
  const saved = await f.service.saveProfile!(first.id, { ...edit.profile, crop, wardrobe }, edit.revision, edit.catalogFingerprint);
  const kept = await f.service.saveProfile!(first.id, DEFAULT_MODEL_PROFILE, saved.revision);
  expect(kept.profile.crop).toEqual(crop);
  const next = await f.service.prepare(f.file, signal);
  const manifest = f.service.directModels!().find(model => model.id === next.id)!;
  expect(manifest.appearance.map((a: any) => a.id)).toEqual(['lookaccessories','figureframing']);
  expect(manifest.appearance[1].options.map((o: any) => o.id)).toEqual(['figureupperframe','figurefullframe']);
  const generated = await readFile(join(next.directory, 'models', next.id, 'profile.js'), 'utf8');
  expect(JSON.parse(generated.match(/^  crop: (.*),$/m)![1])).toEqual(crop);
  expect(JSON.parse(generated.match(/^  wardrobe: (.*),$/m)![1]).axisOffset).toBe(0);
  await f.service.saveProfile!(next.id, { ...kept.profile, crop: { ...crop, mode: 'full' } }, kept.revision, edit.catalogFingerprint);
  const full = await f.service.prepare(f.file, signal);
  const fullManifest = f.service.directModels!().find(model => model.id === full.id)!;
  expect(fullManifest.appearance.at(-1)!.options[0].id).toBe('figurefullframe');
}, 30000);

it('strictly rejects crop ranges and unknown fields', () => {
  const crop = { mode: 'full', edge: 'flat', line: .6, curve: 1, feather: .05, transition: .24 };
  for (const patch of [{mode:'other'},{edge:'square'},{line:.19},{line:.96},{curve:-1},{curve:2.1},{feather:-.01},{feather:.26},{transition:-1},{transition:1.21},{line:NaN},{extra:true}]) expect(() => readModelProfile({ ...DEFAULT_MODEL_PROFILE, crop: {...crop,...patch} })).toThrow('crop');
});

it('persists mapped mouth with loaded source fingerprint and rejects wardrobe ownership', async () => {
  const f = await fixture(), signal = new AbortController().signal;
  await writeFile(join(f.model, 'happy.exp3.json'), JSON.stringify({ Parameters: [{ Id: 'ParamMouthOpenY', Value: 1, Blend: 'Overwrite' }] }));
  const first = await f.service.prepare(f.file, signal), edit = (await f.service.editor!(first.id))!;
  expect(edit.loadedCatalogFingerprint).toBe(edit.catalogFingerprint);
  const mouth = { mode: 'mapped' as const, targets: ['ParamMouthOpenY'] };
  const saved = await f.service.saveProfile!(first.id, { ...edit.profile, mouth }, edit.revision, edit.catalogFingerprint);
  const kept = await f.service.saveProfile!(first.id, DEFAULT_MODEL_PROFILE, saved.revision);
  expect(kept.profile.mouth).toEqual(mouth);
  const second = await f.service.prepare(f.file, signal);
  expect(await readFile(join(second.directory, 'models', second.id, 'profile.js'), 'utf8')).toContain('mouth: {"mode":"mapped","targets":["ParamMouthOpenY"]}');
  const wardrobe = [{ id: 'customlook', custom: true, name: 'Look', options: [{ id: 'on', name: 'On', resource: edit.catalog!.resources[0].id }] }];
  await expect(f.service.saveProfile!(second.id, { ...kept.profile, wardrobe }, kept.revision, edit.catalogFingerprint)).rejects.toThrow('ownership');
  // Current fingerprint alone is insufficient when the model still loaded older resources.
  await writeFile(join(f.model, 'happy.exp3.json'), JSON.stringify({ Parameters: [{ Id: 'ParamMouthOpenY', Value: .5, Blend: 'Overwrite' }] }));
  const changed = (await f.service.editor!(second.id))!;
  await expect(f.service.saveProfile!(second.id, changed.profile, changed.revision, changed.catalogFingerprint)).rejects.toThrow('load the model again');
  await expect(f.service.prepare(f.file, signal)).rejects.toThrow('resources changed');
  const off = await f.service.saveProfile!(second.id, { ...changed.profile, mouth: { mode: 'off', targets: [] } }, changed.revision);
  const third = await f.service.prepare(f.file, signal);
  expect(await readFile(join(third.directory, 'models', third.id, 'profile.js'), 'utf8')).toContain('mouth: {"mode":"off","targets":[]}');
  expect(off.profile.mouth?.mode).toBe('off');
}, 30000);

it('strictly validates source mouth modes and target grammar', () => {
  for (const mouth of [null, {mode:'other',targets:[]},{mode:'auto',targets:['a']},{mode:'off',targets:['a']},{mode:'mapped',targets:[]},{mode:'mapped',targets:['a','a']},{mode:'mapped',targets:['\n']},{mode:'mapped',targets:['x'.repeat(129)]},{mode:'mapped',targets:Array.from({length:9},(_,i)=>'p'+i)},{mode:'auto',targets:[],extra:true}]) expect(() => readModelProfile({...DEFAULT_MODEL_PROFILE,mouth})).toThrow('mouth');
  expect(readModelProfile({...DEFAULT_MODEL_PROFILE,mouth:{mode:'auto',targets:[]}}).mouth?.mode).toBe('auto');
});
