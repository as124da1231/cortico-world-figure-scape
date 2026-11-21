import type { ConfigProperty } from 'cortico/core/config-schema.ts';
import { get, setConfig, invokePanel, pickPath } from '../../base/api.ts';
import type { PageContext } from '../../base/page.ts';
import { studioControls, studioText as t } from './controls.ts';
import { GLOW_DEFAULT } from '../../../../framework/body-preferences.ts';

const P = 'world:desktop-live2d-pet', K = 'worlds.desktop-live2d-pet.';
type Entry = {group:{id:string;schema:{properties:Record<string,ConfigProperty>}};values:Record<string,unknown>};
export type PreferenceTask = 'desktop'|'runtime'|'display'|'bubbles'|'performance'|'fullscreen'|'sound-effects'|'sound-quick'|'touch'|'shortcuts'|'autonomy'|'recognition'|'identity';
/** Placement is a framework decision, independent of the old page/group order. */
export function preferenceTask(key:string):PreferenceTask|null {
  if (!key.startsWith(K)) return null;
  const path=key.slice(K.length);
  if(path.startsWith('bodyEffects.')||path.startsWith('speech.'))return null;
  if(path.startsWith('cua.') || path === 'window.enabled' || path === 'window.scale') return null;
  if (['asr.enabled', 'asr.engine', 'asr.api.baseUrl', 'asr.api.model', 'asr.segment.thresholdDb'].includes(path)) return null;
  if(path.startsWith('asr.'))return 'recognition';
  if (path === 'sound' || path === 'sounds.volume') return 'sound-quick';
  if (path.startsWith('sounds.')) return 'sound-effects';
  if(path==='selfAdjust')return 'autonomy';
  if(path==='user')return 'identity';
  if (path.startsWith('touch.')) return 'touch';
  if (path === 'doubleClickChat') return 'shortcuts';
  if (path === 'hoverButtons' || path === 'hoverButtonsVisible') return null;
  if(/bubble|fontSize|Bubbles|Bubble/.test(path))return 'bubbles';
  if(/electronFile|^port$|^window\.enabled$/.test(path))return 'runtime';
  if(/frameRate|lockFrameRate/.test(path))return 'performance';
  if (/^window\.(hideWhenFullscreen|passWhenFullscreen|hideFromCapture|overTaskbar|exportOverlay)$/.test(path)) return 'fullscreen';
  if (/^theme$|^window\.glow$/.test(path)) return 'display';
  return 'desktop';
}
const titles: Record<PreferenceTask,string> = {
  desktop:'桌面活动', runtime:'窗口启动设置', display:'桌宠外观', bubbles:'气泡样式', performance:'渲染帧率',
  fullscreen:'全屏与直播', 'sound-effects':'音效设置', 'sound-quick':'音效', touch:'触摸回应', shortcuts:'悬浮球与快捷键',
  autonomy:'允许 Coo 自主调整', recognition:'识别高级设置', identity:'称呼',
};
const descriptions:Record<string,string>={
  roam:'设置桌宠平时的移动频率。',
  theme:'用于桌宠窗口和气泡。',
  'sounds.snoreSeconds':'设为 0 时持续到桌宠醒来。',
  'sounds.panByPosition':'按桌宠位置分配声道。',
  'window.frameRate':t('活动时的帧率，实际帧率受屏幕刷新率限制。', 'Frame rate while active, capped by the display refresh rate.'),
  'window.bubbleSpeed':t('控制角色文字的显示速度和分段节奏。', 'Controls text reveal and pacing between parts of a reply.'),
  saidBubbles:t('显示打字发送后的回显。语音转写单独显示，发送后自动收起。', 'Echo typed messages on screen. Voice transcripts use a separate bubble and dismiss after sending.'),
  'window.lockFrameRate':'开启后静止时也按所选帧率绘制。',
  doubleClickChat:'双击桌宠打开打字框。',
  'touch.showRegions':t('在角色身上显示头部、躯干和腿部的范围。', 'Show the head, body, and leg hit areas on the pet.'),
  'touch.wakeOn':t('上报触碰时，选哪些手势会让 Coo 立即回应。', 'Choose which reported gestures prompt an immediate response.'),
  'asr.language':t('留空跟随 Coo。也可以填语言代码（如 zh）或 auto。', 'Leave blank to follow Coo, or enter a code such as zh or auto.'),
  'asr.threads':t('用于本机识别。0 表示使用默认的 2 个线程。', 'For local recognition. 0 uses the default of two threads.'),
  'asr.simplified':t('Coo 使用简体中文时，将转写结果转成简体。', 'Convert transcripts to Simplified Chinese when Coo uses it.'),
  selfAdjust:'决定 Coo 可自行修改哪些桌宠设置。',
  'window.hideWhenFullscreen':'桌宠所在屏幕进入全屏时隐藏，退出全屏后恢复。',
  'window.passWhenFullscreen':'全屏期间让鼠标点击通过桌宠窗口。',
};
const sliderUnits: Record<string, string> = {
  'sounds.volume': '%',
  'window.scale': '×', 'window.bubbleSize': '×', 'window.fontSize': '×', 'window.bubbleSpeed': '×',
  'window.replyBubbleSeconds': t(' 秒', ' s'),
  'window.glow': ' px', 'asr.segment.thresholdDb': ' dBFS',
};
const choices:Record<string,string>={free:'自由活动',calm:'安静活动',off:'关闭',dark:'深色',light:'浅色',none:'不立即唤醒',poke:'仅戳一下',all:'所有触碰',custom:'自定义',default:'默认范围',any:'全部允许','ask-each-turn':'每轮确认','ask-before-acting':'操作前确认','ask-once':'授权一段时间','never-ask':'无需确认',chat:'对话',voice:'语音',roam:'活动',theme:'主题',sound:'声音',hide:'隐藏',dress:'装扮',worlds:'世界'};
const titlesByPath: Record<string, [string, string]> = {
  theme: ['主题', 'Theme'],
  sound: ['音效总开关', 'Sound effects'],
  'sounds.volume': ['音量', 'Volume'],
  doubleClickChat: ['双击打开打字框', 'Double-click to type'],
  'touch.enabled': ['向 Coo 上报触碰', 'Report touches to Coo'],
  'touch.wakeOn': ['立即回应的手势', 'Gestures that prompt a response'],
  'touch.showRegions': ['显示触碰范围', 'Show hit areas'],
  'asr.language': ['识别语言', 'Recognition language'],
  'asr.threads': ['CPU 线程数', 'CPU threads'],
  saidBubbles: ['显示文字发送气泡', 'Show sent text bubbles'],
  'window.electronFile': ['自定义窗口程序', 'Custom window executable'],
  port: ['本地页面端口', 'Local page port'],
};

const soundCueGroups = [
  { title: ['角色音效', 'Character sounds'], paths: ['sounds.move', 'sounds.touch', 'sounds.face', 'sounds.snore'] },
  { title: ['气泡与界面提示', 'Bubble and interface cues'], paths: ['sounds.talk', 'sounds.ui', 'sounds.confirmation'] },
] as const;

const soundCueCopy: Record<string, { title: [string, string]; summary: [string, string] }> = {
  'sounds.move': { title: ['动作', 'Movement'], summary: ['走跑、跳跃和落地等动作声。', 'Sounds for movement such as running, jumping and landing.'] },
  'sounds.touch': { title: ['触碰反馈', 'Touch feedback'], summary: ['拎起、摇晃、抚摸和戳碰的声音。', 'Sounds when the pet is picked up, shaken, petted or poked.'] },
  'sounds.face': { title: ['表情', 'Expressions'], summary: ['开心、惊讶等表情音效。', 'Sound effects for expressions such as joy and surprise.'] },
  'sounds.snore': { title: ['打呼噜', 'Snoring'], summary: ['角色睡着时的呼噜声。', 'Snoring while the character sleeps.'] },
  'sounds.talk': { title: ['台词气泡声', 'Dialogue bubble sounds'], summary: ['文字逐字出现和选项卡片弹出的声音。', 'Sounds as text appears and choice cards open.'] },
  'sounds.ui': { title: ['按钮与操作提示', 'Button and interaction cues'], summary: ['点按、选中和录音启停等提示声。', 'Cues for presses, selection and microphone start or stop.'] },
  'sounds.confirmation': { title: ['确认提醒', 'Confirmation cues'], summary: ['需要你确认时的提示音。', 'A chime when Coo asks for confirmation.'] },
};

export function preferences(ctx:PageContext,notify:(s:string, kind?:'success'|'pending', task?:PreferenceTask)=>void){
  const c=studioControls(ctx), panels=new Map<PreferenceTask,HTMLElement>(),controls=new Map<string,HTMLInputElement|HTMLSelectElement>(),pending=new Set<string>();
  let entries:Entry[]=[],loaded=false,reading:Promise<void>|undefined,readFailure:string|undefined;
  const listeners = new Set<() => void>();
  const ranges = new Map<string, ReturnType<typeof c.range>>();
  const editingRanges = new Set<string>();
  let renderFrameRate: ((value: unknown) => void) | undefined;
  const customEntries=new Map<string,HTMLElement>();
  const custom = new Map<string,HTMLElement>();
  async function write(group:string,key:string,value:unknown,control:HTMLInputElement|HTMLSelectElement,
    report: (message: string, kind?: 'success' | 'pending') => void =
      (message, kind) => notify(message, kind, preferenceTask(key) ?? undefined)){
    if(pending.has(key))return;pending.add(key);control.disabled=true;report(t('正在保存…','Saving…'),'pending');
    try {
      await setConfig(group,{[key]:value},{signal:ctx.signal});
      const restart = entries.find(e=>e.group.id===group)?.group.schema.properties[key]?.['x-hot']===false;
      report(restart ? t('已保存，下次启动时生效。','Saved. Applies at the next startup.') : t('已保存。','Saved.'),'success');
    }
    catch(e){report(String(e));}finally{pending.delete(key);control.disabled=false;if(reading) await reading;await refresh();}
  }
  function build(task:PreferenceTask){
    const panel=c.section(titles[task]);
    panel.classList.add('studio-preferences');
    panel.dataset.preferenceGroup = task;
    const cueRows = new Map<string, { row: HTMLElement; title: string; details?: string }>();
    const segmentation = task === 'recognition' ? c.section(t('语句分段', 'Speech segmentation')) : null;
    segmentation?.classList.add('studio-recognition-segmentation');
    const feedback = task === 'runtime' ? c.status('studio-runtime-config-feedback') : undefined;
    const report = feedback ? (message: string) => {
      if (!ctx.signal.aborted) feedback.textContent = message;
    } : (message: string, kind?: 'success' | 'pending') => notify(message, kind, task);
    panels.set(task,panel);
    for(const entry of entries)for(const[key,prop]of Object.entries(entry.group.schema.properties)){
      if(preferenceTask(key)!==task)continue;
      if (key === K + 'window.frameRate') {
        panel.append(frameRate(entry.group.id, key, entry.values[key]));
        continue;
      }
      const input=prop.enum?c.node('select'):c.node('input');controls.set(key,input);input.dataset.preference=key;
      if(input instanceof HTMLSelectElement)for(const value of prop.enum??[]){const option=c.node('option',choices[value]??(value||'自动'));option.value=value;input.append(option);}
      else{input.type=prop.type==='boolean'?'checkbox':prop.type==='number'||prop.type==='integer'?'number':'text';if(input.type==='checkbox')input.setAttribute('role','switch');if(prop.minimum!==undefined)input.min=String(prop.minimum);if(prop.maximum!==undefined)input.max=String(prop.maximum);input.step=String(prop.multipleOf??(prop.type==='integer'?1:'any'));}
      const path = key.slice(K.length);
      const unit = sliderUnits[path];
      const description = path === 'window.electronFile' ? t('留空时自动选择窗口程序。','Leave empty to detect the window executable automatically.')
        : path === 'port' ? t('端口被占用时会尝试下一个端口。','Tries the next port if this one is busy.')
        : (prop['x-hot'] === false ? '下次启动生效。 ' : '') +
        (path === 'doubleClickChat' ? '' : path === 'touch.enabled' ? t('关闭时，角色仍可在本地回应触碰。', 'Local touch responses still play when reporting is off.') : descriptions[path] ?? prop.description ?? '');
      let control: HTMLElement = input;
      if (unit && input instanceof HTMLInputElement && prop.minimum !== undefined && prop.maximum !== undefined) {
        const slider = c.range(input, prop.minimum, prop.maximum, String(prop.multipleOf ?? (prop.type === 'integer' ? 1 : 'any')), value => value + unit);
        input.value = String(entry.values[key] ?? prop.minimum);
        slider.sync();
        input.addEventListener('input', () => editingRanges.add(key), {signal:ctx.signal});
        input.addEventListener('blur', () => editingRanges.delete(key), {signal:ctx.signal});
        ranges.set(key, slider);
        control = slider.element;
        if (path === 'window.glow') {
          const def = GLOW_DEFAULT;
          const reset = c.button(t('复位', 'Reset'), () => {
            input.value = String(def); slider.sync();
            void write(entry.group.id,key,def,input);
          });
          reset.classList.add('studio-slider-reset');
          reset.setAttribute('aria-label',t('恢复默认：','Reset to default: ')+prop.title);
          const adjustable = c.node('span', '', 'studio-adjustable');
          adjustable.append(slider.element,reset);
          control = adjustable;
        }
      }
      const cue = task === 'sound-effects' && prop.type === 'boolean' ? soundCueCopy[path] : undefined;
      const title = cue ? t(...cue.title) : titlesByPath[path] ? t(...titlesByPath[path]) : ranges.has(key) ? prop.title : prop.title + (prop['x-suffix'] ? ' · ' + prop['x-suffix'] : '');
      if (path === 'user' && input instanceof HTMLInputElement) input.placeholder = t('默认称呼', 'Default name');
      if (path === 'asr.language' && input instanceof HTMLInputElement) {
        input.placeholder = t('跟随 Coo', 'Follow Coo');
        input.spellcheck = false;
      }
      const row = c.field(title, control, cue ? t(...cue.summary) : description);
      if (task === 'sound-quick' && path === 'sound') row.classList.add('studio-quick-toggle');
      if (task === 'sound-quick' && path === 'sounds.volume') panel.insertBefore(row, panel.children[1] ?? null);
      else if (cue) cueRows.set(path, { row, title, details: prop.description });
      else if (segmentation && path.startsWith('asr.segment.')) segmentation.append(row);
      else panel.append(row);
      if (prop['x-path']) {
        const spec=prop['x-path'];
        const browse = c.button(t('选择文件', 'Choose file'), () => {
          void (async () => {
            try {
              const path = await pickPath({kind:spec.kind,...(spec.extensions?{extensions:spec.extensions}:{})},{signal:ctx.signal});
              if (path) { input.value=path; await write(entry.group.id,key,path,input,report); }
            } catch (error) { report(String(error)); }
          })();
        });
        if (task === 'runtime' && path === 'window.electronFile') {
          input.setAttribute('placeholder',t('自动选择','Auto-detect'));
          const executable = c.node('div', '', 'studio-runtime-executable');
          row.replaceWith(executable);
          executable.append(row,browse);
        } else row.append(browse);
      }
      input.addEventListener('change',()=>{editingRanges.delete(key);if(!input.reportValidity())return;let value:unknown=input.value;if(prop.type==='boolean')value=(input as HTMLInputElement).checked;else if(prop.type==='number'||prop.type==='integer'){if(!input.value)return;value=Number(input.value);}void write(entry.group.id,key,value,input,report);},{signal:ctx.signal});
    }
    if (segmentation && segmentation.childElementCount > 1) panel.append(segmentation);
    if (cueRows.size) {
      const categories = c.node('div', '', 'studio-sound-cues');
      const notes = c.node('dl', '', 'studio-sound-cue-notes');
      for (const { title, paths } of soundCueGroups) {
        const group = c.node('div', '', 'studio-sound-cue-group');
        const heading = t(title[0], title[1]);
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', heading);
        group.append(c.node('h4', heading));
        for (const path of paths) {
          const cue = cueRows.get(path);
          if (!cue) continue;
          group.append(cue.row);
          if (cue.details) notes.append(c.node('dt', cue.title), c.node('dd', cue.details));
        }
        if (group.childElementCount > 1) categories.append(group);
      }
      if (notes.childElementCount) {
        const details = c.dialog(t('音效明细', 'Sound effect details'), 'studio-audio-dialog');
        details.body.append(notes);
        const link = c.button(t('查看音效明细', 'View sound effect details'), () => { details.open(link); });
        link.setAttribute('aria-haspopup', 'dialog');
        link.classList.add('studio-sound-cue-details');
        categories.append(link);
      }
      panel.insertBefore(categories, panel.children[1] ?? null);
    }
    if (task === 'touch') special(panel,'wake');
    if(task==='autonomy')special(panel,'self');
    if (feedback) panel.append(feedback);
    return panel;
  }
  function frameRate(group: string, key: string, initial: unknown) {
    const modes = ['0', '30', '60', '120', '144'];
    const picker = c.node('select');
    const custom = c.node('input');
    custom.type = 'number';
    custom.min = '1';
    custom.step = '1';
    custom.required = true;
    custom.placeholder = 'FPS';
    custom.className = 'studio-fps-number';
    custom.setAttribute('aria-label', t('自定义帧率（FPS）', 'Custom frame rate (FPS)'));
    picker.setAttribute('aria-label', t('帧率档位', 'Frame rate preset'));
    for (const value of [...modes, 'custom']) {
      const label = value === '0' ? t('跟随屏幕', 'Follow display')
        : value === 'custom' ? t('自定义', 'Custom') : value + ' FPS';
      const option = c.node('option', label);
      option.value = value;
      picker.append(option);
    }
    const controls = c.node('div', '', 'studio-fps-control');
    custom.hidden = true;
    controls.append(picker, custom);
    let choosingCustom = false;
    renderFrameRate = value => {
      if (pending.has(key) || choosingCustom) return;
      if (typeof value !== 'number') return;
      const preset = modes.includes(String(value));
      picker.value = preset ? String(value) : 'custom';
      custom.hidden = preset;
      custom.value = preset ? '' : String(value);
    };
    renderFrameRate(initial);
    picker.addEventListener('change', () => {
      if (pending.has(key)) return;
      if (picker.value === 'custom') {
        choosingCustom = true;
        custom.hidden = false;
        if (!custom.value) custom.value = String(Math.max(1, Number(value('window.frameRate')) || 60));
        custom.focus({preventScroll:true});
        custom.select();
      } else {
        choosingCustom = false;
        custom.hidden = true;
        void write(group, key, Number(picker.value), picker);
      }
    }, {signal:ctx.signal});
    custom.addEventListener('change', () => {
      if (pending.has(key) || !custom.reportValidity()) return;
      choosingCustom = false;
      void write(group, key, custom.valueAsNumber, custom);
    }, {signal:ctx.signal});
    custom.addEventListener('keydown', event => {
      if (event.key === 'Enter' && custom.reportValidity()) custom.blur();
      if (event.key === 'Escape' && !pending.has(key)) {
        choosingCustom = false;
        renderFrameRate?.(value('window.frameRate'));
        picker.focus({preventScroll:true});
      }
    }, {signal:ctx.signal});
    const row = c.node('div', '', 'studio-field');
    const copy = c.node('span', '', 'studio-field-copy');
    copy.append(c.node('strong', t('帧率', 'Frame rate')), c.node('small', descriptions['window.frameRate']));
    row.append(copy, controls);
    return row;
  }
  function special(panel:HTMLElement,kind:'wake'|'self'){
    const title=kind==='wake'?'自定义唤醒':'自主调整项目';
    const box = c.node('div', '', 'studio-choice-grid');
    const feedback = c.status('studio-preference-feedback');
    custom.set(kind, box);
    if (kind === 'wake') {
      const dialog = c.dialog(t('自定义唤醒', 'Custom wake gestures'), 'studio-settings-dialog');
      const open = c.button(t('编辑手势', 'Edit gestures'), () => { if (dialog.open(open)) void refreshSpecial(); });
      open.hidden = true;
      open.setAttribute('aria-haspopup', 'dialog');
      const field = controls.get(K + 'touch.wakeOn');
      const label = field?.parentElement;
      if (field && label) {
        const row = c.node('div', '', 'studio-field');
        const settings = c.node('div', '', 'studio-touch-control');
        const copy = label.firstElementChild!;
        copy.id = 'studio-wake-mode';
        field.setAttribute('aria-labelledby', copy.id);
        settings.append(field, open);
        row.append(copy, settings);
        label.replaceWith(row);
      }
      dialog.body.append(box, feedback);
      customEntries.set(kind, open);
    } else {
      const customView = c.node('section');
      customView.hidden = true;
      customView.append(c.node('h3', title), box);
      customEntries.set(kind, customView);
      panel.append(customView);
    }
    const keys=kind==='wake'?['poke','pet','throw','drop']:['figure','scheme','roam','snoreSeconds','sound','scale','bubbleSize','fontSize','theme','hoverButtons','user'];
    const labels:Record<string,string>={poke:'戳一下',pet:'抚摸',throw:'抛出',drop:'放下',shake:'摇晃',figure:'身体资源',scheme:'装扮',roam:'活动',snoreSeconds:'鼾声时长',sound:'声音',scale:'身体大小',bubbleSize:'气泡大小',fontSize:'文字大小',theme:'主题',hoverButtons:'快捷按钮',user:'称呼'};
    for (const key of keys) {
      const input = c.node('input');
      input.type = 'checkbox';
      input.dataset.custom = key;
      box.append(c.field(labels[key], input));
      input.addEventListener('change', () => {
        void (async () => {
          const all = [...box.querySelectorAll<HTMLInputElement>('input')];
          const selection = kind === 'wake' ? all.filter(i => i.checked).map(i => i.dataset.custom)
            : Object.fromEntries(all.map(i => [i.dataset.custom!, i.checked]));
          for (const control of all) control.disabled = true;
          box.setAttribute('aria-busy', 'true');
          const report = (message: string, result?: 'success' | 'pending') => {
            if (kind === 'wake') {
              feedback.textContent = message;
              feedback.dataset.kind = result ?? 'error';
            } else notify(message, result, 'autonomy');
          };
          try {
            report(t('正在保存…', 'Saving…'), 'pending');
            await invokePanel(P, 'pet', kind === 'wake' ? 'setWakeKinds' : 'setSelfAdjustCustom', [selection], {signal:ctx.signal});
            report(t('已保存。', 'Saved.'), 'success');
          } catch (error) { if (!ctx.signal.aborted) report(String(error)); }
          finally {
            try { await refreshSpecial(); }
            catch (error) { if (!ctx.signal.aborted) report(String(error)); }
            for (const control of all) control.disabled = false;
            box.removeAttribute('aria-busy');
          }
        })();
      }, {signal: ctx.signal});
    }
  }
  async function refreshSpecial() {
    if (!custom.size) return;
    const state = await invokePanel<any>(P, 'pet', 'state', [], {signal: ctx.signal});
    for (const [kind, box] of custom) {
      const section = customEntries.get(kind);
      const wake = kind === 'wake';
      if (section) section.hidden = wake ? state.wake?.wakeOn !== 'custom' : state.selfAdjust?.mode !== 'custom';
      if (wake) {
        const disabled = value('touch.enabled') === false;
        const mode = controls.get(K + 'touch.wakeOn');
        if (mode) mode.disabled = disabled || pending.has(K + 'touch.wakeOn');
        if (section instanceof HTMLButtonElement) section.disabled = disabled;
      }
      for (const input of box.querySelectorAll<HTMLInputElement>('input')) {
        input.checked = wake ? state.wake?.wakeKinds?.includes(input.dataset.custom) : state.selfAdjust?.custom?.[input.dataset.custom!] === true;
      }
    }
  }
  async function refresh() {
    if (reading) return reading;
    reading = (async () => {
      try {
        const data = await get<{groups:Entry[]}>('/api/config', { signal:ctx.signal });
        if (ctx.signal.aborted) return;
        entries = data.groups ?? [];
        loaded = true;
        for (const entry of entries) for (const [key, value] of Object.entries(entry.values ?? {})) {
          if (key === K + 'window.frameRate') renderFrameRate?.(value);
          const input = controls.get(key);
          if (!input || pending.has(key) || editingRanges.has(key)) continue;
          const slider = ranges.get(key);
          if (slider) {
            input.value = String(value ?? '');
            slider.sync();
          } else if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = value === true;
          else if (c.doc.activeElement !== input) input.value = String(value ?? '');
        }
        for (const listener of listeners) listener();
        await refreshSpecial();
        readFailure = undefined;
      } catch (failure) {
        if (ctx.signal.aborted) return;
        const message = failure instanceof Error ? failure.message : String(failure);
        if (loaded && readFailure !== message) notify(t('读取设置失败。','Could not read settings.') + ' ' + message);
        readFailure = message;
      } finally { reading = undefined; }
    })();
    return reading;
  }
  async function view(task: PreferenceTask) {
    if (!loaded) await refresh();
    if (!loaded) throw Error(readFailure ?? t('设置暂不可用。','Settings are unavailable.'));
    const panel = panels.get(task) ?? build(task);
    await refresh();
    return panel;
  }
  const deactivate=()=>{};
  function value(key: string) {
    return entries.find(entry => Object.hasOwn(entry.values, K + key))?.values[K + key];
  }
  function label(key: string) {
    const current = value(key);
    return typeof current === 'string' ? choices[current] ?? current : '';
  }
  function subscribe(listener: () => void) {
    listeners.add(listener);
    listener();
    ctx.signal.addEventListener('abort', () => listeners.delete(listener), {once:true});
  }
  async function applySelf(mode: string, customValues: Record<string, boolean>) {
    if (mode === 'custom') await invokePanel(P,'pet','setSelfAdjustCustom',[customValues],{signal:ctx.signal});
    else {
      const key=K+'selfAdjust';
      const group=entries.find(e=>Object.hasOwn(e.group.schema.properties,key))?.group.id;
      if (!group) throw Error(t('找不到 Live2D 授权配置。','Live2D permission settings are unavailable.'));
      await setConfig(group,{[key]:mode},{signal:ctx.signal});
    }
    if (reading) await reading;
    await refresh();
  }
  return { view, refresh, deactivate, value, label, subscribe, applySelf };
}
