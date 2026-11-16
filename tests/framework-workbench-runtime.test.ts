// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { workspacePage } from '../src/webui/coopanion/features/framework/index.ts';
import { createTouchEditor } from '../src/webui/coopanion/features/framework/touch-editor.ts';

const api = vi.hoisted(() => ({ invokePanel: vi.fn(), pickPath: vi.fn() }));
vi.mock('../src/webui/coopanion/base/api.ts', () => api);
vi.mock('../src/webui/coopanion/base/language.ts', () => ({ LANGUAGE: 'zh' }));

HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open',''); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };

const runtime = () => ({
  skin: { figure: 'live2d-test' }, inWindow: true, onDesktop: true, bodyReady: true, canOpenLive2d: true,
  body: { id: 'desktop-pet', switchable: true }, clickThrough: false,
  framework: { configuration: { bodyEffects: { fields: [], desired: {} } }, model: { busy: false } },
});

const fixture = (panel: Parameters<typeof workspacePage>[0]) => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const intervals: Array<() => void> = [];
  workspacePage(panel).mount({
    root, signal: controller.signal,
    ui: { button(label: string) {
      const button = document.createElement('button');
      button.textContent = label;
      return button;
    } } as never,
    lifecycle: { interval: fn => { intervals.push(fn); return { dispose() {} }; }, add() {} },
  });
  return {
    root, controller, intervals,
    button: (label: string) => [...root.querySelectorAll('button')].find(button => button.textContent === label),
  };
};

afterEach(() => {
  api.invokePanel.mockReset();
  document.body.replaceChildren();
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  delete window.coopanionWindow;
});

it('cancels a pending local model import through its operation ID', async () => {
  let rejectLoad: (reason: Error) => void = () => {};
  let phase = 'preparing';
  api.invokePanel.mockImplementation(async (_provider, _panel, method) => {
    if (method === 'resources') return [];
    if (method === 'resources.beginUpload') return { id:'test-zip' };
    if (method === 'resources.appendUpload') return { done: 3, total: 3 };
    if (method === 'resources.finishUpload') return { models: [{ id: 'candidate', title: 'Character', file: 'character.model3.json' }], problems: [], truncated: false };
    if (method === 'resources.importCandidate') return new Promise((_resolve, reject) => { rejectLoad = reject; });
    if (method === 'operation.get') return { phase };
    if (method === 'operation.cancel') {
      phase = 'cancelled';
      rejectLoad(Error('Cancelled'));
      return { phase };
    }
    return runtime();
  });
  const workbench = fixture('framework');
  try {
    const input = workbench.root.querySelector<HTMLInputElement>('input[type=file][accept]')!;
    Object.defineProperty(input, 'files', { value: [new File(['zip'], 'figure.zip')] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(api.invokePanel.mock.calls.some(call => call[2] === 'resources.importCandidate')).toBe(true));
    for (const poll of workbench.intervals) poll();
    await vi.waitFor(() => expect(workbench.root.textContent).toContain('正在检查和准备模型'));
    workbench.button('取消导入')!.click();
    await vi.waitFor(() => expect(workbench.root.textContent).toContain('已取消导入'));
    const [, , , [candidate, id]] = api.invokePanel.mock.calls.find(call => call[2] === 'resources.importCandidate')!;
    expect(api.invokePanel.mock.calls.find(call => call[2] === 'resources.beginUpload')?.[3]).toEqual(['zip',3]);
    expect(candidate).toBe('candidate');
    expect(workbench.root.querySelector('dialog[open]')).toBeNull();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.invokePanel.mock.calls.find(call => call[2] === 'operation.cancel')?.[3]).toEqual([id]);
    expect(workbench.button('导入文件夹')?.disabled).toBe(false);
  } finally {
    workbench.controller.abort();
  }
});

it('uses a browser folder input and runs a dropped ZIP through the same candidate intake', async () => {
  const imports: string[] = [];
  api.pickPath.mockClear();
  api.invokePanel.mockImplementation(async (_provider, _panel, method, args) => {
    if (method === 'resources') return [];
    if (method === 'resources.adaptationState') return { options:{ mode:'ai' }, plans:[] };
    if (method === 'resources.beginUpload') { imports.push(args[0]); return { id: 'upload' }; }
    if (method === 'resources.appendUpload') return { done: 1, total: 1 };
    if (method === 'resources.finishUpload') return { models: [{ id: 'candidate', title: 'Character', file: 'character.model3.json' }], problems: [], truncated: false };
    if (method === 'resources.importCandidate') return { imported: 'live2d-test' };
    return runtime();
  });
  const { root, controller, button } = fixture('framework');
  try {
    const input = root.querySelector<HTMLInputElement>('input[type=file][webkitdirectory]')!;
    await vi.waitFor(() => expect(button('导入文件夹')?.disabled).toBe(false));
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    button('导入文件夹')!.click();
    expect(click).toHaveBeenCalledOnce();
    expect(api.pickPath).not.toHaveBeenCalled();

    const folderFile = new File(['{}'],'character.model3.json');
    Object.defineProperty(folderFile, 'webkitRelativePath', { value: 'Character/character.model3.json' });
    Object.defineProperty(input, 'files', { value: [folderFile] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(root.textContent).toContain('已加入模型库'));

    expect(root.querySelector('dialog[open]')).toBeNull();
    button('导入详情')!.click();
    expect(root.querySelector('dialog[open]')?.textContent).toContain('请 Coo 分析');
    root.querySelector<HTMLDialogElement>('dialog[open]')!.close();

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    const zip = new File(['zip'],'figure.zip');
    Object.defineProperty(drop,'dataTransfer',{ value: { types:['Files'], files:[zip], items:[] } });
    await vi.waitFor(() => expect(button('导入文件夹')?.disabled).toBe(false));
    root.querySelector('.studio-drop-target')!.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(api.invokePanel.mock.calls.filter(call => call[2] === 'resources.importCandidate')).toHaveLength(2));
    const zipInput = root.querySelector<HTMLInputElement>('input[type=file][accept]')!;
    const zipClick = vi.spyOn(zipInput,'click').mockImplementation(() => {});
    const menu = root.querySelector<HTMLDetailsElement>('.studio-import-menu')!;
    menu.open = true;
    button('导入 ZIP')!.click();
    expect(menu.open).toBe(false);
    expect(zipClick).toHaveBeenCalledOnce();
    Object.defineProperty(zipInput, 'files', { value:[zip] });
    zipInput.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(api.invokePanel.mock.calls.filter(call => call[2] === 'resources.importCandidate')).toHaveLength(3));
    expect(imports).toEqual(['bundle','zip','zip']);
  } finally { controller.abort(); }
});

it('stages and validates geometry before adding or replacing a touch area', () => {
  const root = document.createElement('div'), controller = new AbortController();
  document.body.append(root);
  const changed = vi.fn(), send = vi.fn(async () => ({}));
  const editor = createTouchEditor({ root, signal:controller.signal, changed, send });
  root.append(editor.element);
  const button = (label: string) => [...editor.element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  const input = (element: HTMLInputElement | HTMLTextAreaElement, value:string) => {
    element.value = value;
    element.dispatchEvent(new Event('input'));
  };
  const shape = (value:string) => {
    const select = editor.element.querySelector<HTMLSelectElement>('select')!;
    select.value = value;
    select.dispatchEvent(new Event('change'));
  };
  editor.read({ areas:[], rules:[{gesture:'poke',area:'head',reaction:'none',send:'local'}] }, undefined, undefined);
  editor.show(true);
  const drag = (a: number, b: number, c: number, d: number) => editor.pointer({start:{x:a,y:b},point:{x:c,y:d}});
  try {
    button('新建区域').click();
    input(editor.element.querySelector('input')!, '左耳');
    expect(button('添加区域').disabled).toBe(true);
    drag(.1,.1,.3,.25);
    expect(editor.element.textContent).toContain('与「头部」重叠');
    expect(button('添加区域').disabled).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    button('取消').click();

    button('重画范围').click();
    shape('ellipse');
    drag(.4,.04,.65,.26);
    expect(editor.value()?.areas).toHaveLength(0);
    button('应用范围').click();
    expect(editor.value()?.areas).toMatchObject([{id:'head',shape:{kind:'ellipse'}}]);
    expect(editor.value()?.rules).toMatchObject([{area:'head',reaction:'none'}]);
    expect(changed).toHaveBeenCalledTimes(1);

    button('新建区域').click();
    input(editor.element.querySelector('input')!, '左耳');
    input(editor.element.querySelector('textarea')!, '发饰旁边');
    shape('polygon');
    for (const point of [{x:.12,y:.1},{x:.26,y:.1},{x:.22,y:.2}]) editor.pointer({point});
    button('撤销上一点').click();
    expect(button('添加区域').disabled).toBe(true);
    editor.pointer({point:{x:.18,y:.22}});
    expect(editor.value()?.areas).toHaveLength(1);
    button('添加区域').click();
    expect(editor.value()?.areas).toHaveLength(2);
    const id = editor.value()!.areas.find(item => item.name === '左耳')!.id;
    expect(editor.value()?.areaNotes?.[id]).toBe('发饰旁边');

    button('试触').click();
    expect(send).toHaveBeenLastCalledWith('touch-config', expect.objectContaining({ tool:'test', replacing:null }));
  } finally { controller.abort(); }
});

it('edits built-in bounds directly and switches between canvas selection and testing', () => {
  const root = document.createElement('div'), controller = new AbortController();
  const changed = vi.fn(), send = vi.fn(async () => ({}));
  const editor = createTouchEditor({ root, signal:controller.signal, changed, send });
  const pick = (id: string) => editor.element.querySelector<HTMLButtonElement>('[data-area="'+id+'"]')!;
  const adjust = (label: string, value: number) => {
    const input=editor.element.querySelector<HTMLInputElement>('input[aria-label="'+label+'"]')!;
    input.value=String(value);
    input.dispatchEvent(new Event('input'));
    return input.valueAsNumber;
  };
  editor.read({ areas:[], rules:[] },undefined,undefined);
  editor.show(true);
  try {
    expect(pick('head').getAttribute('aria-pressed')).toBe('true');
    const description = editor.element.querySelector('textarea')!;
    expect(description.closest('[hidden],details')).toBeNull();
    description.value = '刘海和头顶';
    description.dispatchEvent(new Event('input'));
    expect(editor.value()).toMatchObject({areaNotes:{head:'刘海和头顶'},areas:[],rules:[]});
    expect(adjust('下边界',.36)).toBe(.32);
    expect(editor.value()?.areas).toHaveLength(0);
    expect(editor.element.textContent).toContain('躯干');
    expect(adjust('下边界',.27)).toBe(.27);
    expect(editor.value()?.areas[0]).toMatchObject({id:'head',shape:{points:[{y:0},{y:0},{y:.27},{y:.27}]}});
    editor.pointer({area:'body'});
    expect(pick('body').getAttribute('aria-pressed')).toBe('true');
    expect(editor.element.querySelector('textarea')?.value).toBe('');
    expect(adjust('上边界',.3)).toBe(.3);
    editor.pointer({area:'legs'});
    expect(adjust('左边界',.12)).toBe(.12);
    expect(editor.value()?.areas.map(area=>area.id)).toEqual(['head','body','legs']);
    editor.read(editor.value(),undefined,undefined);
    expect(pick('legs').getAttribute('aria-pressed')).toBe('true');
    expect(send).not.toHaveBeenCalledWith('touch-test', expect.anything());
  } finally { controller.abort(); }
});

it('starts from the workbench header and waits for the window before changing the next action', async () => {
  const state = { ...runtime(), onDesktop: false, inWindow: false, bodyReady: false, window: { phase: 'stopped' } };
  const commands: string[] = [];
  api.invokePanel.mockImplementation(async (_provider, _panel, method) => {
    if (method === 'resources') return [];
    if (method === 'runtime.openWindow' || method === 'runtime.hideWindow') commands.push(method);
    if (method === 'runtime.openWindow' && !state.inWindow) state.window.phase = 'running';
    return structuredClone(state);
  });
  const workbench = fixture('framework');
  try {
    const header = workbench.root.querySelector('.studio-header-tools')!;
    const launch = header.querySelector<HTMLButtonElement>('.studio-runtime-launch')!;
    await vi.waitFor(() => expect(launch.disabled).toBe(false));
    expect(launch.textContent).toBe('启动梦境');
    launch.click();
    launch.click();
    await vi.waitFor(() => expect(launch.textContent).toBe('正在连接…'));
    expect(workbench.root.querySelector('dialog[open]')).toBeNull();
    state.inWindow = state.onDesktop = state.bodyReady = true;
    for (const poll of workbench.intervals) poll();
    await vi.waitFor(() => expect(launch.textContent).toBe('隐藏梦境'));
    launch.click();
    await vi.waitFor(() => expect(launch.textContent).toBe('正在隐藏…'));
    expect(launch.disabled).toBe(true);
    state.onDesktop = false;
    for (const poll of workbench.intervals) poll();
    await vi.waitFor(() => expect(launch.textContent).toBe('显示梦境'));
    launch.click();
    await vi.waitFor(() => expect(launch.textContent).toBe('正在显示…'));
    state.onDesktop = true;
    for (const poll of workbench.intervals) poll();
    await vi.waitFor(() => expect(launch.textContent).toBe('隐藏梦境'));
    expect(commands).toEqual(['runtime.openWindow', 'runtime.hideWindow', 'runtime.openWindow']);
    expect(api.invokePanel.mock.calls.some(call => ['runtime.selectBody','runtime.selectStockBody'].includes(call[2]))).toBe(false);
  } finally {
    workbench.controller.abort();
  }
});

it('shows a static cover and one set of character actions', async () => {
  window.coopanionWindow = { platform:'win32' } as typeof window.coopanionWindow;
  api.invokePanel.mockImplementation(async (_provider, _panel, method) => {
    if (method === 'resources') return [{ id:'live2d-test', kind:'live2d-model', active:true, name:'Hiyori' }];
    return { ...runtime(), url:'http://127.0.0.1:7800/pet' };
  });
  const workbench = fixture('framework');
  try {
    const cover = () => workbench.root.querySelector<HTMLElement>('.studio-model-cover')!;
    await vi.waitFor(() => expect(cover()).toBeTruthy());
    expect(cover().tagName).toBe('DIV');
    expect(cover().textContent).toContain('暂无封面');
    expect(cover().getAttribute('title')).toBeNull();
    expect([...workbench.root.querySelectorAll('.studio-model-actions button')].map(button => button.textContent)).toEqual(['编辑角色', '待加载', '快捷装扮', '移除']);
    cover().click();
    expect(api.invokePanel.mock.calls.some(call => call[2] === 'runtime.openPreview')).toBe(false);
    expect(workbench.root.querySelector('dialog[open], iframe')).toBeNull();
  } finally { workbench.controller.abort(); }
});

it('updates cover progress without replacing the focused card action', async () => {
  const model = {
    id:'live2d-test', kind:'live2d-model', active:true, name:'Hiyori',
    coverJob:{ phase:'queued', reason:'' }, cover:undefined as string | undefined,
  };
  api.invokePanel.mockImplementation(async (_provider, _panel, method) => {
    if (method === 'resources') return [structuredClone(model)];
    if (method === 'resources.retryCover') { model.coverJob.phase = 'queued'; return { queued:true }; }
    return { ...runtime(), url:'http://127.0.0.1:7800/pet' };
  });
  const workbench = fixture('framework');
  try {
    await vi.waitFor(() => expect(workbench.root.textContent).toContain('正在生成封面'));
    const cover = workbench.root.querySelector('.studio-model-cover')!;
    const edit = workbench.button('编辑角色')!;
    edit.focus();
    model.coverJob = { phase:'failed', reason:'WebGL unavailable' };
    for (const poll of workbench.intervals) poll();
    await vi.waitFor(() => expect(cover.textContent).toContain('封面未生成'));
    expect(workbench.button('编辑角色')).toBe(edit);
    expect(document.activeElement).toBe(edit);
    workbench.button('重试封面')!.click();
    await vi.waitFor(() => expect(cover.textContent).toContain('正在生成封面'));
    expect(api.invokePanel.mock.calls.find(call => call[2] === 'resources.retryCover')?.[3]).toEqual([model.id]);
    model.cover = '/cover.generated.png';
    for (const poll of workbench.intervals) poll();
    await vi.waitFor(() => expect(cover.querySelector('img')?.getAttribute('src')).toBe('http://127.0.0.1:7800/cover.generated.png'));
    cover.querySelector('img')!.dispatchEvent(new Event('load'));
    expect(cover.querySelector('.studio-cover-status')!.textContent).toBe('');
    cover.dispatchEvent(new MouseEvent('click', { bubbles:true }));
    expect(workbench.root.querySelector('dialog[open], iframe')).toBeNull();
    expect(workbench.button('编辑角色')).toBe(edit);
  } finally { workbench.controller.abort(); }
});

it('switches mouse pass-through independently of the Coo body route', async () => {
  const state = runtime();
  api.invokePanel.mockImplementation(async (_provider, _panel, method, args) => {
    if (method === 'runtime.setClickThrough') state.clickThrough = args[0];
    return structuredClone(state);
  });
  const workbench = fixture('desktop');
  try {
    const version = workbench.root.querySelector<HTMLButtonElement>('.studio-version')!;
    version.click();
    expect(workbench.root.querySelector('dialog[open] h2')?.textContent).toBe('运行详情');
    await vi.waitFor(() => expect(workbench.button('启用鼠标穿透')?.disabled).toBe(false));
    workbench.button('启用鼠标穿透')!.click();
    await vi.waitFor(() => expect(workbench.button('关闭鼠标穿透')?.disabled).toBe(false));
    workbench.button('关闭鼠标穿透')!.click();
    await vi.waitFor(() => expect(workbench.root.textContent).toContain('已恢复鼠标交互'));
    expect(api.invokePanel.mock.calls.filter(call => call[2] === 'runtime.setClickThrough').map(call => call[3])).toEqual([[true], [false]]);
    expect(api.invokePanel.mock.calls.some(call => ['selectBody', 'selectStockBody'].includes(call[2]))).toBe(false);
  } finally {
    workbench.controller.abort();
  }
});

