import { invokePanel as invokeCorePanel, type RequestOptions } from '../../base/api.ts';
import type { PageContext } from '../../base/page.ts';
import type { ModelEditorState, ModelProfile, NativeBinding } from '../../../../framework/model-contract.ts';
import { mouthEditor, type MouthBehavior } from './mouth-editor.ts';
import { wardrobeEditor } from './wardrobe-editor.ts';
import { resourcePicker } from './resource-picker.ts';
import { expressionPicker } from './expressions.ts';
import { studioControls } from './controls.ts';
import type { ModelOperation } from '../../../../framework/model-domain.ts';
import { LANGUAGE } from '../../base/language.ts';
const PROVIDER = 'world:desktop-live2d-pet';
type FramingReport={supported:{preview:boolean;restore:boolean};status:string;requestId?:string;owner?:string;state?:{fit:unknown;active:boolean;reason?:string|null;geometry?:unknown}};
type EditorContract = {draft?: {revision: string; catalogFingerprint?: string; profile: ModelProfile} | null; active?:boolean;framing?:FramingReport|null;behavior?:{visual?:{hue:boolean;brightness:boolean};mouth?:MouthBehavior;gaze?:{supported:boolean;reason:string|null;settings:{enabled:boolean;speed:number}};motion?:{supported:boolean;compiledKind:string;effectiveKind:string;facing:string;reason:string|null};crop?:{supported:boolean;reason:string|null;settings:{mode:string;edge:string;line:number;curve:number;feather:number;transition:number}}}|null;figure:string;editor:ModelEditorState|null;fields:Array<{path:string;type:string;min?:number;max?:number;step?:number;default?:number|boolean|string;options?:string[]}>;operation:{saved:boolean;applied:boolean;phase:string;error:string|null}};
/** A consumer of the model domain contract, not an independent source/profile or renderer. */
export function modelEditor(ctx: PageContext, options: {
 externalNavigation?:boolean;
 invoke?: <T>(method: string, args?: unknown[], request?: RequestOptions) => Promise<T>;
 onDraft?: (args: unknown[]) => void;
 onRead?: (profile: ModelProfile, catalog: ModelEditorState['catalog']) => void;
 touch?: { element: HTMLElement; value(): ModelProfile['touch']; setBindings?(value: NativeBinding[]): void; isDrawing?(): boolean };
 preview?: (kind: string, input?: Record<string, unknown>) => Promise<Record<string, unknown> | void> | undefined;
 onInvalid?: (section: string) => void;
} = {}) {
 const invokePanel: typeof invokeCorePanel = (page, panel, method, args, request) =>
  options.invoke ? options.invoke(method, args, request) : invokeCorePanel(page, panel, method, args, request);
 const {root,signal,ui}=ctx,doc=root.ownerDocument,zh=LANGUAGE.startsWith('zh');
 const text=(cn:string,en:string)=>zh?cn:en;
 const c=studioControls(ctx);
 const call=<T>(method:string,args:unknown[]=[])=>invokePanel<T>(PROVIDER,'framework',method,args,{signal});
 const el=(tag:string,value='')=>{const n=doc.createElement(tag);n.textContent=value;return n;};
 const wardrobe=wardrobeEditor(ctx,(picks,candidate,label)=>void previewLook('wardrobe',picks,candidate,label)),mouth=mouthEditor(ctx);
 const panel=el('section'),fields=el('div'),cropFields=el('div'),behaviorFields=el('div'),bindings=el('div'),status=el('p');panel.className='framework-model-editor';panel.hidden=true;status.setAttribute('role','status');
 fields.className=cropFields.className=behaviorFields.className='framework-model-fields';
 const preview=ui.button(text('预览取景（不保存）','Preview framing (not saved)'),{size:'sm'}),revert=ui.button(text('还原预览','Revert preview'),{size:'sm'}),previewStatus=el('p');previewStatus.setAttribute('role','status');
 const save=c.node('button',text('保存并应用','Save and apply'),'studio-button is-primary');
 save.type='button';
 const reload=ui.button(options.onDraft?text('放弃修改','Discard edits'):text('重新读取','Reload'),{size:'sm'}),add=ui.button(text('添加原生动作绑定','Add native action binding'),{size:'sm'});
 const retry=c.button(text('重新应用已保存版本','Reapply saved version'),()=>void retryApply());retry.hidden=true;
 const tabs=el('nav'),workspace=el('div'),footer=el('footer'),draftState=el('span');tabs.className='framework-editor-tabs';tabs.setAttribute('aria-label',text('模型配置分类','Model sections'));workspace.className='framework-editor-workspace';footer.className='framework-editor-footer';draftState.className='framework-draft-state';
 const progress=doc.createElement('progress');progress.hidden=true;progress.setAttribute('aria-label',text('保存进度','Save progress'));
 const panes=new Map<string,HTMLElement>(),tabButtons=new Map<string,HTMLButtonElement>();
 for(const[id,cn,en]of [['framing','取景与裁切','Framing'],['bindings','动作与表情','Actions & expressions'],['wardrobe','装扮','Wardrobe'],['visual','模型配色','Model colors'],['behavior','身体行为','Behavior'],['mouth','口型','Mouth']]){
  const pane=el('section');pane.dataset.editorSection=id;pane.hidden=id!=='framing';pane.className='framework-editor-pane';panes.set(id,pane);workspace.append(pane);
  const button=ui.button(text(cn,en),{size:'sm'});button.setAttribute('aria-current',id==='framing'?'page':'false');tabButtons.set(id,button);tabs.append(button);
  button.addEventListener('click',()=>{for(const[key,node]of panes)node.hidden=key!==id;for(const[key,b]of tabButtons)b.setAttribute('aria-current',key===id?'page':'false');},{signal});
 }
 if (options.touch) {
  const pane=el('section');pane.dataset.editorSection='touch';pane.hidden=true;pane.className='framework-editor-pane';
  pane.append(options.touch.element);panes.set('touch',pane);workspace.append(pane);
 }
 const framingActions = el('div');framingActions.className='studio-inline studio-framing-actions';
 if(options.preview)framingActions.append(c.button(text('恢复已保存值','Restore saved values'),()=>restoreFramingValues()));
 else framingActions.append(preview,revert);
 previewStatus.className='studio-editor-note';
 const framingGroup=el('section'),cropGroup=el('section');
 framingGroup.className=cropGroup.className='studio-editor-group';
 const framingHeader=el('header');framingHeader.className='studio-editor-group-heading';
 framingHeader.append(el('h2',text('取景','Framing')),framingActions);
 framingGroup.append(framingHeader,fields,previewStatus);
 const cropStatus=el('p');cropStatus.className='studio-editor-note';
 cropGroup.append(el('h2',text('裁切','Crop')),cropFields,cropStatus);
 panes.get('framing')!.append(framingGroup,cropGroup);
 const bindingPicker=doc.createElement('select');
 const wordList=el('div');wordList.className='studio-binding-words';
 bindingPicker.setAttribute('aria-label',text('正在编辑的动作绑定','Binding to edit'));
 const bindingBar=el('div');bindingBar.className='studio-binding-bar';
 const bindingsHeading = el('h2', text('动作与表情', 'Actions and expressions'));
 bindingBar.append(bindingsHeading, add);
 const wordSearch=doc.createElement('input');
 wordSearch.type='search';
 wordSearch.className='studio-binding-search';
 wordSearch.placeholder=text('搜索动作或表情','Search actions or expressions');
 wordSearch.setAttribute('aria-label',wordSearch.placeholder);
 wordSearch.hidden=!options.preview;
 const noWords=el('p',text('没有找到匹配的动作或表情。','No matching actions or expressions.'));
 noWords.hidden=true;
 noWords.className='studio-editor-note';
 const emptyBindings=el('p',options.preview?text('选择上方的动作或表情，即可试播和绑定资源。','Choose an action or expression above to preview and bind resources.'):text('还没有动作绑定。添加一个动作词即可配置主资源和叠加表情。','Add an action binding to choose a main resource and expression overlays.'));
 emptyBindings.className='studio-editor-note';
 panes.get('bindings')!.append(bindingBar,bindingPicker,wordSearch,wordList,noWords,emptyBindings,bindings);
 bindingBar.querySelector('button')!.hidden=!!options.preview;
 bindingPicker.addEventListener('change',()=>showBinding(Number(bindingPicker.value)),{signal});
 function filterWords(){
  const search=wordSearch.value.trim().toLowerCase();
  let matches=0;
  for(const entry of wordList.querySelectorAll<HTMLButtonElement>('button')){
   entry.hidden=!(entry.dataset.word??'').toLowerCase().includes(search)&&!(entry.dataset.wordTitle??'').toLowerCase().includes(search);
   if(!entry.hidden)matches++;
  }
  noWords.hidden=matches!==0;
  emptyBindings.hidden=!!rows.length||!noWords.hidden;
 }
 wordSearch.addEventListener('input',filterWords,{signal});
 const visualFields=el('div');visualFields.className='framework-model-fields';
 const visualHint=el('p');visualHint.className='studio-editor-note';
 const visualCommands=el('div');visualCommands.className='studio-inline';
 visualCommands.append(c.button(text('预览配色','Preview colors'),()=>void previewLook('visual'),true),c.button(text('还原配色','Restore colors'),()=>releaseDraft(true)));
 const visualGroup=options.externalNavigation?el('section'):panes.get('visual')!;
 if(options.externalNavigation){
  visualGroup.className='studio-editor-group';
  panes.get('framing')!.append(visualGroup);
 }
 visualGroup.append(el('h2',text('模型配色','Model colors')),visualHint,visualFields,visualCommands);
 panes.get('wardrobe')!.append(wardrobe.element,c.button(text('结束试穿','End try-on'),()=>void restoreLook()));panes.get('behavior')!.append(el('h2',text('移动与注视','Movement and gaze')),behaviorFields);panes.get('mouth')!.append(mouth.element, c.button(text('测试口型','Test mouth movement'),()=>void mouthPulse()),c.button(text('结束测试','End test'),()=>void mouthPulse('release')));
 async function mouthPulse(kind:'pulse'|'release'='pulse'){
  if(!current?.editor||kind==='pulse'&&!mouth.valid())return;
  try{
   const local=options.preview?.('mouth',{command:{kind},mapping:kind==='pulse'?mouth.value():null});
   if(local)await local;
   else await call('previewMouth',[current.figure,kind]);
   status.textContent=kind==='pulse'?text('已触发口型测试','Mouth test started'):text('口型已恢复','Mouth restored');
  }catch(error){status.textContent=String(error);}
 }
 let section='framing';
 function selectSection(id:string){
  if(!panes.has(id))return;
  if(id!==section){
   if(options.preview){releaseDraft();actionRequest=undefined;if(section==='wardrobe'){outfitPicks={};outfitResources={};}void options.preview('release-task',{task:section})?.catch(()=>{});}
   else deactivate();
   section=id;status.textContent='';
  }
  for(const[key,node]of panes)node.hidden=key!==id;
  for(const[key,b]of tabButtons)b.setAttribute('aria-current',key===id?'page':'false');
  if(id==='touch')options.touch?.setBindings?.(rows.map(row=>row.value()));
 }
 if(options.externalNavigation){tabs.hidden=true;panel.classList.add('framework-editor-external');}
 status.className='studio-editor-save-status';
 status.tabIndex=0;
 const saveNotice=options.onDraft?el('p'):status;
 if(saveNotice!==status){
  saveNotice.className='studio-editor-save-notice';
  saveNotice.setAttribute('role','status');
  draftState.setAttribute('role','status');
 }
 const footerActions=el('div');footerActions.className='framework-editor-actions';footerActions.append(draftState,reload,retry,save);
 footer.append(progress,status);
 if(saveNotice!==status)footer.append(saveNotice);
 footer.append(footerActions);panel.append(tabs,workspace,footer);
 let dirty=false,loaded=false,stale=false,loadFailure:string|null=null,reading:Promise<void>|null=null;
 function saveButtons(){
  save.disabled=busy||stale||!current?.editor||Boolean(options.onDraft&&!dirty);
  reload.disabled=busy||Boolean(options.onDraft&&!dirty&&!stale);
  reload.textContent=options.onDraft&&!stale?text('放弃修改','Discard edits'):text('重新读取','Reload');
  retry.hidden=!retryRevision||Boolean(options.onDraft&&dirty);
  retry.disabled=busy||stale;
 }
 function markDirty(event?:Event){
  const target=event?.target as HTMLInputElement|HTMLSelectElement|undefined;
  if(busy||stale||target===bindingPicker||target?.type==='search'||target?.dataset.previewMode)return;
  dirty=true;
  draftState.textContent=text('有未保存的修改','Unsaved changes');
  if(options.onDraft)saveNotice.textContent='';
  saveButtons();
  if(current?.editor)options.onDraft?.([current.figure,readDraft(),current.editor.revision,current.editor.catalogFingerprint]);
 }
 panel.addEventListener('input',markDirty,{signal});panel.addEventListener('change',markDirty,{signal});
 wardrobe.element.addEventListener('click',event=>{const button=(event.target as Element).closest('button');if(button?.dataset.draftChange==='true')markDirty();},{signal});
 const discard=doc.createElement('dialog');discard.className='framework-dialog';discard.setAttribute('aria-label',text('未保存的修改','Unsaved changes'));
 const keep=ui.button(text('继续编辑','Keep editing'),{size:'sm'}),discardButton=ui.button(text('放弃修改并继续','Discard and continue'),{size:'sm'});discard.append(el('h2',text('还有未保存的修改','Unsaved changes')),el('p',options.onDraft?text('放弃当前角色的草稿并回到上一次保存的配置。','Discard this character’s draft and return to the last saved settings.'):text('切换模型或重新读取会替换当前草稿。','Changing models or reloading replaces this draft.')),keep,discardButton);(options.externalNavigation?root:panel).append(discard);
 let resolveDiscard:((value:boolean)=>void)|null=null;
 function settleDiscard(value:boolean){if(discard.open)discard.close();workspace.inert=false;footer.inert=false;resolveDiscard?.(value);resolveDiscard=null;}
 keep.addEventListener('click',()=>settleDiscard(false),{signal});discardButton.addEventListener('click',()=>settleDiscard(true),{signal});discard.addEventListener('cancel',event=>{event.preventDefault();settleDiscard(false);},{signal});
 async function confirmDiscard(){if(busy)return false;if(!dirty)return true;if(resolveDiscard)return false;const active=panel.closest('dialog[open]');if(active){active.append(discard);discard.dataset.inline='true';discard.setAttribute('open','');workspace.inert=true;footer.inert=true;keep.focus();}else{delete discard.dataset.inline;discard.showModal();}return new Promise<boolean>(resolve=>{resolveDiscard=resolve;});}
 signal.addEventListener('abort',()=>{resolveDiscard?.(false);resolveDiscard=null;if(discard.open)discard.close();},{once:true});
 let targetFigure:string|undefined;
 let current:EditorContract|null=null,busy=false,previewBusy=false,previewFigure:string|null=null,previewSerial=0,readinessSerial=0;
 const previewOwner=crypto.randomUUID();let submission:Promise<unknown>|null=null;
 let committed: ModelProfile | undefined;
 let framingTimer: ReturnType<typeof setTimeout> | undefined;
 function scheduleFraming(){
  if(!options.preview||signal.aborted)return;
  clearTimeout(framingTimer);
  framingTimer=setTimeout(()=>void framingCommand('preview'),80);
 }
 function cropControls(){
  const upper=fieldInputs.get('crop.mode')?.value==='upper';
  const round=fieldInputs.get('crop.edge')?.value==='round';
  for(const id of ['edge','line','curve','feather','transition']){
   const label=fieldInputs.get('crop.'+id)?.closest('label');
   if(label)label.hidden=!upper||id==='curve'&&!round;
  }
 }
 function restoreFramingValues(){
  if(!committed)return;
  for(const field of draftFields().concat(visualSchema)){
   if(!/^(fit|crop|visual)\./.test(field.path))continue;
   const input=fieldInputs.get(field.path),value=at(committed,field.path)??field.default;
   if(input&&value!==undefined){input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:false}));}
  }
  cropControls();
  markDirty();
  scheduleFraming();
  void previewLook('visual');
 }
 function previewControls(){const local=!!options.preview&&!!current?.editor;preview.disabled=stale||busy||previewBusy||!local&&(current?.framing?.supported.preview!==true||current?.framing?.state?.reason==='not-ready');revert.disabled=stale||busy||previewBusy||!local&&current?.framing?.supported.restore!==true;}
 function deactivate(){clearTimeout(framingTimer);void options.preview?.('restore')?.catch(()=>{});readinessSerial++; releaseDraft();const figure=previewFigure;if(!figure)return;previewFigure=null;previewSerial++;
  const wait=submission??Promise.resolve();void wait.catch(()=>{}).then(()=>invokePanel(PROVIDER,'framework','previewFraming',[figure,{kind:'restore'},previewOwner],{keepalive:true})).catch(()=>{});
 }
 signal.addEventListener('abort',deactivate,{once:true});
 async function waitForFraming(figure:string,token:number){
  previewStatus.textContent=text('身体取景几何尚未就绪，正在等待实际报告。','Body framing geometry is not ready; waiting for its report.');
  try{for(let i=0;i<20;i++){
   await new Promise(resolve=>setTimeout(resolve,250));
   if(signal.aborted||token!==readinessSerial||current?.figure!==figure||previewBusy)return;
   const report=await invokePanel<FramingReport|null>(PROVIDER,'framework','framing',[figure],{signal});
   if(signal.aborted||token!==readinessSerial||current?.figure!==figure||previewBusy)return;
   if(!report)continue;current.framing=report;previewControls();
   if(report.state?.reason!=='not-ready'){
    previewStatus.textContent=report.supported.preview?text('身体取景几何已就绪，可临时预览；表单未改动。','Body framing geometry is ready for temporary preview; form edits are unchanged.'):text('当前身体未报告取景预览支持。','The current body has not reported framing preview support.');return;
   }
  }
  if(!signal.aborted&&token===readinessSerial)previewStatus.textContent=text('取景几何仍未就绪，预览保持禁用；可稍后重新读取。','Framing geometry is still not ready; preview remains disabled. Reload later to check again.');
  }catch(error){if(!signal.aborted&&token===readinessSerial)previewStatus.textContent=String(error);}
 }
 async function framingCommand(kind:'preview'|'restore'){
  if(options.preview && current?.editor && !busy && !signal.aborted) {
   const serial=++previewSerial, {fit}=readDraft();
   const crop=Object.fromEntries([...fieldInputs].filter(([id])=>id.startsWith('crop.')).map(([id,node])=>[id.slice(5),node.tagName==='SELECT'?node.value:Number(node.value)]));
   try{
    const receipt=await options.preview('framing',{command:kind==='preview'?{kind,fit,...(Object.keys(crop).length?{crop}:{})}:{kind}});
    if(serial===previewSerial && receipt && !receipt.cancelled)previewStatus.textContent=text('当前画布 · 随草稿更新','Canvas follows the draft');
   }catch(error){if(serial===previewSerial && !signal.aborted)previewStatus.textContent=String(error);}
   return;
  }
  if(busy||previewBusy||!current?.editor||(kind==='preview'&&!options.preview&&current.framing?.state?.reason==='not-ready'))return;
  readinessSerial++;
  const figure=current.figure,serial=++previewSerial;
  const fit=structuredClone(current.editor.profile.fit);
  if(kind==='preview')for(const[path,input]of fieldInputs){if(!path.startsWith('fit.'))continue;if(!input.reportValidity()||input.value==='')return;put({fit},path,Number(input.value));}
  previewFigure=figure;previewBusy=true;previewControls();previewStatus.textContent=text('正在发送临时取景请求，尚未确认应用。','Sending temporary framing request; application is not yet confirmed.');
  try{
   const local=options.preview?.('framing',{command:kind==='preview'?{kind,fit}:{kind}});
   if(local){await local;previewFigure=null;previewStatus.textContent=kind==='preview'?text('取景预览已应用','Framing preview applied'):text('已还原取景','Framing restored');return;}
   // Do not abort a mutation on page close: cleanup waits for dispatch, then restores this owner's preview.
   submission=invokePanel<{requestId?:string}>(PROVIDER,'framework','previewFraming',[figure,kind==='preview'?{kind,fit}:{kind},previewOwner],{keepalive:true});
   const dispatched=await submission as {requestId?:string};submission=null;
   if(signal.aborted||serial!==previewSerial)return;
   previewStatus.textContent=text('请求已发送；等待身体实际回执，未写入源配置。','Request dispatched; waiting for the body receipt. Source configuration is unchanged.');
   for(let i=0;i<20;i++){
    const report=await invokePanel<FramingReport|null>(PROVIDER,'framework','framing',[figure],{signal});
    if(signal.aborted||serial!==previewSerial||current?.figure!==figure)return;
    if(report&&report.owner===previewOwner&&(!dispatched.requestId||report.requestId===dispatched.requestId)){
     current.framing=report;
     if(!['pending','unknown','reported'].includes(report.status)){
      previewStatus.textContent=text('身体回执：','Body receipt: ')+report.status+' · '+(report.state?.active?text('临时预览，尚未保存','Temporary preview, not saved'):text('非预览状态；表单内容未改动','Not previewing; form edits are unchanged'));
      if(report.status==='applied'&&!report.state?.active)previewFigure=null;return;
     }
    }
    await new Promise(resolve=>setTimeout(resolve,250));
   }
   previewStatus.textContent=text('暂未收到匹配的身体回执，不能确认应用；源配置未保存。','No matching body receipt yet; application is unconfirmed. Source configuration was not saved.');
  }catch(error){if(!signal.aborted&&serial===previewSerial)previewStatus.textContent=String(error);}
  finally{submission=null;previewBusy=false;if(!signal.aborted)previewControls();}
 }
 preview.addEventListener('click',()=>void framingCommand('preview'),{signal});revert.addEventListener('click',()=>void framingCommand('restore'),{signal});
 const fieldInputs=new Map<string,HTMLInputElement|HTMLSelectElement>(),dirtyFields=new Set<string>();
 const rows:Array<{node:HTMLElement;value:()=>NativeBinding;dispose:()=>void;label:()=>string}>=[];
 let visibleBinding=0;
 function showBinding(index=visibleBinding){
  visibleBinding=Math.max(0,Math.min(index,rows.length-1));
  bindingPicker.hidden=!!options.preview||!rows.length;emptyBindings.hidden=!!rows.length;
  bindingPicker.replaceChildren(...rows.map((item,i)=>{const option=el('option',item.label()) as HTMLOptionElement;option.value=String(i);return option;}));
  bindingPicker.value=String(visibleBinding);
  rows.forEach((item,i)=>{item.node.hidden=i!==visibleBinding;});
  if(options.preview){
   const catalog=current?.editor?.catalog;
   const named=[...new Set([...(catalog?.words.expressions??[]),...(catalog?.words.motions??[]),...rows.map(item=>item.value().word)])];
   const selected=rows[visibleBinding]?.value().word;
   const scroll=wordList.scrollTop;
   wordSearch.hidden=named.length===0;
   wordList.replaceChildren(...named.map(word=>{
    const at=rows.findIndex(item=>item.value().word===word);
    const binding=rows[at]?.value();
    const missing=binding?.resource&&[binding.resource,...(binding.overlays??[]),...(binding.release?[binding.release]:[])].some(id=>!catalog?.resources.some(r=>r.id===id));
    const state=missing?text('有失效项','Missing resource'):binding?.resource?text('已绑定','Bound'):text('通用','Generic');
    const button=c.button(wordTitle(word),()=>{
     if(at===-1){row({word});showBinding(rows.length-1);}else showBinding(at);
     [...wordList.querySelectorAll<HTMLElement>('button')].find(node=>node.dataset.word===word)?.focus({preventScroll:true});
    });
    button.dataset.word=word;button.dataset.wordTitle=wordTitle(word);button.dataset.bindingState=missing?'missing':binding?.resource?'bound':'default';
    button.append(el('small',state));button.setAttribute('aria-pressed',String(word===selected));return button;
   }));
   filterWords();
   wordList.scrollTop=scroll;
  }
 }
 let activePreview: { figure: string; owner: string } | null = null;
 let previewTask: Promise<unknown> | null = null;
 let editEpoch=0;
 let retryRevision: { figure: string; revision: string } | null = null;
 const visualSchema:EditorContract['fields']=[{path:'visual.hue',type:'number',min:-180,max:180,step:1,default:0},{path:'visual.brightness',type:'number',min:.5,max:1.5,step:.01,default:1}];
 const visualReady=()=>options.invoke||current?.active===false?!!current?.editor:current?.behavior?.visual?.hue===true&&current.behavior.visual.brightness===true;
 const draftFields=()=>[...(current?.fields??[]),...visualSchema.filter(field=>fieldInputs.has(field.path))];
 const labels:Record<string,[string,string]>={'visual.hue':['色相（°）','Hue (°)'],'visual.brightness':['亮度','Brightness'],'crop.mode':['默认裁切','Default crop'],'crop.edge':['边缘形状','Edge shape'],'crop.line':['裁切线位置','Crop line position'],'crop.curve':['边缘弧度','Edge curve'],'crop.feather':['边缘羽化','Edge feather'],'crop.transition':['过渡时长','Transition duration'],'motion.kind':['自主移动策略','Autonomous movement policy'],'facing':['站定时的朝向','Facing while standing'],'gaze.enabled':['眼睛跟随光标','Eye cursor tracking'],'gaze.speed':['眼睛跟随速度','Eye cursor tracking speed'],'fit.zoom':['缩放','Zoom'],'fit.offset.0':['水平偏移','Horizontal offset'],'fit.offset.1':['垂直偏移','Vertical offset'],'fit.padding.0':['水平留白','Horizontal padding'],'fit.padding.1':['垂直留白','Vertical padding']};
 const at=(v:any,path:string)=>path.split('.').reduce((x,k)=>x?.[k],v);
 function put(v:any,path:string,value:number|boolean|string){const keys=path.split('.'),last=keys.pop()!;keys.reduce((x,k)=>(x[k]??={}),v)[last]=value;}
 function select(options:Array<[string,string]>,value=''){const s=doc.createElement('select');for(const[id,label]of options){const o=doc.createElement('option');o.value=id;o.textContent=label;s.append(o);}if(value&&!options.some(([id])=>id===value)){const o=doc.createElement('option');o.value=value;o.textContent=text('失效资源，需明确替换：','Missing resource, replace explicitly: ')+value;s.append(o);}s.value=value;return s;}
 const wordNames:Record<string,string>={neutral:'平静',happy:'开心',wink:'眨眼',love:'喜欢',shy:'害羞',surprised:'惊讶',angry:'生气',sad:'难过',sleepy:'困倦',thinking:'思考',smug:'得意',pout:'嘟嘴',worried:'担心',determined:'坚定',flustered:'慌张',scared:'害怕',excited:'兴奋',cry:'哭',confused:'困惑',nod:'点头',shake:'摇头',wave:'挥手',bow:'鞠躬',dance:'跳舞',cheer:'欢呼'};
 const wordTitle=(word:string)=>zh?wordNames[word]??word:word;
 function row(original:Partial<NativeBinding>={}){
  const editor=current?.editor;if(!editor)return;
  const catalog=editor.catalog?.resources??[],words=[...(editor.catalog?.words.expressions??[]),...(editor.catalog?.words.motions??[])];
  const node=el('fieldset');node.className='framework-binding';const word=select(words.map(w=>[w,zh?(wordNames[w]??w):w]),original.word??words[0]);
  const candidates=catalog.filter(r=>r.classification!=='appearance');
  const resource=select([['',text('选择资源','Select resource')],...candidates.map(r=>[r.id,r.title+' · '+text(r.kind==='expression'?'表情':'动画',r.kind)] as [string,string])],original.resource??'');
  const release=select([['',text('无复位动作','No release motion')],...candidates.filter(r=>r.kind==='motion').map(r=>[r.id,r.title] as [string,string])],original.release??'');
  const nativeOnly=doc.createElement('input');nativeOnly.type='checkbox';nativeOnly.checked=original.nativeOnly===true;
  nativeOnly.setAttribute('role', 'switch');
  const nativeLabel=c.field(text('正式播放时完全使用原生动画','Use native animation only after saving'), nativeOnly,
   text('保存后，动画接管它写入的参数。','After saving, the animation takes over the parameters it writes.'));
  nativeLabel.classList.add('studio-binding-policy');
  const remove=c.button(text('移除绑定','Remove binding'),()=>{picker.dispose();rows.splice(rows.indexOf(item),1);node.remove();showBinding();markDirty();});
  const previewMode=select([['full',text('完整预览','Full preview')],['native',text('仅原生预览','Native-only preview')]],'full');
  previewMode.dataset.previewMode='true';previewMode.setAttribute('aria-label',text('本次试播方式','Preview mode'));
  const play=c.button(text('试播当前组合','Play this combination'),()=>void runDraft(item.value(),previewMode.value),true);
  const stop=c.button(text('停止试播','Stop preview'),()=>void stopAction());
  const picker=expressionPicker(ctx,{resources:catalog,initial:original.overlays??[],current:()=>item.value(),
   change:()=>markDirty(),audition:id=>runDraft({...item.value(),resource:id,overlays:[],release:undefined},'native',true)});
  const controls=el('div');controls.className='studio-inline framework-binding-commands';
  controls.append(previewMode,play,c.button(text('重播','Replay'),()=>void runDraft(item.value(),previewMode.value)),stop);
  remove.classList.add('studio-binding-remove');
  for(const[title,control]of [[text('动作词','Action word'),word],[text('主资源','Main resource'),resource],[text('结束后复位','Release motion'),release]] as const){
   if(control!==word&&options.preview){
    const label=el('div');label.className='studio-binding-resource';label.append(el('span',title),control);
    const choices=control===release?candidates.filter(r=>r.kind==='motion'):candidates;
    label.append(resourcePicker(ctx,control,[{id:'',title:control.options[0].textContent??'',kind:''},...choices],
      id=>void runDraft({...item.value(),resource:id,overlays:[],release:undefined},'native')));
    node.append(label);
   }else{
    const label=el('label',title);label.append(control);node.append(label);
   }
  }
  node.append(nativeLabel, controls, picker.element, remove);
  bindings.append(node);
  const item={node,dispose:picker.dispose,label:()=>word.selectedOptions[0]?.textContent||word.value,value:()=>({...original,word:word.value,resource:resource.value,release:release.value||undefined,nativeOnly:nativeOnly.checked,overlays:picker.values()}) as NativeBinding};
  rows.push(item);
  word.addEventListener('change',()=>showBinding(),{signal});
  resource.addEventListener('change',()=>{picker.render();if(options.preview)showBinding();},{signal});
 }
 function releaseDraft(feedback=false){
  editEpoch++;
  if(feedback)void options.preview?.('restore')?.catch(error=>{status.textContent=String(error);});
  const active=activePreview;activePreview=null;
  if(!active)return;
  void Promise.resolve(previewTask).catch(()=>{}).then(()=>invokePanel(PROVIDER,'framework','edit.release',[active.owner],{keepalive:true}))
   .then(()=>{if(feedback&&!signal.aborted)status.textContent=text('已还原预览。','Preview restored.');})
   .catch(error=>{if(feedback&&!signal.aborted)status.textContent=String(error);});
 }
 let actionRequest: string | undefined;
 let lastActionState: {id:string; status:string} | undefined;
 function actionState(id:string, state:string) {
  lastActionState={id,status:state};
  if(id!==actionRequest || signal.aborted)return;
  if(state==='finished')status.textContent=text('试播结束','Preview finished');
  else if(state==='stopped')status.textContent=text('试播已停止','Preview stopped');
 }
 async function stopAction(){
  const epoch=++editEpoch;
  actionRequest=undefined;
  if(!options.preview){releaseDraft(true);return;}
  try{await options.preview('action',{command:{kind:'stop',owner:'editor'}});if(epoch===editEpoch)status.textContent=text('试播已停止','Preview stopped');}
  catch(error){if(!signal.aborted&&epoch===editEpoch)status.textContent=String(error);}
 }
 async function runDraft(binding:NativeBinding,mode:string,single=false){
  if(busy||stale||!current?.editor||!binding.resource||!options.preview&&previewTask)return;
  const figure=current.figure, epoch=++editEpoch;
  actionRequest=undefined;
  const task=(async()=>{
   status.textContent=text('正在准备试播…','Preparing preview…');
   if(options.preview){
    const receipt=await options.preview('action',{command:{kind:'play',owner:'editor',binding,mode}});
    if(epoch!==editEpoch||signal.aborted||receipt?.cancelled)return;
    actionRequest=typeof receipt?.id==='string'?receipt.id:undefined;
    status.textContent=text('正在试播','Preview playing');
    if(actionRequest && lastActionState?.id===actionRequest)actionState(actionRequest,lastActionState.status);
    return;
   }
   const profile=readDraft();
   if(single)profile.bindings=[...(profile.bindings??[]).filter(item=>item.word!==binding.word),{word:binding.word,resource:binding.resource,nativeOnly:false}];
   const session=await openPreview(figure,epoch);
   if(!session)return;
   const check=await c.call<{compatible:boolean;conflict?:{parameter:string;incoming:{title:string};existing:{title:string}}}>('edit.inspectConflict',[session.id,profile]);
   if(!check.compatible&&check.conflict){const {parameter,incoming,existing}=check.conflict;throw Error(incoming.title+' / '+existing.title+' · '+parameter);}
   if(activePreview?.owner!==session.id)return;
   await call('edit.validate',[session.id,profile]);
   if(activePreview?.owner!==session.id)return;
   if(current?.active!==false) await call('edit.previewAction',[session.id,binding.word,mode]);
   else throw Error(text('预览正在加载。','The preview is still loading.'));
   if(activePreview?.owner===session.id)status.textContent=text('桌宠正在试播。','The pet is playing the preview.');
  })();
  previewTask=task;
  try{await task;}catch(error){if(!signal.aborted&&epoch===editEpoch)status.textContent=error instanceof Error?error.message:String(error);if(single&&epoch===editEpoch)throw error;}
  finally{if(previewTask===task)previewTask=null;}
 }
 async function openPreview(figure:string,epoch:number){
   const {session}=await c.call<{session:{id:string;figure:string;revision:string}}>('edit.open',targetFigure?[targetFigure]:[]);
   if(current?.figure!==figure||session.figure!==figure||session.revision!==current.editor?.revision)throw Error(text('模型配置已变化，请重新读取。','Model settings changed. Reload the editor.'));
   if(epoch!==editEpoch||signal.aborted){await invokePanel(PROVIDER,'framework','edit.release',[session.id],{keepalive:true});return null;}
   activePreview={figure,owner:session.id};
   return session;
 }
 let outfitPicks:Record<string,string>={};
 let outfitResources:Record<string,{group:string;option:string;resource:string}>={};
 async function previewLook(kind:'visual'|'wardrobe',picks?:Record<string,string>,candidate?:{group:string;option:string;resource:string},label?:string){
  if(busy||stale||!options.preview&&previewTask||!current?.editor||kind==='visual'&&!visualReady())return;
  const figure=current.figure,epoch=++editEpoch;
  const task=(async()=>{
   status.textContent=text('正在准备预览…','Preparing preview…');
   const profile=readDraft();
   if(kind==='visual')profile.visual??={hue:0,brightness:1};
   const mergedPicks={...outfitPicks,...picks};
   const candidateResources=candidate?{...outfitResources,[candidate.group]:candidate}:outfitResources;
   const validResources=new Set(current?.editor?.catalog?.resources.filter(r=>!r.wardrobeError).map(r=>r.id));
   const groups=profile.wardrobe?.map(group=>({...group,options:group.options.map(option=>{
    const trial=candidateResources[group.id];return trial?.option===option.id?{...option,resource:trial.resource}:option;
   }).filter(option=>option.name.trim()&&validResources.has(option.resource))})).filter(group=>group.name.trim()&&group.options.length);
   const local=options.preview?.(kind,kind==='visual'?{value:profile.visual}:{command:{kind:'preview',owner:'editor',groups,bindings:committed?.bindings,picks:mergedPicks}});
   if(local){const report=await local;if(epoch===editEpoch&&!report?.cancelled){
    if(kind==='wardrobe'){outfitPicks=mergedPicks;outfitResources=candidateResources;}
    status.textContent=kind==='wardrobe'?text('正在试穿：','Trying on: ')+(label??text('草稿装扮','Draft outfit')):text('配色预览已应用。','Color preview applied.');
   }return;}
   const session=await openPreview(figure,epoch);
   if(!session)return;
   await call('edit.validate',[session.id,profile]);
   if(epoch!==editEpoch)return;
   if(current?.active===false)throw Error(text('预览正在加载。','The preview is still loading.'));
   const receipt=await c.call<{requestId?:string}>(kind==='visual'?'edit.previewVisual':'edit.previewDraftWardrobe',kind==='visual'?[session.id]:[session.id,picks]);
   if(epoch!==editEpoch)return;
   status.textContent=text('正在等待桌宠确认…','Waiting for the pet…');
   for(let i=0;i<12;i++){
    if(signal.aborted||epoch!==editEpoch)return;
    const snapshot=await c.call<{framework:{runtime?:{domains:{body?:Record<string,{owner?:string;request?:string;status?:string;error?:string;reason?:string}>}}}}>('runtime.state');
    const report=snapshot.framework.runtime?.domains.body?.[kind==='visual'?'visualPreview':'wardrobeDraft'];
    if(signal.aborted||epoch!==editEpoch)return;
    if(report?.owner===session.id&&(!receipt.requestId||report.request===receipt.requestId)){
     if(report.status==='applied'){status.textContent=text('预览已应用。','Preview applied.');return;}
     if(report.status==='failed')throw Error(report.error??report.reason??text('预览失败','Preview failed'));
    }
    await new Promise(resolve=>setTimeout(resolve,250));
   }
   if(epoch===editEpoch)status.textContent=text('尚未收到预览回执，可重试或还原。','Preview unconfirmed. Retry or restore.');
  })();
  previewTask=task;
  try{await task;}catch(error){if(!signal.aborted&&epoch===editEpoch)status.textContent=error instanceof Error?error.message:String(error);}
  finally{if(previewTask===task)previewTask=null;}
 }
 async function restoreLook(){
  outfitPicks={};outfitResources={};
  if(!options.preview){releaseDraft(true);return;}
  try{await options.preview('release-task',{task:'wardrobe'});status.textContent=text('已恢复当前穿戴','Current outfit restored');}
  catch(error){if(!signal.aborted)status.textContent=String(error);}
 }
 async function retryApply(){
  if(busy||stale||!retryRevision||options.onDraft&&dirty)return;
  const target=retryRevision;
  busy=true;workspace.inert=true;saveButtons();
  progress.hidden=false;saveNotice.textContent=text('正在重新应用已保存版本…','Reapplying saved version…');
  try{
   const result=await call<ModelOperation>('applySavedModel',[target.figure,target.revision]);
   if(signal.aborted)return;
   if(result.applied)retryRevision=null;
   saveNotice.textContent=result.applied?text('已应用已保存的版本。','The saved version is applied.')
    :result.error??text('配置已保存，使用该角色时生效。','Saved. Settings apply when you use this character.');
  }catch(error){if(!signal.aborted)saveNotice.textContent=String(error);}
  finally{busy=false;workspace.inert=false;saveButtons();progress.hidden=true;}
 }
 async function read(preserveDraft=false){
  if(signal.aborted||busy)return;
  try{
   const result=await invokePanel<EditorContract>(PROVIDER,'framework','modelEditor',targetFigure?[targetFigure]:[],{signal});if(signal.aborted)return;
   if(preserveDraft&&dirty)return;
   const previousWord=current?.figure===result.figure?rows[visibleBinding]?.value().word:undefined;
   if(current&&current.figure!==result.figure){deactivate();wordSearch.value='';}
   current=result;retryRevision=null;loadFailure=null;loaded=true;dirty=false;stale=false;draftState.textContent=options.onDraft?text('已载入保存的配置','Saved settings loaded'):text('修改统一保存','Save edits together');readinessSerial++;previewControls();panel.hidden=!result.editor;if(!result.editor){saveButtons();return;}
   committed=structuredClone(result.editor.profile);
   const olderDraft=result.draft && (result.draft.revision !== result.editor.revision || result.draft.catalogFingerprint !== result.editor.catalogFingerprint);
   if(result.draft?.profile?.fit) {
    result.editor.profile = result.draft.profile;
    dirty=true;draftState.textContent=text('已恢复草稿','Draft restored');
   }
   options.onRead?.(result.editor.profile,result.editor.catalog);
   if(!previewFigure)previewStatus.textContent='';
   fields.replaceChildren();cropFields.replaceChildren();behaviorFields.replaceChildren();visualFields.replaceChildren();fieldInputs.clear();dirtyFields.clear();for(const item of rows)item.dispose();bindings.replaceChildren();rows.length=0;
   const optionLabels:Record<string,[string,string]>={full:['全身','Full body'],upper:['上半身','Upper body'],flat:['平直','Flat'],round:['圆弧','Round'],roam:['跟随宿主漫游策略','Inherit host roaming'],stand:['关闭自主漫游','Disable autonomous roaming'],fixed:['固定朝向','Fixed facing'],mirror:['镜像朝向','Mirrored facing']};
   const canColor=visualReady();
   save.textContent=result.active===false?text('保存配置','Save settings'):text('保存并应用','Save and apply');
   visualHint.textContent=canColor?text('调整当前模型的色相和亮度。','Adjust the current model’s hue and brightness.'):text('显示 Live2D 后可检查模型是否支持配色。','Show Live2D to check whether this model supports colors.');
   visualHint.hidden=!!options.preview&&canColor;
   visualCommands.hidden=!canColor||!!options.preview;
   for(const field of [...result.fields,...(canColor?visualSchema:[])]){
    if(!['number','boolean','enum'].includes(field.type))continue;
    const pair=labels[field.path]??[field.path,field.path],label=el('label');
    label.append(el('span',text(...pair)));
    const input=field.type==='enum'?doc.createElement('select'):doc.createElement('input');input.dataset.field=field.path;
    const value=at(result.editor.profile,field.path)??field.default;
    let widget: HTMLElement=input;
    if(input.tagName==='SELECT'){
     const options=field.options??[];for(const id of options){const o=doc.createElement('option');o.value=id;const names=optionLabels[id];o.textContent=names?text(...names):id;input.append(o);}
     if(value!==undefined&&!options.includes(String(value))){const o=doc.createElement('option');o.value=String(value);o.textContent=text('不再支持的值：','Unsupported saved value: ')+value;input.append(o);}
     input.value=value===undefined?'':String(value);input.required=true;
    }else{
     const control=input as HTMLInputElement;control.type=field.type==='boolean'?'checkbox':'number';
     if(field.type==='boolean'){
      control.checked=value===true;
      control.setAttribute('role','switch');
     }else if(typeof value==='number'&&field.min!==undefined&&field.max!==undefined&&value>=field.min&&value<=field.max){
      const ticks=field.step ? (value-field.min)/field.step : NaN;
      const step=field.step && Math.abs(ticks-Math.round(ticks))<1e-7 ? String(field.step) : 'any';
      const unit=field.path==='visual.hue'?'°':field.path==='crop.transition'?' s':/^(fit.zoom|gaze.speed|visual.brightness)$/.test(field.path)?'×':'';
      const slider=c.range(control,field.min,field.max,step,v=>v+unit);
      control.value=String(value);slider.sync();widget=slider.element;
     }else{
      if(field.min!==undefined)control.min=String(field.min);
      if(field.max!==undefined)control.max=String(field.max);
      if(field.step!==undefined)control.step=String(field.step);
      control.value=value===undefined?'':String(value);
     }
    }
    input.addEventListener('change',()=>dirtyFields.add(field.path),{signal});
    if(options.preview){
     if(/^(fit|crop)\./.test(field.path))input.addEventListener('input',()=>{cropControls();scheduleFraming();},{signal});
     if(field.path.startsWith('visual.'))input.addEventListener('input',()=>{
      if(!current?.editor||busy)return;
      void options.preview?.('visual',{value:readDraft().visual??{hue:0,brightness:1}})?.catch(()=>{});
     },{signal});
    }
    fieldInputs.set(field.path,input);label.className='framework-control';label.append(widget);
    const destination=field.path.startsWith('visual.')?visualFields:field.path.startsWith('fit.')?fields:field.path.startsWith('crop.')?cropFields:behaviorFields;
    destination.append(label);
   }
   cropGroup.hidden=!cropFields.childElementCount;
   if(options.preview)cropControls();
   const crop=result.behavior?.crop;
   cropStatus.textContent=crop?.supported
     ? text('默认裁切用于首次加载。已有全身／半身选择会保留。','The default applies on first load. An existing full/upper-body choice is kept.')
     : crop?.reason==='bongo-input'
       ? text('当前模型由 Bongo 输入控制裁切。','Bongo input controls this model’s crop.')
       : crop ? text('当前身体不支持裁切。','The current body does not support cropping.')
         : options.preview ? text('默认裁切用于首次加载。','The default crop applies on first load.')
           : text('载入桌宠后可确认裁切是否生效。','Load the desktop pet to confirm crop support.');
   if(result.fields.some(f=>f.path==='motion.kind')){
    behaviorFields.append(el('p',text('站定仅关闭自主漫游，不会冻结姿态，也不禁止明确的行走命令或拖动。朝向选项仅在站定时生效。','Standing disables autonomous roaming, not explicit walking commands or dragging, and does not freeze the pose. Facing applies only while standing.')));
    const motion=result.behavior?.motion;
    behaviorFields.append(el('p',motion?text('已加载→实际移动策略：','Loaded → effective movement policy: ')+motion.compiledKind+' → '+motion.effectiveKind+' · '+text('朝向：','Facing: ')+motion.facing+(motion.reason?' · '+(motion.reason==='bongo-input'?text('Bongo 输入接管','Bongo input owns this behavior'):motion.reason):''):text('尚无身体移动策略报告。','No body movement report yet.')));
   }
   if(result.fields.some(f=>f.path.startsWith('gaze.'))){
    behaviorFields.append(el('p',text('仅控制眼睛跟随光标，不控制动作视线或头部运动。','This controls eye cursor tracking, not motion gaze or head movement.')));
    const gaze=result.behavior?.gaze;
    const reasons:Record<string,string>={'bongo-input':text('Bongo 输入接管','Bongo input owns this behavior'),'no-eye-roles':text('未映射眼睛参数','No mapped eye parameters')};
    behaviorFields.append(el('p',gaze?text('身体报告：','Body report: ')+(gaze.supported?text('支持','Supported'):text('不支持，当前源配置不会产生效果','Unsupported; source settings have no current effect'))+(gaze.reason?' · '+(reasons[gaze.reason]??gaze.reason):'')+' · '+text('实际设置：','Applied settings: ')+(gaze.settings.enabled?text('开启','enabled'):text('关闭','disabled'))+' / '+gaze.settings.speed:text('尚无身体行为报告，未确认支持。','No body behavior report yet; support is unconfirmed.')));
   }
   if(result.framing?.state?.reason==='not-ready')void waitForFraming(result.figure,readinessSerial);
   for(const binding of result.editor.profile.bindings??[])row(binding);
   let selection=previousWord?rows.findIndex(item=>item.value().word===previousWord):0;
   const words=result.editor.catalog?.words;
   if(options.preview&&previousWord&&selection<0&&(words?.expressions.includes(previousWord)||words?.motions.includes(previousWord))){
    row({word:previousWord});
    selection=rows.length-1;
   }
   showBinding(Math.max(0,selection));
   wardrobe.read(result.editor.profile.wardrobe,result.editor.catalog?.resources??[]);
   mouth.read(result.editor.profile.mouth,result.behavior?.mouth);
   add.disabled=!(result.editor.catalog?.resources.length&&result.editor.catalog?.words);
   if(saveNotice!==status)status.textContent='';
   saveNotice.textContent=(options.onDraft?null:result.operation.error)??(olderDraft?text('已恢复旧基准草稿。请检查失效的资源引用。','An older draft was restored. Review missing resources.'):'');
   saveButtons();
  }catch(error){if(!signal.aborted){loadFailure=String(error);panel.hidden=false;saveNotice.textContent=loadFailure;}}
 }
 add.addEventListener('click',()=>{if(!busy){row();showBinding(rows.length-1);markDirty();}},{signal});
 reload.addEventListener('click',async()=>{
  if(!await confirmDiscard())return;
  const wasDirty=dirty;
  busy=true;workspace.inert=true;saveButtons();
  try {
   if(options.invoke&&current&&wasDirty){
    await call('edit.clearDraft',[current.figure]);
    dirty=false;
    stale=true;
   }
   busy=false;
   await read();
   if(wasDirty&&!loadFailure){
    await options.preview?.('restore')?.catch(()=>{});
    saveNotice.textContent=text('已回到上一次保存的配置。','Last saved settings restored.');
   }
  }
  catch(error){saveNotice.textContent=String(error);}
  finally{busy=false;workspace.inert=false;saveButtons();}
 },{signal});
 function readDraft(){
  const profile=structuredClone(current!.editor!.profile);
  const valueOf=(input:HTMLInputElement|HTMLSelectElement)=>input.tagName==='SELECT'?input.value:input.type==='checkbox'?(input as HTMLInputElement).checked:Number(input.value);
  // Optional domain defaults are display values until that domain is explicitly edited.
  const editedRoots=new Set(draftFields().filter(field=>{
   const input=fieldInputs.get(field.path);if(!input)return false;
   return dirtyFields.has(field.path)||valueOf(input)!==(at(current!.editor!.profile,field.path)??field.default);
  }).map(field=>field.path.split('.')[0]));
  for(const[path,input]of fieldInputs){const root=path.split('.')[0];if(at(profile,root)!==undefined||editedRoots.has(root))put(profile,path,valueOf(input));}
  if(current!.editor!.catalog){profile.bindings=rows.map(r=>r.value()).filter(item=>!options.preview||!!item.resource);const groups=wardrobe.value();if(groups!==undefined)profile.wardrobe=groups;}
  const mouthProfile=mouth.value();if(mouthProfile!==undefined)profile.mouth=mouthProfile;
  if(options.touch)profile.touch=options.touch.value();
  return profile;
 }
 save.addEventListener('click',async()=>{
  if(busy||stale||!current?.editor||!options.preview&&(previewBusy||previewTask))return;
  if(options.touch?.isDrawing?.()){
   options.onInvalid?.('touch');
   saveNotice.textContent=text('请先完成或取消触碰范围绘制。','Finish or cancel drawing the touch area first.');
   return;
  }
  for(const [id,valid] of [['wardrobe',()=>wardrobe.valid(!!options.preview)],['mouth',mouth.valid]] as const)if(!valid()){
   if(options.onInvalid)options.onInvalid(id);else selectSection(id);
   valid();
   saveNotice.textContent=text('请修复当前工作区的无效值。','Correct the invalid value in this workspace.');
   return;
  }
  const invalid=[...fieldInputs].find(([,i])=>!i.validity.valid||(i.type==='number'&&!i.value));
  if(invalid){
   const id=invalid[1].closest<HTMLElement>('[data-editor-section]')?.dataset.editorSection??'framing';
   if(options.onInvalid)options.onInvalid(id);else selectSection(id);
   invalid[1].focus();invalid[1].reportValidity();return;
  }
  const id=crypto.randomUUID(),figure=current.figure,model=current.editor;
  const profile=readDraft();
  clearTimeout(framingTimer);
  releaseDraft();
  actionRequest=undefined;
  void options.preview?.('release-task',{task:section})?.catch(()=>{});
  busy=true;workspace.inert=true;previewSerial++;previewControls();saveButtons();
  panel.setAttribute('aria-busy','true');progress.hidden=false;
  let polling=false,finished=false;
  const operation=()=>call<ModelOperation|null>('operation.get',[id]).catch(()=>null);
  const poll=async()=>{
   if(polling||finished||signal.aborted)return;
   polling=true;
   try{
    const result=await operation();
    if(finished||signal.aborted||!result)return;
    const phases:Record<string,string>=zh?{saving:'正在保存配置…',preparing:'配置已保存，正在准备模型…',applying:'正在应用配置，等待桌宠确认…'}:{saving:'Saving settings…',preparing:'Settings saved. Preparing model…',applying:'Applying settings; waiting for the pet…'};
    if(phases[result.phase])saveNotice.textContent=phases[result.phase];
   }finally{polling=false;}
  };
  const timer=setInterval(()=>void poll(),700);
  saveNotice.textContent=text('正在保存配置…','Saving settings…');
  async function saved(applied:boolean,receipt?:ModelOperation|null){
   finished=true;
   if(signal.aborted)return;
   if(applied)previewFigure=null;
   dirty=false;
   busy=false;
   await read();
   if(signal.aborted)return;
   if(loadFailure){
    stale=true;
    draftState.textContent=text('配置已保存','Settings saved');
    saveNotice.textContent=text('已保存，重新读取后可继续编辑。','Saved. Reload before continuing to edit.');
    return;
   }
   if(receipt?.error&&receipt.revision&&!applied)retryRevision={figure,revision:receipt.revision};
   saveNotice.textContent=applied?text('已保存并应用','Saved and applied')
    :receipt?.error?text('已保存，应用失败。','Saved. Application failed. ')+receipt.error
    :text('已保存，使用该角色时生效。','Saved. Settings apply when you use this character.');
  }
  try{
   const result=await call<{saved:boolean;applied:boolean;operation?:ModelOperation}>(targetFigure?'saveLibraryModel':'saveModel',[figure,profile,model.revision,model.catalogFingerprint,id]);
   if(!result.saved)throw Error(result.operation?.error??text('未收到保存回执。','No save receipt was received.'));
   await saved(result.applied,result.operation);
  }catch(error){
   finished=true;
   if(signal.aborted)return;
   const receipt=await operation();
   if(receipt?.saved)await saved(receipt.applied,receipt);
   else saveNotice.textContent=text('保存未完成，当前修改已保留。','Save did not complete. Your edits are still here. ')+String(error);
  }finally{
   finished=true;clearInterval(timer);busy=false;workspace.inert=false;
   panel.setAttribute('aria-busy','false');progress.hidden=true;previewControls();saveButtons();
  }
 },{signal});
 function modelChanged(figure:string){if(targetFigure||!current||current.figure===figure||busy)return;deactivate();stale=true;save.disabled=true;retry.hidden=true;previewControls();status.textContent=text('当前模型已切换，草稿仍保留。重新读取后才能编辑新模型。','The active model changed. Your draft is retained; reload to edit the new model.');if(!dirty)void read(true);}
 return {element:panel,refresh:read,deactivate,markDirty,actionState,isSaving:()=>busy,
  previewUnavailable(){
   editEpoch++;
   previewSerial++;
   actionRequest=undefined;
   status.textContent='';
  },
  setPreviewBehavior(behavior: EditorContract['behavior']) {
   if(!current?.editor)return;
   mouth.read(mouth.value()??current.editor.profile.mouth,behavior?.mouth);
   if(dirty){
    void framingCommand('preview');
    void options.preview?.('visual',{value:readDraft().visual??{hue:0,brightness:1}})?.catch(()=>{});
   }
  },confirmDiscard,cancelDiscard:()=>settleDiscard(false),modelChanged,selectSection,loadFailure:()=>loadFailure,modelLabel:()=>current?.editor?.modelFile.split(/[\\/]/).at(-1)?.replace(/\.model3\.json$/i,'')??'',hasModel:()=>!!current?.editor,dirty:()=>dirty,
  async ensureLoaded(target?:string){
   if(busy)return false;
   if(targetFigure!==target){
    if(!await confirmDiscard())return false;
    deactivate();targetFigure=target;loaded=false;dirty=false;stale=false;
   }
   if(!loaded||loadFailure){if(!reading)reading=read().finally(()=>{reading=null;});await reading;}
   return !loadFailure;
  }};
}
