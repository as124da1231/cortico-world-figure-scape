// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const api=vi.hoisted(()=>({invokePanel:vi.fn(),setConfig:vi.fn(),get:vi.fn(async()=>({groups:[]}))}));
vi.mock('../src/webui/coopanion/base/api.ts',()=>api);
vi.mock('../src/webui/coopanion/base/language.ts',()=>({LANGUAGE:'zh'}));
import { workspacePage } from '../src/webui/coopanion/features/framework/index.ts';
import { mountConversation } from '../src/webui/coopanion/features/framework/conversation-panel.ts';
import type { PageContext } from '../src/webui/coopanion/base/page.ts';
import type { RuntimeState } from '../src/webui/coopanion/features/framework/runtime.ts';
// @ts-expect-error Native wallpaper view is a browser module.
import { createWallpaperPresentation } from '../web/framework/wallpaper-presentation.js';
// @ts-expect-error The desktop operation panel is a browser module.
import { createControlPhone } from '../web/framework/phone-controls.js';
HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open',''); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});

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
  click('.control-phone-scene-enter');
  expect(cabin).toHaveBeenCalledTimes(1);
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
 api.invokePanel.mockImplementation(async(_provider,panel,method)=>{
   if (method==='services.state') return {providers:[],models:[],selected:{}};
   if (method==='audio.ttsState') return {enabled:false,provider:'',providers:{},profiles:{},playback:null};
   if (method==='audio.plannerState') return {enabled:false,ready:false};
   if (panel==='voice') return {enabled:false,engine:'funasr',systemSupported:false,server:null,model:{phase:'absent'},api:{model:''},mic:{state:'off'},input:{mode:'hold',hotkey:'',keyLabel:'',deviceId:'',openOnPress:false,devices:[]},level:-60,recent:[]};
   return runtime;
 });
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 await workspacePage('sound').mount({root,signal:controller.signal,ui:{button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}} as any,lifecycle:{interval:()=>0 as any,add:()=>{}}});

 const rows = [...root.querySelectorAll('.studio-settings-row')];
 expect(rows.map(row=>row.querySelector('h2')?.textContent)).toEqual(['音效','说话声','语音输入']);
 expect(root.querySelector('[data-setting=pitch]')).toBeNull();
 const open = rows[1].querySelector('button')!;
 open.focus();
 open.click();
 const dialog = root.querySelector<HTMLDialogElement>('dialog[open]')!;
 expect(dialog.querySelector('h2')?.textContent).toBe('说话声设置');
 expect(dialog.querySelector('[data-setting=pitch]')).toBeNull();
 await vi.waitFor(()=>expect(dialog.textContent).toContain('语音合成'));
 expect(dialog.textContent).not.toContain('音节发声');
 expect(api.setConfig).not.toHaveBeenCalled();
 dialog.close();
 expect(root.querySelector('dialog[open]')).toBeNull();
 expect(document.activeElement).toBe(open);
 expect([...root.querySelectorAll('.studio-settings-row')]).toEqual(rows);
 controller.abort();
});
