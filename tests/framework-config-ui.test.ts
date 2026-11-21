// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const api=vi.hoisted(()=>({invokePanel:vi.fn(),setConfig:vi.fn(),get:vi.fn(async()=>({groups:[]}))}));
vi.mock('../src/webui/coopanion/base/api.ts',()=>api);
vi.mock('../src/webui/coopanion/base/language.ts',()=>({LANGUAGE:'zh'}));
import { workspacePage } from '../src/webui/coopanion/features/framework/index.ts';
import { mountConversation } from '../src/webui/coopanion/features/framework/conversation-panel.ts';
import { modelServicesPanel } from '../src/webui/coopanion/features/framework/model-services.ts';
import type { PageContext } from '../src/webui/coopanion/base/page.ts';
import type { RuntimeState } from '../src/webui/coopanion/features/framework/runtime.ts';
// @ts-expect-error Native wallpaper view is a browser module.
import { createWallpaperPresentation } from '../web/framework/wallpaper-presentation.js';
// @ts-expect-error The desktop operation panel is a browser module.
import { createControlPhone } from '../web/framework/phone-controls.js';
HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open',''); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});

it('keeps desktop controls inside the panel and leaves its palette to Coo', async () => {
  const controller = new AbortController();
  document.body.innerHTML = '<header class="providerchrome"><div class="providerintro">' +
    '<div class="pagetitle-row"><h1 class="pagetitle">Figure Scape</h1></div></div>' +
    '<nav class="providertabs"><button class="pagetab active">引擎</button></nav></header>' +
    '<div class="panelslot"><div class="desktop-live2d-native-page"></div></div>';
  const chrome = document.querySelector('.providerchrome')!;
  const hostMarkup = chrome.outerHTML;
  const root = document.querySelector<HTMLElement>('.desktop-live2d-native-page')!;
  api.invokePanel.mockImplementation(async (_provider,_panel,method) => {
    if (method === 'runtime.state') return {
      inWindow:false, onDesktop:false, appearance:'blue', skin:{figure:'test'}, framework:{configuration:{}},
      presentation:{desired:'desktop', applied:'desktop', details:{}},
    } as RuntimeState;
    if (method === 'cabin.state') return {phase:'idle', configured:true, bundled:true, residents:[]};
    if (method === 'resources') return [];
    if (method === 'phone.state') return null;
    if (method === 'resources.runtimeState') return null;
    return {};
  });
  const button = (text: string) => {
    const control = document.createElement('button');
    control.textContent = text;
    return control;
  };
  try {
    workspacePage('framework').mount({root,signal:controller.signal,ui:{button},
      lifecycle:{interval:()=>0,add:()=>{}}} as unknown as PageContext);
    const launch = root.querySelector<HTMLButtonElement>('.studio-panel-header .studio-runtime-launch');
    await vi.waitFor(() => expect(launch?.disabled).toBe(false));
    expect(launch?.textContent).toBe('启动桌宠');
    expect(root.dataset.appearance).toBeUndefined();
    expect(root.querySelectorAll('.studio-panel-header button')).toHaveLength(1);
    expect(root.querySelector('dialog[open]')).toBeNull();
    expect(chrome.outerHTML).toBe(hostMarkup);
  } finally { controller.abort(); }
});

it('lets users retry a timed-out model-service read and add a model afterward', async () => {
  const controller = new AbortController();
  const stalledRead = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(stalledRead.signal);
  const protocols = [{ id:'openai-compatible', name:'OpenAI-compatible', uses:['planner'], fields:[] }];
  const providers = [{ id:'provider', protocol:'openai-compatible', name:'Test provider', endpoint:'https://example.test', hasKey:false, fields:{} }];
  const ready = { protocols, providers, models:[], selected:{} };
  api.invokePanel.mockImplementationOnce((_provider, _panel, _method, _args, options) => new Promise((_resolve, reject) => {
    const signal = options.signal as AbortSignal;
    signal.addEventListener('abort', () => reject(signal.reason), { once:true });
  })).mockResolvedValueOnce(ready).mockResolvedValueOnce({
    ...ready, models:[{ id:'new-model', providerId:'provider', model:'test-model', uses:['planner'], tests:{} }],
  });
  const panel = modelServicesPanel({ root:document.body, signal:controller.signal } as PageContext, vi.fn());
  document.body.append(panel.element);
  const button = (text: string) => [...panel.element.querySelectorAll('button')].find(item => item.textContent === text)!;
  try {
    const initial = panel.read();
    expect(button('添加提供商').disabled).toBe(true);
    stalledRead.abort(new DOMException('Timed out', 'TimeoutError'));
    await initial;
    expect(panel.element.textContent).toContain('读取模型服务超时');
    expect(button('重新读取').hidden).toBe(false);
    button('重新读取').click();
    await vi.waitFor(() => expect(button('添加提供商').disabled).toBe(false));
    expect(button('重新读取').hidden).toBe(true);
    button('手动添加').click();
    const form = document.querySelector<HTMLFormElement>('dialog[open] form')!;
    form.querySelector<HTMLInputElement>('[name=model]')!.value = 'test-model';
    form.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
    await vi.waitFor(() => expect(panel.element.textContent).toContain('test-model'));
    expect(document.querySelector('dialog[open]')).toBeNull();
  } finally { timeout.mockRestore(); controller.abort(); }
});

it('shows dialogue while hiding drag activity, keeps the draft on reconnect, and matches the send receipt', () => {
  const abort = new AbortController();
  const sent: Array<{ t: string; id: string }> = [];
  let callbacks!: Parameters<NonNullable<PageContext['stream']>>[0];
  let connected = true;
  const stream: NonNullable<PageContext['stream']> = handlers => {
    callbacks = handlers;
    return { get open() { return connected; }, send: raw => { sent.push(JSON.parse(raw)); }, dispose: () => {} };
  };
  mountConversation({ root: document.body, signal: abort.signal, stream } as unknown as PageContext);
  try {
    const frame = (message: object) => callbacks.message(JSON.stringify(message));
    const user = { kind:'user', cursor:2, text:'你是谁' };
    const recent = [user, { kind:'touch', cursor:1, text:'把桌宠拎走了' }];
    callbacks.open?.();
    expect(sent.at(-1)?.t).toBe('hello');
    frame({ t:'init', items:recent, phase:{ state:'model' } });
    expect(document.querySelector('.studio-conversation-log')?.textContent).toBe('你是谁');
    const waiting = document.querySelector<HTMLElement>('.studio-conversation-waiting')!;
    expect(waiting.hidden).toBe(false);
    const reply = { kind:'say', cursor:3, beats:[{text:'我是重刀 Coo'}] };
    frame({ t:'item', item:reply });
    expect(waiting.hidden).toBe(true);
    expect(document.querySelector('.studio-conversation-log')?.textContent).toBe('你是谁我是重刀 Coo');
    const input = document.querySelector<HTMLTextAreaElement>('.studio-conversation textarea')!;
    const submit = document.querySelector<HTMLButtonElement>('.studio-conversation button[type="submit"]')!;
    input.value = '继续聊';
    input.dispatchEvent(new Event('input'));
    submit.click();
    const first = sent.at(-1)!;
    expect(first.t).toBe('send');
    connected = false;
    callbacks.close?.(true);
    expect(input.value).toBe('继续聊');
    expect(submit.disabled).toBe(true);
    connected = true;
    callbacks.open?.();
    frame({ t:'init', items:[...recent, reply] });
    submit.click();
    expect(sent.at(-1)?.id).toBe(first.id);
    frame({ t:'sent', id:first.id });
    expect(input.value).toBe('');
    frame({ t:'init', items:[{ ...reply, cursor:20 }, { ...user, cursor:21, text:'最新消息' }], more:true, before:20,
      refs:{ withdrawn:[7], delivered:[[5,19],[6,19]] } });
    const history = () => [...document.querySelectorAll('.studio-conversation-log > div')].map(row => row.textContent);
    frame({ t:'withdrawn', cursor:8 });
    frame({ t:'settled', cursors:[9], at:22 });
    frame({ t:'older', items:[{ ...user, cursor:5, text:'排队甲' }, { ...user, cursor:6, text:'排队乙' },
      { ...user, cursor:7, text:'已撤回' }, { ...user, cursor:8, text:'刚撤回' },
      { ...user, cursor:9, text:'刚送达' }, { ...reply, cursor:10, beats:[{ text:'早一点的回复' }] }] });
    frame({ t:'item', item:{ ...user, cursor:7, text:'已撤回' } });
    frame({ t:'item', item:{ ...user, cursor:9, text:'刚送达' } });
    expect(history()).toEqual(['早一点的回复','排队甲','排队乙','我是重刀 Coo','最新消息','刚送达']);
  } finally { abort.abort(); }
});

it('opens scene apps inside one panel and keeps wallpaper selection and scene entry separate', async () => {
  const first = 'a'.repeat(24), second = 'b'.repeat(24);
  const items = [first,second].map((id,index) => ({id,title:'夜景 ' + (index+1),kind:'video',cover:false}));
  const controller = new AbortController();
  let selected: string | null = null, mode = 'desktop', cabin = false;
  let failEntry = true;
  api.invokePanel.mockImplementation(async (_provider,_panel,method,args: unknown[]) => {
    if (method === 'runtime.state') return {
      onDesktop:!cabin, inWindow:true, bodyReady:!cabin, activeScene:cabin ? 'cabin-world' : mode, skin:{figure:'test'},
      framework:{configuration:{}}, cabinWorld:{phase:cabin ? 'active' : 'idle'},
      presentation:{desired:mode,applied:mode,details:{wallpaper:{id:selected}}},
    } as RuntimeState;
    if (method === 'cabin.state') return {phase:cabin ? 'active' : 'idle', configured:true, bundled:true, residents:[], presented:cabin};
    if (method === 'cabin.enter') { cabin = true; return {phase:'active', configured:true, residents:[], presented:true}; }
    if (method === 'cabin.tool') return {};
    if (method === 'wallpaper.state') return {items,selected,options:{fit:'cover',scale:1,volume:0,paused:false,interactive:false}};
    if (method === 'presentation.select') {
      if (failEntry) { failEntry = false; return {phase:'failed',error:'presentation-timeout'}; }
      mode = String(args[0]);
      return {phase:'completed',applied:true};
    }
    if (method === 'wallpaper.choose') {
      selected = String(args[0]);
      return {phase:'completed',applied:mode === 'wallpaper',selectionOnly:mode !== 'wallpaper'};
    }
    throw Error('Unexpected call: ' + method);
  });
  const ui = {button: (label: string) => { const el=document.createElement('button'); el.textContent=label; return el; }};
  const root = document.createElement('div'); document.body.append(root);
  workspacePage('desktop').mount({root,signal:controller.signal,ui,lifecycle:{interval:()=>0,add:()=>{}}} as unknown as PageContext);
  const workspace = root.querySelector<HTMLElement>('.studio-scene-workspace')!;
  const tile = (id: string) => workspace.querySelector<HTMLButtonElement>(`button[data-mode="${id}"]`)!;
  const library = () => workspace.querySelector('.studio-wallpaper-library');
  const action = (id: string) => library()?.querySelector<HTMLButtonElement>(`[data-wallpaper-item="${id}"] button`);
  const search = () => library()?.querySelector<HTMLInputElement>('input[type=search]');
  const focusBack = () => workspace.querySelector<HTMLButtonElement>('.studio-scene-back')!.click();
  const enter = () => workspace.querySelector<HTMLButtonElement>('.studio-scene-actions button:not([hidden])')!;
  const called = (method: string) => api.invokePanel.mock.calls.some(call => call[2] === method);
  try {
    await vi.waitFor(() => expect(tile('desktop').dataset.current).toBe('true'));
    expect(workspace.querySelectorAll('.studio-scene-app')).toHaveLength(5);
    expect(workspace.querySelectorAll('input[type=range]')).toHaveLength(0);
    const wallpaper = tile('wallpaper');
    wallpaper.click();
    expect(workspace.dataset.view).toBe('app');
    expect(workspace.querySelectorAll('.scene-size-control')).toHaveLength(1);
    expect(called('presentation.select')).toBe(false);
    expect(enter().textContent).toBe('选择背景');
    enter().click();
    await vi.waitFor(() => expect(action(first)?.textContent).toBe('设为背景'));
    search()!.value = '夜景';
    search()!.dispatchEvent(new Event('input'));
    action(first)!.click();
    await vi.waitFor(() => expect(action(first)?.textContent).toBe('已选定'));
    expect(search()?.value).toBe('夜景');
    expect(mode).toBe('desktop');
    workspace.querySelector<HTMLElement>('.studio-scene-viewport')!.scrollTop = 120;
    focusBack();
    await vi.waitFor(() => expect(enter().textContent).toBe('进入场景'));
    enter().click();
    await vi.waitFor(() => expect(enter().textContent).toBe('重试进入'));
    expect(workspace.textContent).toContain('新画面未能及时就绪');
    expect(mode).toBe('desktop');
    enter().click();
    await vi.waitFor(() => expect(enter().textContent).toBe('使用中'));
    const libraryButton = workspace.querySelector<HTMLButtonElement>('.studio-wallpaper-header .studio-inline button:last-child')!;
    libraryButton.click();
    await vi.waitFor(() => expect(action(first)?.textContent).toBe('使用中'));
    expect(search()?.value).toBe('夜景');
    expect(workspace.querySelector<HTMLElement>('.studio-scene-viewport')!.scrollTop).toBe(120);
    action(second)!.click();
    await vi.waitFor(() => expect(action(second)?.textContent).toBe('使用中'));
    expect(action(first)?.textContent).toBe('切换到这张');
    expect(document.querySelector('dialog[open]')).toBeNull();
    focusBack();
    expect(document.activeElement).toBe(libraryButton);
    focusBack();
    expect(document.activeElement).toBe(wallpaper);
    tile('cabin').click();
    expect(called('cabin.enter')).toBe(false);
    expect(enter().textContent).toBe('进入小屋世界');
    enter().click();
    await vi.waitFor(() => expect(enter().textContent).toBe('离开小屋世界'));
    focusBack();
    expect(tile('cabin').dataset.current).toBe('true');
    expect(tile('wallpaper').dataset.current).toBe('false');
  } finally { controller.abort(); }
});

it('opens right-click scene apps before entering and adjusts only the chosen scene size', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const choose = vi.fn(), save = vi.fn(), cabin = vi.fn();
  let mode = 'desktop';
  const phone = createControlPhone({
    root, text: (cn: string) => cn,
    scenes: {desktop:{label:['桌面','Desktop'], icon:'desktop'}, room:{label:['小屋','Room'], icon:'room'}},
    helpers: {
      mode: () => mode, close: () => {}, cancelVoice: () => {}, selectScene: choose,
      openCabin: () => {}, enterCabin: cabin,
      size: {read: (scene: string) => scene === 'room' ? 1.2 : 1, save, preview: () => {}},
    },
  });
  phone.open('scenes');
  const click = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!.click();
  const title = () => root.querySelector('h2')!.textContent;
  click('.control-phone-scene-app[data-scene=room]');
  expect(title()).toBe('小屋');
  expect(choose).not.toHaveBeenCalled();
  expect(root.querySelector('output')?.textContent).toBe('120%');
  click('.scene-size-step:last-child');
  expect(save).toHaveBeenCalledWith('room', 1.25);
  click('.control-phone-scene-enter');
  expect(choose).toHaveBeenCalledWith('room');
  mode = 'room';
  phone.syncSettings(true);
  expect(root.querySelector('.control-phone-scene-enter')?.textContent).toContain('使用中');
  click('.control-phone-back');
  expect((document.activeElement as HTMLElement).dataset.scene).toBe('room');
  click('.control-phone-scene-app[data-scene=cabin]');
  expect(cabin).not.toHaveBeenCalled();
  expect(root.querySelector('.control-phone-scene-enter')?.textContent).toBe('安装小屋组件');
  click('.control-phone-scene-enter');
  expect(cabin).toHaveBeenCalledTimes(1);
  phone.updateCabin('preparing');
  expect(root.querySelector('.control-phone-scene-enter')?.textContent).toBe('查看安装进度');
  phone.updateCabin('ready');
  expect(root.querySelector('.control-phone-scene-enter')?.textContent).toBe('进入小屋世界');
  click('.control-phone-scene-enter');
  expect(cabin).toHaveBeenCalledTimes(2);
  phone.updateCabin('active');
  expect(root.querySelector('.control-phone-scene-enter')?.textContent).toBe('使用中');
  expect(root.querySelector<HTMLButtonElement>('.control-phone-scene-enter')?.disabled).toBe(true);
  phone.close();
});

it('plays video wallpaper audio only after commit and while the scene is visible', async () => {
  const hidden = vi.spyOn(document,'hidden','get').mockReturnValue(false);
  const play = vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
  const pause = vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(() => {});
  const stage = document.createElement('div');
  document.body.append(stage);
  const view = createWallpaperPresentation({
    body:{},surface:{stage},scene:{rect:()=>({x:0,y:0,w:640,h:360}),bounds:()=>({W:640,H:360})},
    wallpaper:{id:'video',kind:'video',media:'/video.mp4',options:{volume:.4}},
  });
  try {
    const ready = view.ready();
    const media = stage.querySelector('video')!;
    media.dispatchEvent(new Event('loadeddata'));
    await ready;
    view.activate();
    expect(media.muted).toBe(true);
    expect(play).not.toHaveBeenCalled();
    view.bodyCommitted();
    expect(media.muted).toBe(false);
    expect(media.volume).toBe(.4);
    view.setVisible(false);
    expect(media.volume).toBe(0);
    expect(pause).toHaveBeenCalled();
    view.setVisible(true);
    expect(media.volume).toBe(.4);
    view.configure({wallpaper:{id:'video',options:{volume:.4,paused:true}}});
    expect(media.volume).toBe(0);
  } finally {
    view.dispose();
    hidden.mockRestore();
    play.mockRestore();
    pause.mockRestore();
  }
});
it('mounts an owned configuration hierarchy and derives controls from framework fields and uses its mutation contract',async()=>{
 api.invokePanel.mockImplementation(async(_provider,panel,method)=>method==='resources'?[{id:'test-body',name:'Test',kind:'live2d-model',active:true,wardrobe:true}]:method==='resources.characterWardrobe'?{axes:[],presets:[],current:'',active:true}:method==='modelEditor'?{figure:'test-body',editor:null,fields:[],operation:{phase:'idle'}}:{framework:{definition:{id:'desktop-live2d-pet',defaultPresentation:'desktop'},configuration:{bodyEffects:{fields:[{key:'squash',type:'boolean',writableBy:'user'}],desired:{squash:true},observed:{status:'applied'}}},runtime:{domains:{body:{implementation:'figure-body',status:'active'}}}},connected:true,inWindow:true,skin:{figure:'test-body'},modelProvider:'embedded-figure',bodyEffects:{squash:true,dragStretch:true,breathing:true},bodyEffectsFeedback:{status:'applied'}});
 api.setConfig.mockResolvedValue('ok');
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 const ui={button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}};
 await workspacePage('framework').mount({root,signal:controller.signal,ui:ui as any,lifecycle:{interval:()=>0 as any,add:()=>{}}});
 expect(root.dataset.workspacePanel).toBe('framework');
 expect(root.querySelectorAll('iframe')).toHaveLength(0);
 expect(root.querySelector('.studio-rail')).toBeNull();
 await vi.waitFor(()=>expect(root.querySelector('.studio-model-card[data-active=true]')).not.toBeNull());
 const wardrobe = root.querySelector<HTMLButtonElement>('[data-action=wardrobe]')!;
 wardrobe.click();
 const effects = () => Array.from(root.querySelectorAll<HTMLButtonElement>('dialog[open] button')).find(b=>b.textContent==='身体整体效果');
 await vi.waitFor(()=>expect(effects()).toBeDefined());
 effects()!.click();
 await vi.waitFor(()=>expect(root.querySelectorAll('input[type=checkbox]')).toHaveLength(1));
 const input=root.querySelector('input[type=checkbox]') as HTMLInputElement;expect(input.checked).toBe(true);input.checked=false;input.dispatchEvent(new Event('change'));
 await vi.waitFor(()=>expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','framework','setBodyEffects',[{squash:false}],{signal:controller.signal}));
 root.querySelector('dialog[open]')?.dispatchEvent(new Event('close')); root.querySelector('dialog[open]')?.removeAttribute('open');
 await vi.waitFor(()=>expect(root.querySelector('.studio-model-card[data-active=true]')?.textContent).toContain('编辑'));
 (Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.dataset.action==='edit'))!.click();
 await vi.waitFor(()=>expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','framework','modelEditor',[],{signal:expect.any(AbortSignal)}));
 controller.abort();window.dispatchEvent(new PageTransitionEvent('pagehide'));
});

it('retries failed settings loads without caching an empty subpanel', async () => {
 api.get.mockRejectedValue(new Error('Connection unavailable'));
 api.invokePanel.mockImplementation(async () => ({ skin:{figure:''}, framework:{configuration:{}} }));
 const root = document.createElement('div'), controller = new AbortController();
 document.body.append(root);
 const ui = { button: (text:string) => { const button=document.createElement('button'); button.textContent=text; return button; } };
 workspacePage('display').mount({root, signal:controller.signal, ui:ui as any, lifecycle:{interval:()=>0 as any,add:()=>{}}});
 try {
   const findRetry=()=>root.querySelector<HTMLButtonElement>('.studio-settings-retry button');
   await vi.waitFor(()=>expect(findRetry()).not.toBeNull());
   expect(root.textContent).toContain('Connection unavailable');
   api.get.mockResolvedValue({ groups:[] });
   findRetry()!.click();
   await vi.waitFor(()=>expect(root.querySelector('[data-task=display] .studio-settings-fields')).not.toBeNull());
 } finally { controller.abort(); }
});

it('derives speech settings from the service and sends no legacy config writes',async()=>{
 api.invokePanel.mockResolvedValue({framework:{definition:{id:'test',defaultPresentation:'desktop'},configuration:{bodyEffects:{fields:[],desired:{},observed:null},speech:{fields:[{key:'pitch',type:'enum',options:['low','custom']},{key:'pitchHz',type:'number',min:200,max:700,enabledWhen:{pitch:'custom'}}],desired:{pitch:'low',pitchHz:555},effective:{enabled:true,pitchHz:300,unitsPerSecond:13},observed:null}},runtime:null},connected:false,inWindow:false,skin:{}});
 const runtime=await api.invokePanel();
 let inputMode = 'hold', thresholdDb = -42, recording = false;
 api.invokePanel.mockImplementation(async(_provider,panel,method,args)=>{
   if (method==='services.state') return {providers:[],models:[],selected:{}};
   if (method==='audio.ttsState') return {enabled:false,provider:'',providers:{},profiles:{},playback:null};
   if (method==='audio.plannerState') return {enabled:false,ready:false};
   if (panel==='voice') {
     if (method==='setMic') inputMode=(args?.[0] as {mode:string}).mode;
     if (method==='setThreshold') thresholdDb=Number(args?.[0]);
     if (method==='testStart') recording=true;
     if (method==='testFinish'||method==='testCancel') recording=false;
     return {enabled:true,windowVisible:true,engine:'funasr',engineSetting:'',systemSupported:false,server:{phase:'running'},model:{phase:'ready',reused:true},api:{model:''},mic:{state:'on'},input:{mode:inputMode,hint:'runtime hint',deviceId:'',openOnPress:true,devices:[]},test:recording?{phase:'recording'}:{phase:'idle'},level:-36,thresholdDb,recent:[]};
   }
   return runtime;
 });
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 await workspacePage('sound').mount({root,signal:controller.signal,ui:{button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}} as any,lifecycle:{interval:()=>0 as any,add:()=>{}}});

 const rows = [...root.querySelectorAll('.studio-sound-sheet')];
 expect(root.querySelector('.studio-panel-header .studio-runtime-launch')).toBeNull();
 expect(rows.map(row=>row.querySelector('h3')?.textContent)).toEqual(['语音输入','说话声','音效']);
 expect(root.querySelector('[data-setting=pitch]')).toBeNull();
 await vi.waitFor(()=>expect(rows[1].textContent).toContain('语音合成'));
 expect(rows[1].textContent).not.toContain('音节发声');
 expect(root.querySelector('dialog[open]')).toBeNull();
 const input = rows[0]!;
 await vi.waitFor(()=>expect(input.textContent).toContain('已复用 Coo 的本地模型'));
 expect(input.querySelector('[aria-pressed=true]')?.textContent).toBe('按住说话');
 expect(input.querySelectorAll('[role=switch]')).toHaveLength(1);
 const marker = input.querySelector<HTMLElement>('[role=slider][aria-label="检测门槛"]')!;
 expect(marker.hidden).toBe(true);
 expect(input.querySelector('input[type=range]')).toBeNull();
 input.querySelector<HTMLButtonElement>('[data-mode="toggle"]')!.click();
 await vi.waitFor(()=>expect(input.textContent).toContain('再点一次结束并发送'));
 expect(marker.hidden).toBe(true);
 input.querySelector<HTMLButtonElement>('[data-mode="always"]')!.click();
 await vi.waitFor(()=>expect(marker.hidden).toBe(false));
 const meter = input.querySelector<HTMLMeterElement>('meter')!;
 const track = marker.parentElement!;
 expect(meter.parentElement).toBe(track);
 expect(meter.value).toBe(-36);
 expect(marker.style.left).toBe('47.5%');
 expect(marker.getAttribute('aria-valuenow')).toBe('-42');
 expect(input.textContent).toContain('试录转写仅在此显示');
 const tryMic = [...input.querySelectorAll('button')].find(button=>button.textContent==='开始试录')!;
 tryMic.click();
 await vi.waitFor(()=>expect(tryMic.textContent).toBe('结束试录'));
 expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','voice','testStart',[],
   {keepalive:true,signal:expect.any(AbortSignal)});
 marker.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
 await vi.waitFor(()=>expect(marker.getAttribute('aria-valuenow')).toBe('-41'));
 expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','voice','setThreshold',[-41],{signal:controller.signal});
 await vi.waitFor(()=>expect(marker.getAttribute('aria-disabled')).toBe('false'));
 vi.spyOn(track,'getBoundingClientRect').mockReturnValue({left:100,width:200} as DOMRect);
 const gesture=(type:string, clientX:number)=>{
   const event=new MouseEvent(type,{clientX,bubbles:true,button:0});
   Object.defineProperty(event,'pointerId',{value:7});
   track.dispatchEvent(event);
 };
 gesture('pointerdown',140);
 gesture('pointermove',230);
 expect(marker.getAttribute('aria-valuenow')).toBe('-28');
 expect(api.invokePanel.mock.calls.filter(call=>call[2]==='setThreshold')).toHaveLength(1);
 gesture('pointercancel',230);
 expect(marker.getAttribute('aria-valuenow')).toBe('-41');
 gesture('pointerdown',220);
 gesture('pointerup',250);
 await vi.waitFor(()=>expect(marker.getAttribute('aria-valuenow')).toBe('-20'));
 expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','voice','setThreshold',[-20],{signal:controller.signal});
 expect(api.setConfig).not.toHaveBeenCalled();
 const open = input.querySelector<HTMLButtonElement>('.studio-audio-utilities button')!;
 open.focus();
 open.click();
 const dialog = root.querySelector<HTMLDialogElement>('dialog[open].studio-recognition-dialog')!;
 expect(dialog.querySelectorAll('[role=switch]')).toHaveLength(1);
 dialog.close();
 expect(document.activeElement).toBe(open);
 controller.abort();
});
