import type { ControlLayoutState } from '../web/framework/control-layout.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import { DESKTOP_PET, desktopPetDefinition } from '../src/definition.ts';
import { DESKTOP_PET_DEFAULTS, SELF_DEFAULT, type DesktopPetConfigSection } from '../src/config.ts';
import { DesktopPetWorld, type DesktopPetWorldOptions, type PetBotControls } from '../src/world.ts';
import { chatItem } from '../src/chat.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { FakePage } from './helpers/page.ts';
import { testModel } from './helpers/model.ts';
import { HOST_ENV } from '../src/window-host.ts';
import { petText } from '../src/i18n/index.ts';
import {DEFAULT_MODEL_PROFILE} from '../src/live2d/model-profile.ts';
import type {DirectModelResource,ModelConfiguration} from '../src/framework/model-contract.ts';

const ctx = { role: 'main', log: new FakeHost().log };

function makeWorld(patch: (c: DesktopPetConfigSection) => void = () => {}, extra: Partial<DesktopPetWorldOptions> = {}) {
  const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
  cfg.enabled = true;
  cfg.port = 0;
  cfg.window.enabled = false;
  cfg.asr.enabled = false;
  if (!extra.modelService) cfg.skin.figure = testModel.id;
  patch(cfg);
  const dir = mkdtempSync(join(tmpdir(), 'pet-'));
  const persisted: unknown[] = [];
  const world = new DesktopPetWorld({
    cfg, timezone: 'Asia/Shanghai',
    persist: (p) => { persisted.push(p); Object.assign(cfg, p); },
    runtimesRoot: () => join(dir, 'runtimes'), modelsDir: () => join(dir, 'models'),
    modelService: { provider: 'direct-live2d', modelDirectory: 'fixtures', directModels: () => [testModel],
      prepare: async () => ({ id: testModel.id, sourceId: testModel.sourceId, directory: 'fixtures' }) },
    ...extra,
  });
  return { world, cfg, persisted };
}

const origin = (w: DesktopPetWorld) => w.petUrl.replace(/\/pet$/, '');
const tool = (w: DesktopPetWorld, name: string) => w.tools().find((t) => t.name === name)!;

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function mounted(patch?: (c: DesktopPetConfigSection) => void, extra?: Partial<DesktopPetWorldOptions>) {
  const made = makeWorld(patch, extra);
  const host = new FakeHost();
  await made.world.start(host);
  cleanup.push(() => made.world.stop());
  return { ...made, host };
}

it('keeps configuration and the environment prompt while exposing native tabs and the shared domain adapter',async()=>{
  const {world}=await mounted();const declaration=world.webUi();
  expect(declaration.panels?.map(panel=>panel.id)).toEqual(['framework','sound','desktop','interaction','controls','display','permissions','services']);
  expect(declaration.config?.map(group=>group.id)).toEqual(['world:desktop-live2d-pet','world:desktop-live2d-pet:sound','world:desktop-live2d-pet:asr']);
  expect(declaration.promptDocs?.[0]?.role).toBe('envPrompt');
  expect(await declaration.invoke!('framework','runtime.state',[])).toHaveProperty('skin');
  expect(await declaration.invoke!('framework','voice.state',[])).toHaveProperty('engine');
  expect(await declaration.invoke!('framework','resources',[])).toEqual(expect.arrayContaining([expect.objectContaining({id:testModel.id})]));
  await expect(declaration.invoke!('framework','selectResource',['missing-resource'])).rejects.toThrow('no longer available');
});

it('preselects a wallpaper without entering or closing the current scene', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-wallpaper-'));
  cleanup.push(async () => { rmSync(dir,{recursive:true,force:true}); });
  const file = join(dir,'background.png');
  writeFileSync(file,'wallpaper fixture');
  const {world,cfg} = await mounted(conf => { conf.presentationMode = 'phone'; }, {wallpaperDir:dir});
  const call = (name: string,args: unknown[]) => world.webUi().invoke!('framework',name,args);
  await call('wallpaper.import',[file]);
  const library = await call('wallpaper.state',[]) as {items: {id:string}[]};
  const wallpaper = library.items[0].id;
  await expect(call('wallpaper.choose',[wallpaper,'wallpaper-background']))
    .resolves.toMatchObject({phase:'completed',applied:false,selectionOnly:true});
  expect(cfg.presentationMode).toBe('phone');
  await expect(call('wallpaper.state',[])).resolves.toMatchObject({selected:wallpaper});
  await expect(call('presentation.select',['wallpaper','wallpaper-enter']))
    .resolves.toMatchObject({phase:'completed',applied:false});
  expect(cfg.presentationMode).toBe('wallpaper');
});


it('loads legacy hover ordering, saves a shared control layout, and rejects edits based on a stale revision', async () => {
  const { world, cfg, persisted } = await mounted(cfg => { cfg.hoverButtons = 'voice,chat'; });
  const invoke = world.webUi().invoke!;
  const first = await invoke('framework', 'controls.state', []) as ControlLayoutState;
  expect(first.layout.rail).toEqual(['voice', 'chat', 'menu']);
  const next = structuredClone(first.layout);
  next.pages.home = ['voice', 'chat'];
  next.pages.apps.push('size', 'sound');
  next.rail = ['size', 'chat'];
  next.hoverVisible = false;
  expect(first.layout.panelSize).toEqual({width:304,height:460});
  next.panelSize = {width:376,height:502};
  const saved = await invoke('framework', 'controls.save', [next, first.revision]) as ControlLayoutState;
  expect(saved.layout).toEqual(next);
  expect(cfg.hoverButtons).toBe('size,chat');
  expect(cfg.controlPanelSize).toEqual(next.panelSize);
  const writes = persisted.length;
  await expect(invoke('framework', 'controls.save', [first.layout, first.revision])).rejects.toThrow('重新读取');
  await expect(invoke('framework', 'controls.save', [{ ...next, rail: ['size', 'size'] }, saved.revision])).rejects.toThrow('重复');
  expect(persisted).toHaveLength(writes);
  expect(await invoke('framework', 'controls.state', [])).toEqual(saved);
});

it('publishes changed direct action vocabulary only after the current body confirms the revision',async()=>{
  const word=(id:string):DirectModelResource['actions'][number]=>({id,kind:'motion',names:{en:[id]},about:{en:id},seconds:2});
  const initial:ModelConfiguration={version:1,revision:'a'.repeat(64),fit:DEFAULT_MODEL_PROFILE.fit,gaze:{enabled:true,speed:1},bindings:[],actions:[word('nod')]};
  const next:ModelConfiguration={...initial,revision:'b'.repeat(64),actions:[word('cheer')]};
  let desired=initial;
  const resource:DirectModelResource={version:1,kind:'live2d-model',id:'live2d-old',sourceId:'source',sourceHash:'hash',title:'Test',entry:{id:'live2d-old'},appearance:[],actions:initial.actions!,walk:true,configuration:initial};
  const editor={sourceId:'source',modelFile:'source.model3.json',profile:DEFAULT_MODEL_PROFILE,saved:true,revision:'r1'};
  const prepare=vi.fn();
  const {world,cfg}=await mounted(c=>{c.skin.figure=resource.id;},{modelService:{provider:'direct-live2d',modelDirectory:'owned-models',prepare,
    directModels:()=>[{...resource,actions:desired.actions!,configuration:desired}],editor:async()=>editor,saveProfile:async()=>editor,
    prepareConfiguration:async()=>{desired=next;return next;}}});
  const page=await FakePage.open(origin(world));cleanup.push(()=>page.close());
  page.send({t:'figure',id:resource.id,ok:true,words:['nod'],configuration:initial});
  await vi.waitFor(()=>expect((world as any).bodyVocabulary.get(resource.id)?.map((w:any)=>w.id)).toEqual(['nod']));
  const vocabulary=async()=>((await world.webUi().invoke!('framework','actions',[])) as any).vocabulary.map((w:any)=>w.id);
  await vi.waitFor(async()=>expect(await vocabulary()).toEqual(['nod']));
  const first=world.webUi().invoke!('framework','saveModel',[resource.id,DEFAULT_MODEL_PROFILE,'r1']);const failed=expect(first).rejects.toThrow('rejected');
  const command=await page.next(m=>m.t==='configure-model');expect(await vocabulary()).toEqual(['nod']);
  page.send({t:'model-configuration',request:command.request,id:resource.id,ok:false,reason:'rejected'});await failed;expect(await vocabulary()).toEqual(['nod']);
  const second=world.webUi().invoke!('framework','saveModel',[resource.id,DEFAULT_MODEL_PROFILE,'r1']);const retry=await page.next(m=>m.t==='configure-model');
  page.send({t:'model-configuration',request:retry.request,id:resource.id,ok:true,configurationRevision:next.revision,words:['cheer']});
  expect(await second).toMatchObject({saved:true,applied:true});expect(await vocabulary()).toEqual(['cheer']);expect(cfg.skin.figure).toBe(resource.id);expect(prepare).not.toHaveBeenCalled();
});

/** A local host process receives the launch URL; the test connects its page with that credential. */
async function windowPage(world: DesktopPetWorld): Promise<FakePage> {
  const dir = mkdtempSync(join(tmpdir(), 'pet-window-'));
  const file = join(dir, 'url');
  cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  const previous = process.env[HOST_ENV];
  process.env[HOST_ENV] = JSON.stringify([process.execPath, '-e',
    'require("node:fs").writeFileSync(process.argv[1], process.argv.find(a => a.startsWith("--pet-url=")).slice(10)); setInterval(() => {}, 1000);', '--', file]);
  try { world.openWindow(); } finally {
    if (previous === undefined) delete process.env[HOST_ENV];
    else process.env[HOST_ENV] = previous;
  }
  // writeFileSync makes the file before it writes the URL into it: wait for the URL, not just the file.
  const written = () => existsSync(file) ? readFileSync(file, 'utf8') : '';
  await expect.poll(written, { timeout: 6000 }).not.toBe('');
  const url = new URL(written());
  const key = new URLSearchParams(url.hash.slice(1)).get('key');
  expect(key).toBeTruthy();
  expect(world.petUrl).toBe(`${url.origin}/pet`);
  expect(JSON.stringify(world.petState())).not.toContain(key);
  return FakePage.open(url.origin, new URLSearchParams({ role: 'pet', host: 'window', key: key! }).toString());
}

it('keeps the library empty for first launch and old built-in selections', async () => {
  const { world, cfg } = await mounted(c => { c.skin.figure = 'coo'; }, { modelService: undefined });
  const rpc = world.webUi().invoke!;
  expect(await rpc('framework', 'resources', [])).toEqual([]);
  expect(world.petState()).toMatchObject({ skin: { figure: undefined }, bodyReady: false, previousModelUnavailable: false });
  await expect(rpc('framework', 'runtime.openWindow', [])).rejects.toThrow('导入并选择');
  await expect(rpc('framework', 'selectResource', ['coo'])).rejects.toThrow('no longer available');
  expect(cfg.skin.figure).toBe('coo');
});

it('opens Live2D independently, announces first frame and rejects output once hidden', async () => {
  const { world, host } = await mounted(c => { c.window.enabled = true; });
  const call = (method: string) => world.webUi().invoke!('framework', 'runtime.' + method, []);
  expect(await call('state')).toMatchObject({ window: { phase: 'stopped' }, bodyReady: false });
  await expect(call('selectBody')).rejects.toThrow();
  const page = await windowPage(world);
  cleanup.push(() => page.close());
  page.send({ t: 'figure', id: testModel.id, scheme: 'alternate', ok: true, words: [] });
  const status = async () => JSON.parse((await tool(world, 'live2d_pet_status').handler({}, ctx) as { text: string }).text);
  await expect.poll(status).toMatchObject({ ready: true, visible: true, model: testModel.id, modelName: testModel.title, outfit: '备用' });
  page.send({ t: 'text', text: '现在用哪个身体？' });
  await expect.poll(() => host.events.find(event => event.type === 'desktop-live2d-pet.message')).toMatchObject({
    source: 'desktop-live2d-pet',
    text: '[梦境] [typed] 伙伴:现在用哪个身体？',
    meta: { text: '现在用哪个身体？' },
  });
  const reports = () => host.events.filter(event => event.meta?.body);
  expect(reports()).toMatchObject([{ type: 'desktop-live2d-pet.availability', meta: { body: { scene: 'desktop', figure: testModel.id, name: testModel.title, outfit: '备用' } } }]);
  page.send({ t: 'text', text: '好呀' });
  await expect.poll(() => host.events.at(-1)?.meta?.text).toBe('好呀');
  expect(reports()).toHaveLength(1);
  page.send({ t: 'figure', id: testModel.id, scheme: 'default', ok: true, words: [] });
  await expect.poll(status).toMatchObject({ outfit: '默认' });
  page.send({ t: 'text', text: '换好了？' });
  await expect.poll(() => host.events.at(-1)?.meta?.text).toBe('换好了？');
  expect(reports().map(event => event.meta?.body)).toMatchObject([{ outfit: '备用' }, { outfit: '默认' }]);
  page.send({ t: 'visibility', hidden: true });
  await expect.poll(status).toMatchObject({ ready: false, visible: false, model: null });
  const cues = [{ at: .24, duration: .4, face: 'happy' }];
  expect(await tool(world, 'live2d_pet_say').handler({ script: 'not on the hidden window', cues }, ctx)).not.toMatchObject({ failed: true });
  expect(host.stored.at(-1)).toMatchObject({ type: 'desktop-live2d-pet.self', text: 'not on the hidden window',
    meta: { performance: { figure: testModel.id, cues } } });
  expect(page.messages.some(message => message.t === 'say')).toBe(false);
  expect(host.events.flatMap(event => typeof event.meta?.ready === 'boolean' ? [event.meta.ready] : [])).toEqual([true, false]);
});

describe('direct Live2D models', () => {
  it('does not infer model application from a later connection without a load receipt', async () => {
    const { world } = await mounted(c => { c.skin.figure = 'live2d-old'; }, { modelService: {
      provider: 'direct-live2d', modelDirectory: 'owned-models', hasModel: id => id.startsWith('live2d-'),
      editor: async () => ({ sourceId: 'source', modelFile: 'owned.model3.json', profile: {} as any, saved: false, revision: 'r1' }),
      saveProfile: async () => ({} as any),
      prepare: async () => ({ id: 'live2d-new', sourceId: 'source', directory: 'owned-models/live2d-new' }),
    } });
    vi.spyOn((world as any).server, 'petConnected', 'get').mockReturnValue(true);
    vi.spyOn((world as any).server, 'sendPet').mockReturnValue(false);
    const result = await world.webUi().invoke!('pet', 'saveModelProfile', ['live2d-old', {}, 'r1']);
    expect(result).toMatchObject({ saved: true, applied: false });
  });

  it('saves source profile then applies through the existing safe candidate transaction', async () => {
    const saveProfile=vi.fn(async()=>({sourceId:'source',modelFile:'owned.model3.json',profile:{} as any,saved:true,revision:'r2'}));
    const {world,cfg}=await mounted(c=>{c.skin.figure='live2d-old';},{modelService:{
      provider:'direct-live2d',modelDirectory:'owned-models',hasModel:id=>id.startsWith('live2d-'),
      editor:async()=>({sourceId:'source',modelFile:'owned.model3.json',profile:{} as any,saved:false,revision:'r1'}),
      saveProfile,prepare:async()=>({id:'live2d-new',sourceId:'source',directory:'owned-models/live2d-new'}),
    }});
    const page=await FakePage.open(origin(world));cleanup.push(()=>page.close());
    const saving=world.webUi().invoke!('pet','saveModelProfile',['live2d-old',{version:1},'r1']);
    const load=await page.next(m=>m.t==='load-figure');expect(cfg.skin.figure).toBe('live2d-old');
    expect(saveProfile).toHaveBeenCalledWith('live2d-old',{version:1},'r1');
    page.send({t:'figure',request:load.request,id:'live2d-new',ok:true});
    expect(await saving).toMatchObject({saved:true,applied:true});expect(cfg.skin.figure).toBe('live2d-new');
    await expect(world.webUi().invoke!('pet','saveModelProfile',['live2d-old',{},'r1'])).rejects.toThrow('active model changed');
  });

  it('opens a model using the World’s own direct provider', async () => {
    const prepare = vi.fn(async () => ({ id: 'live2d-owned', sourceId: 'source', directory: 'owned-models/live2d-owned' }));
    const { world, cfg } = await mounted(undefined, {
      modelService: { provider: 'direct-live2d', modelDirectory: 'owned-models', prepare },
    });
    expect(world.petState()).toMatchObject({ modelProvider: 'direct-live2d', canOpenLive2d: true });
    const page = await FakePage.open(origin(world)); cleanup.push(() => page.close());
    const opened = world.webUi().invoke!('pet', 'openDesktopModel', ['owned.model3.json']);
    const load = await page.next(m => m.t === 'load-figure');
    page.send({ t: 'figure', request: load.request, id: 'live2d-owned', ok: true });
    await opened;
    expect(cfg.skin.figure).toBe('live2d-owned'); expect(prepare).toHaveBeenCalledOnce();
  });

  it('waits for a new model and for a same-model reload, keeping the current skin on failure', async () => {
    const { world, cfg } = await mounted(undefined, {
      modelService: { provider: 'direct-live2d', modelDirectory: 'local-models', hasModel: id => id.startsWith('live2d-'),
        async prepare(file) { return { id: file.includes('broken') ? 'live2d-broken' : 'live2d-local', sourceId: 'source', directory: 'local-models' }; },
      },
    });
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const open = (file: string) => world.webUi().invoke!('pet', 'openDesktopModel', [file]);

    const first = open('local.model3.json');
    const load = await page.next(m => m.t === 'load-figure');
    expect(cfg.skin.figure).toBeUndefined();
    page.send({ t: 'figure', request: load.request, id: 'live2d-local', ok: true });
    await first;
    expect(cfg.skin.figure).toBe('live2d-local');

    cfg.skin.scheme = 'dress-a';
    const reopen = open('local.model3.json');
    const reload = await page.next(m => m.t === 'load-figure');
    expect(reload.request).not.toBe(load.request);
    expect(reload.skin).toMatchObject({ figure: 'live2d-local', scheme: 'dress-a' });
    page.send({ t: 'figure', request: reload.request, id: 'live2d-local', ok: true, scheme: 'dress-a' });
    await reopen;

    const failed = expect(open('broken.model3.json')).rejects.toThrow('texture failed');
    const broken = await page.next(m => m.t === 'load-figure');
    page.send({ t: 'figure', request: broken.request, id: 'live2d-broken', ok: false, reason: 'texture failed' });
    await failed;
    expect(cfg.skin).toMatchObject({ figure: 'live2d-local', scheme: 'dress-a' });
  });
});

describe('definition', () => {
  it('loads the bundled figure while leaving both installed figure directories independent', async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'live2d-pet-isolation-'));
    const context = fakeWorldContext(DESKTOP_PET, { scratchDir });
    Object.assign(context.cfg, { enabled: true, port: 0 });
    context.cfg.window.enabled = false;
    context.cfg.skin = { ...context.cfg.skin, figure: 'new-pet', scheme: 'previous' };
    const fixture = new URL('./fixtures/api2-pack/figure.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(fixture, 'utf8'));
    for (const [path, id] of [[['figures', 'old-pet'], 'old-pet'], [['desktop-live2d-pet', 'figures', 'new-pet'], 'new-pet']] as const) {
      const dir = join(context.dataDir, ...path);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'figure.json'), JSON.stringify({ ...manifest, id }));
    }
    const world = DESKTOP_PET.create(context) as DesktopPetWorld;
    try {
      await world.start(new FakeHost());
      expect((await fetch(origin(world) + '/api/figures')).status).toBe(404);
      expect(world.packs().map(pack => ({id:pack.id,builtin:pack.builtin,version:pack.manifest.version}))).toEqual([
        {id:DESKTOP_PET.defaults().skin.figure,builtin:true,version:'1.4.2'},
      ]);
      expect(world.petState()).toMatchObject({ skin: { figure: undefined, scheme: '' }, previousModelUnavailable: true });
      expect(context.cfg.skin).toMatchObject({ figure: 'new-pet', scheme: 'previous' });
      expect(await tool(world, 'live2d_pet_set').handler({ figure: 'new-pet' }, ctx)).toMatchObject({ failed: true });
    } finally {
      await world.stop();
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('passes the extension dry mount', async () => {
    const report = await dryMountWorld(DESKTOP_PET as never, { scratchDir: mkdtempSync(join(tmpdir(), 'pet-dry-')), packageDir: fileURLToPath(new URL('../', import.meta.url)), hasWebUiClient: true });
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});

describe('English model text', () => {
  const HAN = /\p{Script=Han}/u;

  it('gives the bot no Chinese of its own: environment prompt, tool declarations, events', async () => {
    const { world, host } = await mounted((c) => { c.user = 'Sam'; }, { modelLanguage: () => 'en', replyLanguage: () => 'Japanese', controls: { openChat: () => {} } });
    const doc = world.webUi().promptDocs![0]!;
    const prompt = renderTemplate(readFileSync(doc.path, 'utf8'), await world.envPromptVars());
    expect(prompt).not.toMatch(HAN);
    // every placeholder of the English template is one the World fills
    expect(prompt).not.toMatch(/\{\{/);
    expect(prompt).toContain('Japanese');
    expect(JSON.stringify(world.tools().map(({ handler: _, ...decl }) => decl))).not.toMatch(HAN);
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    await tool(world, 'live2d_pet_ask').handler({ question: 'Tea?', options: ['yes'] }, ctx);
    page.send({ t: 'answer', askId: (await page.next((m) => m.t === 'ask')).id, index: 0 });
    page.send({ t: 'touch', kind: 'poke' });
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(2);
    for (const [i, e] of host.events.entries()) expect(host.stamps[i] + e.text).not.toMatch(HAN);
  });
});

describe('tools without a page', () => {
  async function deliveredChat(world: DesktopPetWorld, host: FakeHost) {
    const event = await host.pushEvent({ type: 'desktop-live2d-pet.message', source: world.id, ts: new Date().toISOString(),
      text: '测试', meta: { text: '测试', via: 'chat' } });
    world.onRunPhase({ state: 'delivering', running: [], enteredAt: event.ts });
    world.onEventsSettled([event], 'delivered');
  }
  function finishWithText(world: DesktopPetWorld, text: string, endTurn = false) {
    const tap = world.outputTap();
    tap.onEvent({ type: 'response.completed', response: { output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      ...(endTurn ? [{ type: 'function_call', name: 'end_turn' }] : []),
    ] } } as Parameters<typeof tap.onEvent>[0]);
    tap.onRoundEnd?.();
    world.onTurnEnded();
  }
  it('captures final assistant text for a delivered chat with no speech tool', async () => {
    const { world, host } = await mounted();
    await deliveredChat(world, host);
    finishWithText(world, '【原样】普通正文');
    await expect.poll(() => host.stored.filter(event => event.meta?.kind === 'say').map(event => event.text))
      .toEqual(['【原样】普通正文']);
  });
  it('keeps a final reply when the model also calls end_turn', async () => {
    const { world, host } = await mounted();
    await deliveredChat(world, host);
    finishWithText(world, '工具回合的最终回复', true);
    await expect.poll(() => host.stored.filter(event => event.meta?.kind === 'say').map(event => event.text))
      .toEqual(['工具回合的最终回复']);
  });
  it('retains a scene reply when it shares an action round followed by a tool-only round', async () => {
    const {world,host} = await mounted();
    await deliveredChat(world,host);
    const tap = world.outputTap();
    tap.onEvent({type:'response.completed',response:{output:[
      {type:'message',role:'assistant',content:[{type:'output_text',text:'我现在去公园。'}]},
      {type:'function_call',name:'cabin_go'},
    ]}} as Parameters<typeof tap.onEvent>[0]);
    tap.onRoundEnd?.();
    tap.onEvent({type:'response.created'} as Parameters<typeof tap.onEvent>[0]);
    tap.onEvent({type:'response.completed',response:{output:[{type:'function_call',name:'end_turn'}]}} as Parameters<typeof tap.onEvent>[0]);
    tap.onRoundEnd?.();
    world.onTurnEnded();
    await expect.poll(() => host.stored.filter(event => event.meta?.kind === 'say').map(event => event.text))
      .toEqual(['我现在去公园。']);
  });
  it('retains the original speech text if the original window produced no chat record', async () => {
    const {world,host} = await mounted();
    await deliveredChat(world,host);
    const tap = world.outputTap();
    tap.onEvent({type:'response.completed',response:{output:[
      {type:'function_call',name:'pet_say',arguments:JSON.stringify({script:'【开心】这条应当出现在对话里。'})},
    ]}} as Parameters<typeof tap.onEvent>[0]);
    tap.onRoundEnd?.();
    world.onTurnEnded();
    await expect.poll(() => host.stored.filter(event => event.meta?.kind === 'say').map(event => event.text))
      .toEqual(['这条应当出现在对话里。']);
  });
  it('records a Cabin message once and returns it with the scene reply', async () => {
    const {world,host} = await mounted();
    const cabin = (world as unknown as {cabinWorld:{state():{phase:string;actor:string;presented?:boolean}}}).cabinWorld;
    const handoff = {phase:'active',actor:'figure-scape-test',presented:false,residents:[{key:'figure-scape-test',name:'Coo · 重刀断岳'}]};
    const state = vi.spyOn(cabin,'state').mockReturnValue(handoff);
    try {
      const panel = world.webUi().invoke!;
      await expect(panel('framework','cabin.sendMessage',['req-1','去公园'])).rejects.toThrow('尚未就绪');
      expect(host.events.filter(event => event.meta?.scene === 'cabin-world')).toHaveLength(0);
      handoff.presented = true;
      const first = await panel('framework','cabin.sendMessage',['req-1','去公园']);
      const retry = await panel('framework','cabin.sendMessage',['req-1','去公园']);
      expect(retry).toEqual(first);
      expect(host.events.filter(event => event.meta?.scene === 'cabin-world')).toHaveLength(1);
      expect(host.events.at(-1)).toMatchObject({
        text: '[梦境] [typed] 伙伴:去公园',
        meta: { actor:'figure-scape-test', text:'去公园' },
      });
      expect(host.events.find(event => event.meta?.body)).toMatchObject({
        meta: { body: { scene:'cabin-world', actor:'figure-scape-test', name:'Coo · 重刀断岳' } },
      });
      await tool(world,'live2d_pet_say').handler({script:'我准备好了。'},ctx);
      expect(await panel('framework','cabin.conversation',[])).toMatchObject({messages:[
        {side:'user',text:'去公园'},{side:'pet',text:'我准备好了。'},
      ]});
    } finally { state.mockRestore(); }
  });
  it('skips final text after explicit speech and after a newer original-body input', async () => {
    const { world, host } = await mounted();
    await deliveredChat(world, host);
    await tool(world, 'live2d_pet_say').handler({ script: '显式回复' }, ctx);
    finishWithText(world, '重复的尾声');
    await deliveredChat(world, host);
    await host.pushEvent({ type: 'desktop-pet.self', source: 'desktop-pet', ts: new Date().toISOString(), text: '',
      meta: { kind: 'conversation-input', cursor: host.store.latestCursor() + 1 } }, { deliver: false });
    finishWithText(world, '原版负责回复');
    expect(host.stored.filter(event => event.meta?.kind === 'say').map(event => event.text)).toEqual(['显式回复']);
  });
  it('keeps a message delivered from the original pet bubble on the original body', async () => {
    const { world, host } = await mounted();
    const input = await host.pushEvent({ type: 'desktop-pet.message', source: 'desktop-pet', ts: new Date().toISOString(),
      text: '你好', meta: { via: 'bubble', text: '你好' } });
    world.onRunPhase({ state: 'delivering', running: [], enteredAt: input.ts });
    await host.pushEvent({ type: 'desktop-pet.self', source: 'desktop-pet', ts: input.ts,
      text: '', meta: { kind: 'delivered', cursors: [input.cursor] } }, { deliver: false });
    await expect(tool(world, 'live2d_pet_say').handler({ script: '你好' }, { ...ctx, round: 1 }))
      .resolves.toMatchObject({ failed: true, text: expect.stringContaining('请用 pet_say') });
    expect(host.stored.filter(event => event.meta?.kind === 'say')).toHaveLength(0);
  });
  it('commits text once with the window closed while body-only commands still need it', async () => {
    const { world, host } = await mounted();
    const chat = chatSocket(world);
    chat.send({ t: 'hello' });
    const out = await tool(world, 'live2d_pet_say').handler({ script: '你好' }, ctx);
    expect(out).not.toMatchObject({ failed: true });
    expect(out).toMatchObject({ text: expect.stringContaining('回复已写入') });
    expect(host.stored.filter(event => event.meta?.kind === 'say')).toHaveLength(1);
    expect(chat.last('item')).toMatchObject({ item: { kind: 'say', beats: [{ text: '你好' }] } });
    expect(await tool(world, 'live2d_pet_say').handler({ script: '【开心】' }, ctx)).toMatchObject({ failed: true });
    expect(host.stored.filter(event => event.meta?.kind === 'say')).toHaveLength(1);
  });
  it('returns a failure when the conversation cannot save', async () => {
    const { world, host } = await mounted();
    vi.spyOn(host, 'pushEvent').mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await tool(world, 'live2d_pet_say').handler({ script: '你好' }, ctx)).toMatchObject({ failed: true });
  });
});

it('does not expose computer-use tools from an old Live2D configuration', async () => {
  const { world } = await mounted(c => { Object.assign(c, { cua: { enabled: true } }); });
  expect(world.tools().some(entry => entry.name.startsWith('live2d_pet_cua_'))).toBe(false);
});

describe('with a pet page', () => {
  it('sends the status from the run phase and tool calls, restores it in init and keeps it out of prefs changes', async () => {
    const { world, cfg } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    expect(page.init).toMatchObject({ status: null, statusBubble: true });
    world.onRunPhase({ state: 'model', round: 1, running: [], enteredAt: new Date().toISOString() });
    world.outputTap()!.onEvent({
      type: 'response.output_item.added', sequence_number: 1, output_index: 0,
      item: { type: 'function_call', id: 'a', call_id: 'a', name: 'read_file', arguments: '', status: 'in_progress' },
    });
    expect(await page.next((m) => m.t === 'status' && (m.status as { kind: string })?.kind === 'work')).toEqual({ t: 'status', status: { kind: 'work', text: '在忙' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(page.messages.some((m) => m.t === 'prefs')).toBe(false);
    cfg.statusBubble = false;
    expect(await page.next((m) => m.t === 'prefs')).toMatchObject({ statusBubble: false, status: { kind: 'work', text: '在忙' } });
    const next = await FakePage.open(origin(world));
    cleanup.push(() => next.close());
    expect(next.init).toMatchObject({ statusBubble: false, status: { kind: 'work', text: '在忙' } });
    world.onRunPhase({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
    expect(await next.next((m) => m.t === 'status')).toEqual({ t: 'status', status: null });
  });

  it('live2d_pet_say sends parsed beats and reports dropped markers', async () => {
    const { world } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const out = await tool(world, 'live2d_pet_say').handler({ script: '【开心,飞】你好<眨眼>呀' }, ctx) as { text: string };
    const say = await page.next((m) => m.t === 'say');
    expect(say.beats).toEqual([{ actions: ['happy'], text: '你好呀', anchors: [{ at: 2, actions: ['wink'] }] }]);
    expect(out.text).toContain('飞');
  });

  it('live2d_pet_ask delivers the chosen option as an answer event that wakes', async () => {
    const { world, host } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    await tool(world, 'live2d_pet_ask').handler({ question: '喝什么?', options: ['茶', '咖啡', '水', '果汁'] }, ctx);
    const ask = await page.next((m) => m.t === 'ask');
    expect(ask.options).toEqual(['茶', '咖啡', '水']);
    page.send({ t: 'answer', askId: ask.id, index: 1 });
    await expect.poll(() => host.events.length).toBe(1);
    expect(host.events[0]).toMatchObject({ type: 'desktop-live2d-pet.answer', source: 'desktop-live2d-pet', text: expect.stringContaining('[answer] 伙伴回答「喝什么?」:选了第 2 项「咖啡」') });
    expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });
  });

  it('live2d_pet_ask reports a free answer and a dismissal', async () => {
    const { world, host } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    await tool(world, 'live2d_pet_ask').handler({ question: 'A?', options: ['x'] }, ctx);
    const a1 = await page.next((m) => m.t === 'ask');
    page.send({ t: 'answer', askId: a1.id, text: '都不要' });
    await expect.poll(() => host.events.length).toBe(1);
    await tool(world, 'live2d_pet_ask').handler({ question: 'B?', options: ['y'] }, ctx);
    const a2 = await page.next((m) => m.t === 'ask');
    page.send({ t: 'answer', askId: a2.id, dismissed: true });
    await expect.poll(() => host.events.length).toBe(2);
    expect(host.events.map((e) => e.text)).toEqual([expect.stringContaining('[answer] 伙伴回答「A?」:自己写了:「都不要」'), expect.stringContaining('[answer] 伙伴关掉了提问「B?」,没有作答。')]);
  });

  it('an answer to a replaced question is ignored', async () => {
    const { world, host } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    await tool(world, 'live2d_pet_ask').handler({ question: 'old?', options: ['x'] }, ctx);
    const old = await page.next((m) => m.t === 'ask');
    const out = await tool(world, 'live2d_pet_say').handler({ script: '算了' }, ctx) as { text: string };
    expect(out.text).toContain('替换了还没回答的提问「old?」');
    page.send({ t: 'answer', askId: old.id, index: 0 });
    page.send({ t: 'text', text: 'ping' });
    await expect.poll(() => host.events.length).toBe(1);
    expect(host.events[0].type).toBe('desktop-live2d-pet.message');
  });

  it('live2d_pet_move_to waits for the page to report arrival or interruption', async () => {
    const { world } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const arriving = tool(world, 'live2d_pet_move_to').handler({ to: 'right', run: true }, ctx);
    const walk = await page.next((m) => m.t === 'walk');
    expect(walk).toMatchObject({ to: .95, run: true });
    page.send({ t: 'arrived', walkId: walk.id, x: .95 });
    expect(await arriving).toEqual({ text: '走到了屏幕横向 95% 处。' });

    const interrupted = tool(world, 'live2d_pet_move_to').handler({ to: .1 }, ctx);
    const w2 = await page.next((m) => m.t === 'walk');
    page.send({ t: 'interrupted', walkId: w2.id, x: .4, by: 'drag' });
    expect(await interrupted).toEqual({ text: '没走到:走到 40% 处时被伙伴拎起来了。' });

    // a body that stands off the floor says how far down it got
    const high = tool(world, 'live2d_pet_move_to').handler({ to: .2 }, ctx);
    const w3 = await page.next((m) => m.t === 'walk');
    page.send({ t: 'arrived', walkId: w3.id, x: .2, y: .4 });
    expect(await high).toEqual({ text: '走到了屏幕横向 20%,纵向 40% 处。' });
  });

  it('live2d_pet_move_to rejects a target it cannot read', async () => {
    const { world } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    expect(await tool(world, 'live2d_pet_move_to').handler({ to: 'moon' }, ctx)).toMatchObject({ failed: true });
  });

  it('live2d_pet_act forwards known actions', async () => {
    const { world } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const out = await tool(world, 'live2d_pet_act').handler({ actions: ['跳', 'happy', 'sit', 'fly'] }, ctx) as { text: string };
    expect((await page.next((m) => m.t === 'act')).actions).toEqual(['jump', 'happy', 'sit']);
    expect(out.text).toContain('sit 会一直保持到下一个动作');
    expect(out.text).toContain('fly');
  });

  it('tells the bot how its words changed on a switch, without the words the new body says it does not know', async () => {
    const { world, host } = await mounted(undefined, { modelService: {
      provider: 'direct-live2d', modelDirectory: 'models',
      directModels: () => [{ version: 1, kind: 'live2d-model', id: 'robot', sourceId: 'source', sourceHash: '', title: '机器人',
        entry: { id: 'robot' }, appearance: [], actions: [
        { id: 'sit', kind: 'motion', names: { zh: ['坐下'] }, about: { zh: '折起腿' }, seconds: 1 },
        { id: 'beep', kind: 'motion', names: { zh: ['哔哔'] }, about: { zh: '哔一声' }, seconds: 1 },
      ], walk: true }],
      editor: async () => ({ sourceId: 'source', modelFile: 'robot.model3.json', profile: {} as any, saved: false, revision: 'r1' }),
      prepare: async () => ({ id: 'robot', sourceId: 'source', directory: 'models/robot' }),
    } });
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const switching = tool(world, 'live2d_pet_set').handler({ figure: 'robot' }, ctx);
    const load = await page.next(m => m.t === 'load-figure');
    page.send({ t: 'figure', request: load.request, id: 'robot', ok: true, words: ['sit'] });
    const receipt = (await switching as { text: string }).text;
    expect(receipt).not.toContain('happy(开心)');
    expect(receipt).toContain('| sit | 坐下 | 折起腿 |');
    expect(receipt).not.toContain('| beep |');
    expect(host.events).toHaveLength(0);
    expect(await tool(world, 'live2d_pet_act').handler({ actions: ['哔哔'] }, ctx)).toMatchObject({ failed: true });
  });

  it('merges repeated pokes into one touch event', async () => {
    const { world, host } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    for (let i = 0; i < 3; i++) page.send({ t: 'touch', kind: 'poke' });
    await expect.poll(() => host.events.length, { timeout: 6000 }).toBe(1);
    expect(host.events[0]).toMatchObject({ type: 'desktop-live2d-pet.touch', text: expect.stringContaining('[touch] 伙伴戳了你 3 下') });
    expect(host.pushOpts[0]).toEqual({ trigger: 'debounce' });
  });

  it('batches touches by region and reports the body part to Coo', async () => {
    const { world, host } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    page.send({ t:'figure', id:testModel.id, ok:true, configuration:{
      version:1, revision:'a'.repeat(64), fit:DEFAULT_MODEL_PROFILE.fit, gaze:{enabled:true,speed:1},
      touch:{areas:[], rules:[], areaNotes:{head:'刘海和头顶'}},
    } });
    page.send({ t: 'touch', kind: 'poke', region: 'head' });
    page.send({ t: 'touch', kind: 'poke', region: 'head' });
    page.send({ t: 'touch', kind: 'pet', region: 'body' });
    page.send({ t: 'touch', kind: 'pet', region: 'legs' });
    page.send({ t: 'touch', kind: 'pet', region: 'unsupported' });
    await expect.poll(() => host.events.length, { timeout: 6000 }).toBe(4);
    expect(host.events).toMatchObject([
      { text: expect.stringContaining('[touch] 伙伴戳了你的头部 2 下 (刘海和头顶)'), meta: { touch: { region: 'head', count: 2, areaNote:'刘海和头顶' } } },
      { text: expect.stringContaining('[touch] 伙伴摸了摸你的躯干'), meta: { touch: { region: 'body', count: 1 } } },
      { text: expect.stringContaining('[touch] 伙伴摸了摸你的腿部'), meta: { touch: { region: 'legs', count: 1 } } },
      { text: expect.stringContaining('[touch] 伙伴摸了摸你'), meta: { touch: { kind: 'pet', count: 1 } } },
    ]);
    expect(host.events[3].meta?.touch).not.toHaveProperty('region');
  });

  it('petting and a drop wait for the next wake; a poke wakes once until a turn ends', async () => {
    const { world, host } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    page.send({ t: 'touch', kind: 'pet' });
    page.send({ t: 'touch', kind: 'grab' });
    page.send({ t: 'touch', kind: 'drop', x: 300 });
    page.send({ t: 'touch', kind: 'poke' });
    await expect.poll(() => host.events.length, { timeout: 6000 }).toBe(3);
    page.send({ t: 'touch', kind: 'poke' });
    await expect.poll(() => host.events.length, { timeout: 6000 }).toBe(4);
    world.onTurnEnded();
    page.send({ t: 'touch', kind: 'poke' });
    await expect.poll(() => host.events.length, { timeout: 6000 }).toBe(5);
    expect(host.pushOpts.map((o) => o?.trigger)).toEqual(['piggyback', 'piggyback', 'debounce', 'piggyback', 'debounce']);
  });

  it('reports a throw that ends in a crash as one event', async () => {
    const { world, host } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    page.send({ t: 'touch', kind: 'grab' });
    page.send({ t: 'touch', kind: 'throw', x: 300 });
    page.send({ t: 'touch', kind: 'crash' });
    await expect.poll(() => host.events.length, { timeout: 6000 }).toBe(1);
    expect(host.events[0].text).toContain('[touch] 伙伴把你拎起来甩了出去,你重重落地,摔晕了一会儿');
  });

  it('sends no touch events when touch reporting is off', async () => {
    const { world, host } = await mounted((c) => { c.touch.enabled = false; });
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    page.send({ t: 'touch', kind: 'poke' });
    page.send({ t: 'text', text: 'hi' });
    await expect.poll(() => host.events.length).toBe(1);
    await new Promise((r) => setTimeout(r, 2800));
    expect(host.events.map((e) => e.type)).toEqual(['desktop-live2d-pet.message']);
  });

  it('rejects an installed pack via the legacy skin route', async () => {
    const { world, cfg } = await mounted();
    const change = await fetch(origin(world) + '/api/skin', {
      method: 'POST', body: JSON.stringify({ skin: { ...cfg.skin, figure: 'whale' } }),
    });
    expect(change.status).toBe(409);
    expect(cfg.skin.figure).toBe(testModel.id);
  });

  it('an imported model’s saved outfit is persisted and pushed to the pet', async () => {
    const { world, persisted } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const skin = { ...DESKTOP_PET_DEFAULTS.skin, figure: testModel.id, scheme: 'alternate' };
    const res = await fetch(`${origin(world)}/api/skin`, { method: 'POST', body: JSON.stringify({ skin }) });
    expect(res.status).toBe(200);
    expect(persisted).toContainEqual({ skin });
    expect((await page.next((m) => m.t === 'prefs')).skin).toEqual(skin);
  });

  it('the position the page reports is written once, on stop, and the next run starts there', async () => {
    const made = await mounted((c) => { c.rememberPosition = true; });
    const page = await FakePage.open(origin(made.world));
    page.send({ t: 'position', x: 0.3 });
    page.send({ t: 'position', x: 'left' });
    page.send({ t: 'position', x: 0.6 });
    page.send({ t: 'text', text: 'ping' });
    await expect.poll(() => made.host.events.length).toBe(1);
    expect(made.persisted).toEqual([]);
    await page.close();
    await made.world.stop();
    expect(made.persisted).toEqual([{ petX: 0.6 }]);

    const again = await mounted((c) => { c.rememberPosition = true; c.petX = 0.6; });
    const next = await FakePage.open(origin(again.world));
    expect(next.init.startX).toBe(0.6);
    await next.close();
    await again.world.stop();
    expect(again.persisted).toEqual([]);
  });

  it('a body standing off the floor has its height saved with its position and handed back; a body on the floor clears it', async () => {
    const made = await mounted((c) => { c.rememberPosition = true; });
    const page = await FakePage.open(origin(made.world));
    page.send({ t: 'position', x: 0.3, y: 0.4 });
    page.send({ t: 'text', text: 'ping' });
    await expect.poll(() => made.host.events.length).toBe(1);
    await page.close();
    await made.world.stop();
    expect(made.persisted).toEqual([{ petX: 0.3, petY: 0.4 }]);

    const again = await mounted((c) => { c.rememberPosition = true; c.petX = 0.3; c.petY = 0.4; });
    const next = await FakePage.open(origin(again.world));
    expect(next.init).toMatchObject({ startX: 0.3, startY: 0.4 });
    next.send({ t: 'position', x: 0.5 });
    next.send({ t: 'text', text: 'ping' });
    await expect.poll(() => again.host.events.length).toBe(1);
    await next.close();
    await again.world.stop();
    expect(again.persisted).toEqual([{ petX: 0.5, petY: null }]);
  });

  it('with rememberPosition off the page gets no start position and a saved one is cleared on stop', async () => {
    const made = await mounted((c) => { c.petX = 0.6; });
    const page = await FakePage.open(origin(made.world));
    expect(page.init.startX).toBeNull();
    await page.close();
    await made.world.stop();
    expect(made.persisted).toEqual([{ petX: null }]);
  });

  it('a browser tab only watches while the pet window is connected', async () => {
    const { world } = await mounted();
    const win = await windowPage(world);
    cleanup.push(() => win.close());
    const tab = await FakePage.open(origin(world), 'role=pet&host=tab');
    cleanup.push(() => tab.close());
    await tab.next((m) => m.t === 'watching');
    await tool(world, 'live2d_pet_act').handler({ actions: ['nod'] }, ctx);
    await win.next((m) => m.t === 'act');
    expect(tab.messages.some((m) => m.t === 'act')).toBe(false);
  });

  it('the window lamp is the window\'s: a browser tab standing in is only mentioned, a window that draws no figure is an error', async () => {
    const { world } = await mounted();
    const c = petText('zh').console;
    const lamp = () => world.webUi().lamps![0]!;
    const tab = await FakePage.open(origin(world), 'role=pet&host=tab');
    cleanup.push(() => tab.close());
    await expect.poll(() => lamp().hint).toBe(c.alsoBrowser(c.notOpen));
    expect(lamp().state).toBe('offline');
    const win = await windowPage(world);
    cleanup.push(() => win.close());
    await expect.poll(() => lamp().state).toBe('online');
    win.send({ t: 'figure', id: testModel.id, ok: false, reason: 'webgl unavailable' });
    await expect.poll(() => lamp().state).toBe('error');
    expect(lamp().hint).toBe(c.noBody('webgl unavailable'));
    win.send({ t: 'figure', id: testModel.id, ok: true });
    await expect.poll(() => lamp().state).toBe('online');
  });

  it('puts the local time before each event, with the date on the first one only', async () => {
    const { world, host } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    page.send({ t: 'text', text: 'a' });
    await expect.poll(() => host.events.length).toBe(1);
    page.send({ t: 'text', text: 'b' });
    await expect.poll(() => host.events.length).toBe(2);
    // a run that crosses midnight between the two dates the second one too
    expect(host.stamps[0]).toMatch(/^\[\d\d-\d\d 周. \d\d:\d\d\] $/);
    expect(host.stamps[1]).toMatch(/^\[\d\d:\d\d\] $/);
  });

  it('a watching tab still sends typed text and a theme switch, which reaches the pet window', async () => {
    const { world, host, persisted } = await mounted();
    const win = await windowPage(world);
    cleanup.push(() => win.close());
    const tab = await FakePage.open(origin(world), 'role=pet&host=tab');
    cleanup.push(() => tab.close());
    await tab.next((m) => m.t === 'watching');
    tab.send({ t: 'text', text: 'hi' });
    await expect.poll(() => host.events.length).toBe(1);
    expect(host.events[0]).toMatchObject({ type: 'desktop-live2d-pet.message', text: expect.stringContaining('[typed] 伙伴:hi') });
    const theme = DESKTOP_PET_DEFAULTS.theme === 'dark' ? 'light' : 'dark';
    tab.send({ t: 'prefs', theme });
    expect((await win.next((m) => m.t === 'prefs')).theme).toBe(theme);
    expect(persisted).toContainEqual({ theme });
    expect((await (await fetch(`${origin(world)}/api/state`)).json()).theme).toBe(theme);
  });

  it('confirm resolves from the bubble without an event to the bot', async () => {
    const { world, host } = await mounted();
    expect(await world.confirm('可以吗?', ['可以', '不行'])).toBe('unavailable');
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const yes = world.confirm('可以吗?', ['可以', '不行']);
    const c1 = await page.next((m) => m.t === 'confirm');
    expect(c1).toMatchObject({ question: '可以吗?', options: ['可以', '不行'] });
    page.send({ t: 'confirmed', id: c1.id, index: 0 });
    expect(await yes).toBe('yes');
    // two choices (computer use's): the second is no
    const no = world.confirm('可以吗?', ['可以', '不行']);
    page.send({ t: 'confirmed', id: (await page.next((m) => m.t === 'confirm')).id, index: 1 });
    expect(await no).toBe('no');
    const closed = world.confirm('再问一次?', ['可以', '不行']);
    page.send({ t: 'confirmed', id: (await page.next((m) => m.t === 'confirm')).id, index: null });
    expect(await closed).toBe('dismissed');
    // hidden from its menu or the tray, the pet is not asked
    const hidden = () => (world as unknown as { petHidden: boolean }).petHidden;
    page.send({ t: 'visibility', hidden: true });
    await expect.poll(hidden).toBe(true);
    expect(await world.confirm('看得见吗?', ['可以', '不行'])).toBe('unavailable');
    page.send({ t: 'visibility', hidden: false });
    await expect.poll(hidden).toBe(false);
    const gone = world.confirm('还在吗?', ['可以', '不行']);
    expect((await page.next((m) => m.t === 'confirm')).question).toBe('还在吗?');
    await page.close();
    expect(await gone).toBe('unavailable');
    expect(host.events).toHaveLength(0);
  });

  it('onDesktopChange: told once each time the pet window comes onto the desktop or leaves it', async () => {
    const told: boolean[] = [];
    const { world } = await mounted(undefined, { onDesktopChange: (on) => { told.push(on); } });
    const win = await windowPage(world);
    await expect.poll(() => told).toEqual([true]);
    win.send({ t: 'visibility', hidden: true });
    await expect.poll(() => told).toEqual([true, false]);
    // the same state again tells nothing
    win.send({ t: 'visibility', hidden: true });
    win.send({ t: 'visibility', hidden: false });
    await expect.poll(() => told).toEqual([true, false, true]);
    await win.close();
    await expect.poll(() => told).toEqual([true, false, true, false]);
  });

  it('confirm waits a minute from when the page shows it, and three minutes in all while it is not shown', async () => {
    const { world } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const confirms = (world as unknown as { confirms: Map<string, { shown: boolean }> }).confirms;
    let settled: string | null = null;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // queued behind lines: the page has not shown it yet
      void world.confirm('可以吗?', ['可以', '不行']).then((r) => { settled = r; });
      const { id } = await page.next((m) => m.t === 'confirm');
      vi.advanceTimersByTime(170_000);
      await Promise.resolve();
      expect(settled).toBeNull();
      page.send({ t: 'confirm-shown', id });
      while (!confirms.get(String(id))?.shown) await new Promise((r) => setImmediate(r));
      vi.advanceTimersByTime(59_000);
      await Promise.resolve();
      expect(settled).toBeNull();
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      expect(settled).toBe('timeout');
      // the page takes the timed-out bubble down, so the lines after it are shown
      await page.next((m) => m.t === 'ask-close' && m.id === id);
      settled = null;
      void world.confirm('还在吗?', ['可以', '不行']).then((r) => { settled = r; });
      await page.next((m) => m.t === 'confirm');
      vi.advanceTimersByTime(180_000);
      await Promise.resolve();
      expect(settled).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('live2d_pet_set: 「以后都可以」 applies the change and stops asking about it, as the bot\'s own change', async () => {
    let botChanges = 0;
    const { world, persisted } = await mounted(undefined, { onBotChange: () => { botChanges++; } });
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const set = tool(world, 'live2d_pet_set').handler({ sound: false }, ctx) as Promise<{ text: string }>;
    const c = await page.next((m) => m.t === 'confirm');
    expect(c.options).toEqual(['可以', '以后都可以', '不用了']);
    page.send({ t: 'confirmed', id: c.id, index: 1 });
    expect((await set).text).toContain('音效(sound)以后不用再问');
    expect(persisted).toContainEqual({ sound: false });
    expect(persisted).toContainEqual({ selfAdjust: 'custom', selfAdjustCustom: { ...SELF_DEFAULT, sound: true } });
    expect(botChanges).toBe(1);
  });

  it('dialog steps resolve from the bubble without an event to the bot', async () => {
    const { world, host } = await mounted();
    expect(await world.dialog({ text: '在吗?' }).answer).toEqual({ unavailable: true });
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());

    const name = world.dialog({ text: '怎么称呼你?', actions: ['思考', '不存在'], step: [1, 5], closable: true, input: { kind: 'text', submit: '好' } });
    const d1 = await page.next((m) => m.t === 'dialog');
    // vocabulary words arrive as ids, unknown ones are left out
    expect(d1).toMatchObject({ text: '怎么称呼你?', actions: ['thinking'], step: [1, 5], closable: true, input: { kind: 'text' } });
    page.send({ t: 'dialog', id: d1.id, text: '小明' });
    expect(await name.answer).toEqual({ text: '小明' });

    const pick = world.dialog({ text: '选一个', input: { kind: 'buttons', options: [{ label: 'A' }, { label: 'B' }] } });
    page.send({ t: 'dialog', id: (await page.next((m) => m.t === 'dialog')).id, index: 1 });
    expect(await pick.answer).toEqual({ index: 1 });

    const closed = world.dialog({ text: '跳过?', closable: true, input: { kind: 'text', submit: '好', alt: '算了' } });
    page.send({ t: 'dialog', id: (await page.next((m) => m.t === 'dialog')).id, closed: true });
    expect(await closed.answer).toEqual({ closed: true });

    const back = world.dialog({ text: '叫什么?', back: '上一步', input: { kind: 'text', submit: '好' } });
    page.send({ t: 'dialog', id: (await page.next((m) => m.t === 'dialog')).id, back: true });
    expect(await back.answer).toEqual({ back: true });

    // a progress step moves with update and ends when the app closes it
    const bar = world.dialog({ text: '下载中', input: { kind: 'progress' } });
    const d4 = await page.next((m) => m.t === 'dialog');
    bar.update({ progress: .5 });
    expect(await page.next((m) => m.t === 'dialog-update')).toMatchObject({ id: d4.id, progress: .5 });
    bar.close();
    expect(await page.next((m) => m.t === 'dialog-close')).toMatchObject({ id: d4.id });
    expect(await bar.answer).toEqual({ done: true });

    const gone = world.dialog({ text: '还在吗?', input: { kind: 'buttons', options: [{ label: '在' }] } });
    await page.next((m) => m.t === 'dialog');
    await page.close();
    expect(await gone.answer).toEqual({ unavailable: true });
    expect(host.events).toHaveLength(0);
  });

  it('the pet panel runs the app\'s introduction when the app lends one', async () => {
    let runs = 0;
    const { world } = await mounted(undefined, { controls: { guide: () => { runs++; } } });
    await world.webUi().invoke!('pet', 'guide', []);
    expect(runs).toBe(1);
    const bare = await mounted();
    await expect(bare.world.webUi().invoke!('pet', 'guide', [])).rejects.toThrow('没有引导');
  });

  it('saves size and hover-button visibility from the real window using the existing preferences', async () => {
    const { world, cfg } = await mounted();
    const win = await windowPage(world);
    cleanup.push(() => win.close());
    const send = (command: string, value: unknown, request: string) => {
      win.send({ t: 'phone-control', command, value, request });
      return win.next(msg => msg.t === 'phone-control-result' && msg.request === request);
    };
    expect(win.init).toMatchObject({ scale: 1, hoverButtonsVisible: true });
    expect(await send('model-size', 1.35, 'bigger')).toMatchObject({ ok: true, result: { scale: 1.35 } });
    expect((await win.next(msg => msg.t === 'prefs' && msg.scale === 1.35)).scale).toBe(1.35);
    expect(await send('model-size', 20, 'invalid')).toMatchObject({ ok: false });
    expect(cfg.window.scale).toBe(1.35);
    const invoke = world.webUi().invoke!;
    expect(await invoke('framework','presentation.setScale',['room',.94375])).toEqual({mode:'room',scale:.94375});
    expect(await send('model-size',{mode:'phone',scale:1.2875},'portrait-size'))
      .toMatchObject({ok:true,result:{mode:'phone',scale:1.2875}});
    expect(await invoke('framework','runtime.state',[])).toMatchObject({
      presentationScales:{desktop:1.35,room:.94375,phone:1.2875,wallpaper:1},
    });
    await expect(invoke('framework','presentation.setScale',['phone',1.6])).rejects.toThrow();
    expect(await send('hover-buttons', false, 'hide-shortcuts')).toMatchObject({ ok: true, result: { visible: false } });
    await win.next(msg => msg.t === 'prefs' && msg.hoverButtonsVisible === false);
    expect(cfg.hoverButtonsVisible).toBe(false);
    expect(cfg.hoverButtons).toBe(DESKTOP_PET_DEFAULTS.hoverButtons);
  });

  it('the menu header carries the bot and its run controls; clicks reach them', async () => {
    const calls: string[] = [];
    let paused = false;
    const controls: PetBotControls = {
      isPaused: () => paused,
      setPaused: (p) => { paused = p; calls.push(p ? 'pause' : 'resume'); },
      openSettings: () => calls.push('settings'),
      quit: () => calls.push('quit'),
      quitLabel: '退出 App',
    };
    const { world } = await mounted(undefined, { botName: () => 'Bot', controls });
    const win = await windowPage(world);
    cleanup.push(() => win.close());
    const tab = await FakePage.open(origin(world), 'role=pet&host=tab');
    cleanup.push(() => tab.close());
    const state = await (await fetch(`${origin(world)}/api/state`)).json() as { bot: Record<string, unknown> };
    expect(state.bot).toMatchObject({
      name: 'Bot', controls: true, buttons: { pause: true, settings: true, dress: false, quit: true }, paused: false, quitLabel: '退出 App',
    });
    win.send({ t: 'control', action: 'pause' });
    expect((await win.next((m) => m.t === 'prefs')).bot).toMatchObject({ paused: true });
    tab.send({ t: 'control', action: 'settings' });
    tab.send({ t: 'control', action: 'quit' });
    await expect.poll(() => calls).toEqual(['pause', 'settings', 'quit']);
  });

  it('the menu header shows only the controls the app lends', async () => {
    const calls: string[] = [];
    const { world } = await mounted(undefined, { botName: () => 'Bot', controls: { openSettings: () => calls.push('settings') } });
    const win = await windowPage(world);
    cleanup.push(() => win.close());
    const state = await (await fetch(`${origin(world)}/api/state`)).json() as { bot: Record<string, unknown> };
    expect(state.bot).toMatchObject({ controls: true, buttons: { pause: false, settings: true, dress: false, quit: false }, paused: null, quitLabel: '', quitPrompt: '' });
    // controls that were not lent are ignored
    win.send({ t: 'control', action: 'pause' });
    win.send({ t: 'control', action: 'quit' });
    win.send({ t: 'control', action: 'settings' });
    await expect.poll(() => calls).toEqual(['settings']);
  });

  it('rejects requests whose Host is not a loopback name', async () => {
    const { world } = await mounted();
    const url = new URL(origin(world));
    const res = await new Promise<number>((done) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port: url.port, path: '/api/state', headers: { host: 'evil.example' } }, (r) => done(r.statusCode ?? 0));
        req.end();
      });
    });
    expect(res).toBe(421);
  });
});

/** A chat page connected to the World's `chat` stream: frames it got, and a way to send one. */
function chatSocket(world: DesktopPetWorld, panel = 'chat') {
  const frames: Array<Record<string, unknown>> = [];
  let receive: (text: string) => void = () => {};
  const socket = {
    open: true,
    send: (d: string) => { frames.push(JSON.parse(d) as Record<string, unknown>); },
    close: () => {},
    onMessage: (cb: (text: string) => void) => { receive = cb; },
    onClose: () => {},
  };
  world.webUi().stream!(panel, socket);
  return { frames, send: (m: Record<string, unknown>) => receive(JSON.stringify(m)), last: (t: string) => frames.filter((f) => f.t === t).at(-1) };
}

describe('chat page', () => {
  it('delivers a desktop bubble reply to the shared workbench stream and preserves it after reconnect', async () => {
    const {world, host} = await mounted();
    const page = await windowPage(world);
    cleanup.push(() => page.close());
    const original = await host.pushEvent({ type:'desktop-pet.message', source:'desktop-pet', ts:new Date().toISOString(),
      text:'原版消息', meta:{ text:'原版消息', via:'chat' } });
    const chat = chatSocket(world, 'framework');
    chat.send({ t:'hello' });
    expect(chat.last('init')?.items).toMatchObject([{ kind:'user', cursor:original.cursor }]);
    page.send({ t:'text', request:'desktop-1', text:'你是谁' });
    const sent = await page.next(frame => frame.t === 'text-result');
    expect(sent).toMatchObject({ request:'desktop-1', ok:true });
    expect(chat.last('item')?.item).toMatchObject({ kind:'user', text:'你是谁', cursor:sent.cursor });
    page.send({ t:'text', request:'desktop-1', text:'你是谁' });
    expect(await page.next(frame => frame.t === 'text-result')).toMatchObject({ ok:true, cursor:sent.cursor });
    expect(host.events.filter(event => event.type === 'desktop-live2d-pet.message')).toHaveLength(1);
    await tool(world, 'live2d_pet_say').handler({ script:'我是重刀 Coo' }, ctx);
    expect(chat.last('item')?.item).toMatchObject({ kind:'say', beats:[{ text:'我是重刀 Coo' }] });
    const reconnected = chatSocket(world, 'framework');
    reconnected.send({ t:'hello' });
    expect(reconnected.last('init')?.items).toMatchObject([{ cursor:original.cursor }, { cursor:sent.cursor }, { kind:'say' }]);
  });

  it.each(['room','wallpaper'] as const)('routes %s messages into the existing Live2D conversation exactly once', async mode => {
    const {world,host} = await mounted(config => { config.presentationMode = mode; });
    const page = await windowPage(world);
    cleanup.push(() => page.close());
    page.send({t:'presentation-result',request:null,mode,figure:testModel.id,ok:true});
    const message = {t:'phone-message',request:'same-scene-message',text:'场景对话',scene:mode};
    page.send({...message,scene:'phone'});
    expect(await page.next(m=>m.t==='phone-message-result')).toMatchObject({ok:false,reason:'unavailable'});
    page.send(message);
    const sent = await page.next(m=>m.t==='phone-message-result');
    expect(sent).toMatchObject({ok:true});
    page.send(message);
    expect(await page.next(m=>m.t==='phone-message-result')).toMatchObject({ok:true,cursor:sent.cursor});
    expect(host.events.filter(event=>event.type==='desktop-live2d-pet.message')).toHaveLength(1);
  });

  it('hydrates and follows the same conversation in the authenticated phone window', async () => {
    const { world, host } = await mounted(c => { c.window.enabled = true; c.presentationMode = 'phone'; });
    const stock = await host.pushEvent({ type: 'desktop-pet.message', source: 'desktop-pet', ts: new Date().toISOString(),
      text: '原版', meta: { text: '原版' } });
    const page = await windowPage(world);
    cleanup.push(() => page.close());
    page.send({ t: 'presentation-result', request: null, mode: 'phone', figure: testModel.id, ok: true });
    const stream = 'phone-history';
    page.send({ t: stream });
    expect(await page.next(m => m.t === stream)).toMatchObject({ replace: true, messages: [
      { cursor: stock.cursor, side: 'user', text: '原版' },
    ] });
    await tool(world, 'live2d_pet_say').handler({ script: 'Live2D 回复' }, ctx);
    const reply = host.stored.find(event => event.meta?.kind === 'say')!;
    expect(await page.next(m => m.t === stream)).toMatchObject({ replace: false, messages: [
      { cursor: reply.cursor, side: 'pet', text: 'Live2D 回复' },
    ] });
  });
  it('retains dialogue across touch-heavy history and includes an image-only message in Cabin', async () => {
    const { world, host } = await mounted();
    const ts = new Date().toISOString();
    const reply = await host.pushEvent({ type:'desktop-pet.self', source:'desktop-pet', ts, text:'较早的回复',
      meta:{ kind:'say', beats:[{ text:'较早的回复' }] } }, { deliver:false });
    const media = await host.pushEvent({ type:'desktop-live2d-pet.message', source:world.id, ts, text:'',
      meta:{ text:'' }, blobs:[{mime:'image/png', bytes:Buffer.from('png'), fallbackText:'[image]'}] }, { deliver:false });
    for (let i = 0; i < 305; i++) {
      await host.pushEvent({ type:'desktop-pet.touch', source:'desktop-pet', ts, text:'原版拖动', meta:{ touch:{ kind:'drop' } } }, { deliver:false });
      await host.pushEvent({ type:'desktop-live2d-pet.touch', source:world.id, ts, text:'梦境拖动', meta:{ touch:{ kind:'drop' } } }, { deliver:false });
    }
    const chat = chatSocket(world, 'framework');
    chat.send({t:'hello'});
    expect(chat.last('init')?.items).toMatchObject([{ cursor:reply.cursor, kind:'say' }, { cursor:media.cursor, kind:'user', images:[{ mime:'image/png' }] }]);
    expect(await world.webUi().invoke!('framework','cabin.conversation',[])).toMatchObject({ messages:[
      { cursor:reply.cursor, side:'pet', text:'较早的回复' }, { cursor:media.cursor, side:'user', text:'[1 张图片]' },
    ] });
  });
  it('reads the original chat by cursor without copying events or exposing peer body controls', async () => {
    const { world, host } = await mounted();
    const stock = (kind: string, text: string, meta: Record<string, unknown>) => host.pushEvent(
      { type: 'desktop-pet.' + kind, source: 'desktop-pet', ts: '2026-11-15T13:00:00Z', text, meta }, { deliver: false },
    );
    const first = await stock('message', '原版输入', { via: 'chat', text: '原版输入' });
    await stock('self', '原版提问', { kind: 'ask', askId: 'native', question: '原版提问' });
    const chat = chatSocket(world);
    chat.send({ t: 'hello' });
    expect(chat.last('init')?.items).toMatchObject([{ kind: 'user', cursor: first.cursor, text: '原版输入' }]);
    const reply = await stock('self', '原版回复', { kind: 'say', beats: [{ text: '原版回复' }] });
    await expect.poll(() => chat.last('item')).toMatchObject({ item: { kind: 'say', cursor: reply.cursor } });
    chat.send({ t: 'more', before: reply.cursor });
    expect(chat.last('older')?.items).toMatchObject([{ cursor: first.cursor }]);
    expect(host.stored.filter(event => event.cursor === reply.cursor)).toHaveLength(1);
  });
  it('a typed message waits on the page until delivered; a withdrawn one leaves the history, the pet\'s lines stay', async () => {
    const { world, host } = await mounted(undefined, { botName: () => 'Coo' });
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const chat = chatSocket(world);

    chat.send({ t: 'send', id: 1, text: '帮我看看这个报错' });
    await expect.poll(() => chat.last('sent')).toMatchObject({ id: 1 });
    const sent = host.events.at(-1)!;
    expect(sent).toMatchObject({ type: 'desktop-live2d-pet.message', text: expect.stringContaining('[typed] 伙伴:帮我看看这个报错'), meta: { via: 'chat' } });
    expect(host.pushOpts.at(-1)).toEqual({ trigger: 'preempt' });
    expect(chat.last('item')).toMatchObject({ pending: true, item: { kind: 'user', cursor: sent.cursor } });
    world.onEventsSettled([sent], 'delivered');
    await expect.poll(() => chat.last('settled')).toEqual({ t: 'settled', cursors: [sent.cursor], outcome: 'delivered' });

    await tool(world, 'live2d_pet_say').handler({ script: '【开心】看到了' }, ctx);
    chat.send({ t: 'send', id: 2, text: '算了不用了' });
    await expect.poll(() => chat.last('sent')).toMatchObject({ id: 2 });
    const second = chat.last('sent')!.cursor as number;
    chat.send({ t: 'withdraw', cursor: second });
    await expect.poll(() => chat.last('withdrawn')).toEqual({ t: 'withdrawn', cursor: second });
    expect(host.withdrawn).toEqual([second]);

    host.withdrawable = false;
    chat.send({ t: 'withdraw', cursor: sent.cursor });
    await expect.poll(() => chat.last('notice')?.cursor).toBe(sent.cursor);
    expect(chat.last('notice')?.text).toBeTruthy();

    chat.send({ t: 'hello' });
    await expect.poll(() => chat.last('init')).toBeDefined();
    expect((chat.last('init')!.items as Array<Record<string, unknown>>).map((i) => i.kind === 'say' ? i.beats : i.text))
      .toEqual(['帮我看看这个报错', [{ text: '看到了', mood: { id: 'happy', zh: '开心' } }]]);
  });

  it('the pet page gets what was sent from the chat page, to show beside Coo, and closes it when it is withdrawn', async () => {
    const { world } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const chat = chatSocket(world);

    chat.send({ t: 'send', id: 1, text: '这张截图里的报错是什么意思', images: [{ mime: 'image/png', base64: Buffer.from('png').toString('base64') }] });
    await expect.poll(() => chat.last('sent')).toMatchObject({ id: 1 });
    const cursor = chat.last('sent')!.cursor as number;
    expect(await page.next((m) => m.t === 'said')).toEqual({ t: 'said', via: 'chat', text: '这张截图里的报错是什么意思', images: 1, cursor });

    chat.send({ t: 'withdraw', cursor });
    expect(await page.next((m) => m.t === 'said-withdrawn')).toEqual({ t: 'said-withdrawn', cursor });
  });

  it('images pasted into the typing box go with its text and with the draft it carries to the chat page; a batch the chat page would refuse sends nothing', async () => {
    const { world, host } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const chat = chatSocket(world);
    const png = { name: 'image.png', mime: 'image/png', base64: Buffer.from('png').toString('base64'), bytes: 3, width: 1, height: 1 };

    page.send({ t: 'text', text: '这是什么', images: [{ mime: 'image/bmp', base64: png.base64 }] });
    page.send({ t: 'text', text: '', images: [png] });
    await expect.poll(() => host.events.length).toBe(1);
    expect(host.events[0]).toMatchObject({ meta: { via: 'bubble', text: '' }, blobs: [{ mime: 'image/png', name: 'image.png' }] });
    expect(chatItem(host.events[0]!)).toMatchObject({ kind: 'user', via: 'bubble', images: [{ mime: 'image/png' }] });

    page.send({ t: 'expand', text: '还有这张', images: [png] });
    await expect.poll(() => chat.last('draft')).toEqual({ t: 'draft', text: '还有这张', images: [png] });
  });

  it('live2d_pet_say images show on the chat page as they were when shown, live and in history', async () => {
    const { world, host } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const chat = chatSocket(world);
    host.mem.set('mem:blobs/cat.png', { bytes: Buffer.from('cat-before'), mime: 'image/png' });
    const shot = host.logBlobs.put(Buffer.from('screen'), 'image/jpeg');

    const out = await tool(world, 'live2d_pet_say').handler({ script: '看这个', images: ['mem:blobs/cat.png', shot] }, ctx);
    expect(out).not.toMatchObject({ failed: true });
    await expect.poll(() => (chat.last('item')?.item as { kind?: string } | undefined)?.kind).toBe('say');
    const refs = ((chat.last('item')!.item as { images: Array<{ ref: string }> }).images).map((i) => i.ref);
    expect(refs.every((r) => r.startsWith('log:'))).toBe(true);

    host.mem.set('mem:blobs/cat.png', { bytes: Buffer.from('cat-after'), mime: 'image/png' });
    chat.send({ t: 'hello' });
    await expect.poll(() => chat.last('init')).toBeDefined();
    const say = (chat.last('init')!.items as Array<{ kind: string; images?: Array<{ ref: string }> }>).find((i) => i.kind === 'say')!;
    expect(say.images!.map((i) => i.ref)).toEqual(refs);
    expect(refs.map((r) => Buffer.from(host.blob(r)!.bytes).toString())).toEqual(['cat-before', 'screen']);
  });

  it('live2d_pet_say with only images needs no pet window; an unreadable or non-image handle stores nothing', async () => {
    const { world, host } = await mounted();
    const shot = host.logBlobs.put(Buffer.from('screen'), 'image/png');
    const notes = host.logBlobs.put(Buffer.from('text'), 'text/plain');

    expect(await tool(world, 'live2d_pet_say').handler({ script: '', images: ['log:00000000deadbeef.png'] }, ctx)).toMatchObject({ failed: true });
    expect(await tool(world, 'live2d_pet_say').handler({ script: '', images: [notes] }, ctx)).toMatchObject({ failed: true });
    expect(host.stored).toHaveLength(0);

    expect(await tool(world, 'live2d_pet_say').handler({ script: '', images: [shot] }, ctx)).not.toMatchObject({ failed: true });
    await expect.poll(() => host.stored.length).toBe(1);
    expect(chatItem(host.stored[0]!)).toMatchObject({ kind: 'say', beats: [], images: [{ mime: 'image/png' }] });
  });

  it('shows the figure and dress switches the person makes, not the ones the bot makes', async () => {
    const { world } = await mounted(undefined, { modelService: {
      provider: 'direct-live2d', modelDirectory: 'models',
      directModels: () => [{ version: 1, kind: 'live2d-model', id: 'robot', sourceId: 'source', sourceHash: '', title: '机器人',
        entry: { id: 'robot' }, appearance: [], actions: [], walk: true }],
      editor: async () => ({ sourceId: 'source', modelFile: 'robot.model3.json', profile: {} as any, saved: false, revision: 'r1' }),
      prepare: async () => ({ id: 'robot', sourceId: 'source', directory: 'models/robot' }),
    } });
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    const chat = chatSocket(world);
    const figures = () => chat.frames.filter((f) => f.t === 'item' && (f.item as { kind: string }).kind === 'figure').map((f) => (f.item as { figure: unknown }).figure);

    page.send({ t: 'figure', id: testModel.id, ok: true });
    const switching = tool(world, 'live2d_pet_set').handler({ figure: 'robot' }, ctx);
    const load = await page.next(m => m.t === 'load-figure');
    page.send({ t: 'figure', request: load.request, id: 'robot', scheme: '', ok: true });
    await switching;
    page.send({ t: 'figure', id: 'robot', scheme: 'b', ok: true });
    page.send({ t: 'figure', id: testModel.id, ok: true });
    page.send({ t: 'figure', id: 'robot', ok: false, reason: 'broken' });
    await expect.poll(figures).toHaveLength(2);
    const robot = { zh: '机器人', en: '机器人', id: 'robot' };
    expect(figures()).toEqual([{ kind: 'dress', name: robot }, { kind: 'failed', name: robot, reason: 'broken' }]);
  });

  it('an interrupt stops live2d_pet_move_to where the pet stands', async () => {
    const { world } = await mounted();
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    expect(tool(world, 'live2d_pet_move_to').interruptible).toBe(true);
    const stop = new AbortController();
    const walking = tool(world, 'live2d_pet_move_to').handler({ to: 'left' }, { ...ctx, signal: stop.signal });
    const walk = await page.next((m) => m.t === 'walk');
    stop.abort();
    expect(await page.next((m) => m.t === 'walk-stop')).toMatchObject({ id: walk.id });
    page.send({ t: 'interrupted', walkId: walk.id, x: .4, by: 'idle' });
    expect(await walking).toEqual({ text: '走到屏幕横向 40% 处停下了。' });
  });
});

describe("the bot's name", () => {
  it('is read at each use: a rename reaches the menu header and an open chat page without a restart', async () => {
    let name = 'Coo';
    const def = desktopPetDefinition({ botName: () => name });
    const wctx = fakeWorldContext(def, { scratchDir: mkdtempSync(join(tmpdir(), 'pet-name-')) });
    Object.assign(wctx.cfg, { enabled: true, port: 0 });
    wctx.cfg.window.enabled = false;
    wctx.cfg.asr.enabled = false;
    const world = def.create(wctx) as DesktopPetWorld;
    await world.start(new FakeHost());
    cleanup.push(() => world.stop());
    const page = await FakePage.open(origin(world));
    cleanup.push(() => page.close());
    expect(page.init.bot).toMatchObject({ name: 'Coo' });
    const chat = chatSocket(world);
    chat.send({ t: 'hello' });
    await expect.poll(() => chat.last('init')?.bot).toBe('Coo');

    name = 'Mochi';
    // throws when no prefs frame with the new name arrives
    await page.next((m) => m.t === 'prefs' && (m.bot as { name?: unknown }).name === 'Mochi');
    await expect.poll(() => chat.last('bot')).toEqual({ t: 'bot', bot: 'Mochi' });
    chat.send({ t: 'hello' });
    await expect.poll(() => chat.last('init')?.bot).toBe('Mochi');
  });
});
