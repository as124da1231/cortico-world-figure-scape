// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
const api=vi.hoisted(()=>({invokePanel:vi.fn()}));
vi.mock('../src/webui/coopanion/base/api.ts',()=>api);
vi.mock('../src/webui/coopanion/base/language.ts',()=>({LANGUAGE:'en'}));
import {wardrobeEditor} from '../src/webui/coopanion/features/framework/wardrobe-editor.ts';
import {appearancePanel} from '../src/webui/coopanion/features/framework/appearance-panel.ts';
import {characterWardrobePicker} from '../src/webui/coopanion/features/framework/character-wardrobe.ts';
import {studioControls} from '../src/webui/coopanion/features/framework/controls.ts';
import {figureEditorView, type OpenedFigure} from '../src/webui/figure-editor-view.ts';
function context(){const root=document.createElement('div');document.body.append(root);return {root,signal:new AbortController().signal,ui:{button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}} as any,lifecycle:{} as any};}
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});
it('preserves absent legacy wardrobe and missing resources until an explicit removal',()=>{
 const ctx=context(),editor=wardrobeEditor(ctx);ctx.root.append(editor.element);
 editor.read(undefined,[{id:'expr-live',title:'Live',kind:'expression'}]);expect(editor.value()).toBeUndefined();
 const original=[{id:'custom1',custom:true,name:'Glasses',en:'Glasses',options:[{id:'on',name:'On',resource:'expr-missing'}]}];editor.read(original,[{id:'expr-live',title:'Live',kind:'expression'}]);
 expect(editor.value()).toEqual(original);const select=ctx.root.querySelector<HTMLSelectElement>('select[aria-label="Wardrobe resource"]')!;expect(select.value).toBe('expr-missing');expect(select.selectedOptions[0].textContent).toContain('Missing resource');
 (Array.from(ctx.root.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='Remove wardrobe option') as HTMLButtonElement).click();expect(editor.value()?.[0].options).toEqual([]);
});
it('renders actual axes and sends only an appearance-domain mutation, retaining DOM across refresh',async()=>{
 const state={figure:'raw',available:true,busy:false,axes:[{id:'outfit',name:{en:'Outfit'},options:[{id:'default',name:{en:'Default'}},{id:'coat',name:{en:'Coat'}}]}],desired:{scheme:'default',picks:{outfit:'default'}},observed:{status:'applied',scheme:'default'}};
 api.invokePanel.mockImplementation(async(_p,_panel,method)=>method==='appearance'?structuredClone(state):{});
 const ctx=context(),panel=appearancePanel(ctx);ctx.root.append(panel.element);await panel.refresh();const select=ctx.root.querySelector('select')!;await panel.refresh();expect(ctx.root.querySelector('select')).toBe(select);
 select.value='coat';select.dispatchEvent(new Event('change'));await vi.waitFor(()=>expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','framework','setAppearance',['raw',{outfit:'coat'}],{signal:ctx.signal}));
});

const report: OpenedFigure = {
  character: {kind:'figure-pack', origin:'figure-pack', id:'figure', sourceId:'figure', tasks:['wardrobe','framing']},
  name:'Figure', axes:[
    {id:'coat',name:{en:'Coat'},options:[{id:'plain',name:{en:'Plain'}},{id:'blue',name:{en:'Blue'}}]},
    {id:'pin',name:{en:'Pin'},options:[{id:'off',name:{en:'Off'}},{id:'star',name:{en:'Star'}}]},
  ], presets:[{id:'night',name:{en:'Night'},pick:{coat:'blue',pin:'star'}}],
  actions:[], current:'', active:true, worn:'plain-star', settings:{}, revision:'initial', draft:null,
};

function choose(root: HTMLElement, label: string, value: string) {
  const select = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

it('starts a custom outfit from the authored picks in a named preset', () => {
  const change = vi.fn();
  const picker = characterWardrobePicker(document, report, false, change);
  choose(picker.element, 'Choose an outfit', 'night');
  choose(picker.element, 'Choose an outfit', '__custom__');
  expect(picker.value()).toBe('night');
  expect(change).toHaveBeenCalledTimes(1);
  expect(picker.element.querySelector<HTMLSelectElement>('[aria-label="Pin"]')?.value).toBe('star');
  choose(picker.element, 'Coat', 'plain');
  expect(change).toHaveBeenLastCalledWith('plain-star');
});

function figureEditor() {
  const ctx = context();
  const controls = studioControls(ctx);
  const sendPreview = vi.fn<Parameters<typeof figureEditorView>[1]['sendPreview']>().mockResolvedValue({});
  const retainDraft = vi.fn();
  const invoke = vi.fn().mockResolvedValue({ saved:true, applied:false, settings:{}, revision:'saved' });
  const touch = {
    read: vi.fn(), value: () => undefined, element: document.createElement('section'),
    setPackageActions: vi.fn(), isDrawing: () => false, cancelDrawing: vi.fn(),
  } as unknown as Parameters<typeof figureEditorView>[1]['touch'];
  const view = figureEditorView(report, {
    button:controls.button, controls, touch, english:true, invoke, sendPreview, retainDraft,
    flushDraft:async () => {}, discardDraft:async () => {}, failure:vi.fn(), feedback:vi.fn(),
    previewReady:() => true, reloadPreview:vi.fn(), freezeCanvas:vi.fn(), selectTask:vi.fn(),
  });
  ctx.root.append(view.element);
  view.select('wardrobe');
  const button = (label: string) => Array.from(view.element.querySelectorAll('button')).find(item => item.textContent === label)!;
  return {view, button, sendPreview, retainDraft, invoke};
}

it('keeps trial outfits out of the draft until the latest preview has been confirmed', async () => {
  const { view, button, sendPreview, retainDraft, invoke } = figureEditor();
  let confirm: (result: Record<string, unknown>) => void = () => {};
  sendPreview.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  choose(view.element, 'Choose an outfit', 'night');
  choose(view.element, 'Choose an outfit', '__custom__');
  choose(view.element, 'Coat', 'plain');
  expect(sendPreview.mock.calls).toEqual([['figure-look', {scheme:'night'}]]);
  expect(button('Keep in draft').disabled).toBe(true);
  expect(retainDraft).not.toHaveBeenCalled();

  confirm({});
  await vi.waitFor(() => expect(button('Keep in draft').disabled).toBe(false));
  expect(sendPreview).toHaveBeenLastCalledWith('figure-look', {scheme:'plain-star'});
  button('Keep in draft').click();
  expect(retainDraft).toHaveBeenCalledExactlyOnceWith(['figure', {scheme:'plain-star'}, 'initial']);
  button('Save and apply').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith('character.saveFigure', ['figure', {
    scheme:'plain-star', touch:null, visual:null,
  }, 'initial']));
});

it('ends an unconfirmed try-on on leaving the outfit task and keeps the worn outfit on a color-only save', async () => {
  const { view, button, sendPreview, retainDraft, invoke } = figureEditor();
  sendPreview.mockRejectedValueOnce(Error('Texture missing'));
  choose(view.element, 'Choose an outfit', 'night');
  await vi.waitFor(() => expect(view.element.querySelector('.studio-figure-outfit-status')?.textContent).toContain('Texture missing'));
  expect(button('Keep in draft').disabled).toBe(true);
  expect(retainDraft).not.toHaveBeenCalled();
  view.select('framing');
  await vi.waitFor(() => expect(sendPreview).toHaveBeenLastCalledWith('figure-look', {scheme:''}));
  const hue = view.element.querySelector<HTMLInputElement>('input[type=range]')!;
  hue.value = '30';
  hue.dispatchEvent(new Event('input'));
  button('Save and apply').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith('character.saveFigure', ['figure', {
    touch:null, visual:{hue:30,brightness:1},
  }, 'initial']));
});
