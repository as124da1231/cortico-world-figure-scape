import type { ModelNativeCatalog, NativeBinding } from '../../../../framework/model-contract.ts';
import {
  TOUCH_REGIONS, assertTouchAreaChange, assertTouchOutline, readTouchProfile, readTouchRegion, resolvedTouchAreas,
  touchAreaConflict, touchRectangle, touchShapeFromDrag, touchSuggestion, touchRule,
  type TouchArea, type TouchGesture, type TouchPoint, type TouchProfile, type TouchRule, type TouchShape, type TouchShapeTool,
} from '../../../../../web/framework/touch-geometry.js';
import { studioText as t } from './controls.ts';

type TouchPolicy = { enabled: boolean; wakeOn: string; wakeKinds?: string[] } | null;
type AreaDraft = {
  id: string;
  target?: TouchArea;
  tool: TouchShapeTool;
  name: string;
  note: string;
  shape?: TouchShape;
  points: TouchPoint[];
};

const gestures: Array<[TouchGesture, string, string]> = [
  ['poke', '戳', 'Poke'], ['pet', '抚摸', 'Pet'], ['drop', '放下', 'Drop'], ['shake', '摇晃', 'Shake'],
];
const shapes: Array<[TouchShapeTool, string, string]> = [
  ['rectangle', '矩形', 'Rectangle'], ['ellipse', '椭圆', 'Ellipse'], ['polygon', '多边形', 'Polygon'],
];

function rectangleBounds(shape: TouchShape) {
  if (shape.kind !== 'polygon' || shape.points.length !== 4) return undefined;
  const [a,b,c,d] = shape.points;
  if (a.y !== b.y || b.x !== c.x || c.y !== d.y || d.x !== a.x || !(a.x < b.x && a.y < d.y)) return undefined;
  return { left:a.x, top:a.y, right:c.x, bottom:c.y };
}

export function createTouchEditor(options: {
  root: HTMLElement;
  signal: AbortSignal;
  changed(): void;
  send(kind: string, data?: Record<string, unknown>): Promise<Record<string, unknown>>;
}) {
  const doc = options.root.ownerDocument;
  const element = doc.createElement('section');
  element.className = 'touch-editor';
  const modes = doc.createElement('div');
  modes.className = 'touch-mode-bar';
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', t('触碰模式','Touch mode'));
  const selector = doc.createElement('div');
  selector.className = 'touch-area-list';
  selector.setAttribute('role', 'group');
  selector.setAttribute('aria-label', t('触碰区域','Touch areas'));
  const details = doc.createElement('div');
  const rulesPanel = doc.createElement('details');
  rulesPanel.className = 'touch-rule-panel';
  const feedback = doc.createElement('p');
  feedback.setAttribute('role', 'status');
  feedback.className = 'touch-feedback';
  element.append(modes, selector, details, feedback, rulesPanel);

  let visible = false, ready = false, mode: 'edit' | 'test' = 'edit', areaId = 'head', gesture: TouchGesture = 'poke';
  let profile: TouchProfile | undefined, catalog: ModelNativeCatalog | undefined, bindings: NativeBinding[] = [];
  let draft: AreaDraft | undefined;
  let updateDrawing: (() => void) | undefined;
  let choosingAction: string | undefined;
  let packageActions: Array<{ id: string; label: string }> | undefined;
  let policy: TouchPolicy = null;
  let playbackSequence = 0, configSequence = 0;

  const ensure = () => profile ??= { areas: [], rules: [] };
  const areas = () => profile?.areas ?? [];
  const custom = () => areas().filter(area => !readTouchRegion(area.id));
  const areaNotes = () => profile?.areaNotes ?? {};
  function areaNote(id: string) {
    const note = areaNotes()[id];
    return typeof note === 'string' ? note : '';
  }
  const area = (id: string) => resolvedTouchAreas(areas()).find(item => item.id === id);
  const bodyGesture = () => gesture === 'drop' || gesture === 'shake';

  function areaName(item: TouchArea) {
    const id = readTouchRegion(item.id);
    return id && !areas().some(saved => saved.id === id) ? t(...TOUCH_REGIONS[id]) : item.name;
  }
  function labelOf(id: string) {
    if (id === 'all') return t('全身','Whole body');
    const item = area(id);
    return item ? areaName(item) : id;
  }
  function writeNote(id: string, value: string) {
    const notes = { ...areaNotes() };
    if (value.trim()) notes[id] = value;
    else delete notes[id];
    ensure().areaNotes = Object.keys(notes).length ? notes : undefined;
  }
  function forgetArea(id: string) {
    const state = ensure();
    state.rules = state.rules.filter(rule => rule.area !== id);
    writeNote(id, '');
  }

  function button(title: string, action: () => void, primary = false) {
    const control = doc.createElement('button');
    control.className = primary ? 'studio-button is-primary' : 'studio-button';
    control.type = 'button';
    control.textContent = title;
    control.onclick = action;
    return control;
  }
  function select(items: Array<[string, string]>, value: string, change: (value: string) => void, multiple = false, selected: string[] = []) {
    const control = doc.createElement('select');
    control.multiple = multiple;
    if (multiple) control.size = 4;
    if (!multiple && !items.some(item => item[0] === value)) items = [...items, [value, value + ' · ' + t('资源已失效','Missing')]];
    for (const [id, name] of items) {
      const option = doc.createElement('option');
      option.value = id;
      option.textContent = name;
      option.selected = multiple ? selected.includes(id) : value === id;
      control.append(option);
    }
    control.onchange = () => change(control.value);
    return control;
  }
  function field(title: string, control: HTMLElement) {
    const label = doc.createElement('label');
    control.dataset.touchField = title;
    label.append(title, control);
    return label;
  }
  function row(className: string, ...children: Node[]) {
    const group = doc.createElement('div');
    group.className = className;
    group.append(...children);
    return group;
  }
  function noteField(value: string, change: (note: string) => void) {
    const note = doc.createElement('textarea');
    note.maxLength = 160;
    note.rows = 2;
    note.value = value;
    note.placeholder = t('填写后随触碰事件发给 Coo','Included in touch reports to Coo');
    note.oninput = () => change(note.value);
    const label = field(t('部位说明','Area description'), note);
    label.className = 'touch-note';
    return label;
  }
  function range(label: string, value: number, min: number, max: number, commit: (next: number) => number) {
    const line = doc.createElement('label');
    line.className = 'touch-range';
    const input = doc.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '.005';
    input.value = String(value);
    input.setAttribute('aria-label', label);
    const output = doc.createElement('span');
    const display = (n: number) => {
      output.textContent = Math.round(n * 100) + '%';
      input.setAttribute('aria-valuetext', output.textContent);
    };
    display(value);
    input.oninput = () => {
      const committed = commit(input.valueAsNumber);
      input.value = String(committed);
      display(committed);
    };
    line.append(label, input, output);
    return line;
  }
  function error(failure: unknown) { feedback.textContent = failure instanceof Error ? failure.message : String(failure); }

  function sync() {
    if (!visible || !ready) return;
    const sequence = ++configSequence;
    void options.send('touch-config', {
      profile, tool: draft?.tool ?? mode, points: draft?.points ?? [], shape: draft?.shape,
      gesture, replacing: draft?.target?.id ?? null, selected: areaId, paused: mode === 'edit',
    }).catch(failure => { if (visible && sequence === configSequence) error(failure); });
  }
  function chooseArea(id: string, focus = false) {
    if (!area(id)) return;
    feedback.textContent = '';
    areaId = id;
    render();
    sync();
    if (focus) focusArea();
  }
  function focusArea() { selector.querySelector<HTMLElement>('[aria-pressed=true]')?.focus({ preventScroll:true }); }

  function startDrawing(target?: TouchArea) {
    if (!ready) { error(t('模型画布正在准备。','The model canvas is still loading.')); return; }
    if (!target && custom().length >= 24) { error(t('已达到 24 个自定义区域。','The 24 custom areas limit has been reached.')); return; }
    playbackSequence++;
    const tool = !target || rectangleBounds(target.shape) ? 'rectangle' : target.shape.kind;
    draft = {
      id: target?.id ?? 'area-' + doc.defaultView!.crypto.randomUUID(),
      target, tool, name: target ? areaName(target) : '', note: target ? areaNote(target.id) : '', points: [],
    };
    feedback.textContent = '';
    render();
    sync();
    details.querySelector<HTMLElement>(target ? 'select' : 'input')?.focus();
  }
  function cancelDrawing() {
    if (!draft) return false;
    const editing = !!draft.target;
    draft = undefined;
    feedback.textContent = '';
    render();
    sync();
    if (editing) focusArea();
    else details.querySelector<HTMLElement>('[data-touch-create]')?.focus();
    return true;
  }

  function shapeIssue(item: TouchArea) {
    try {
      readTouchProfile({ areas:[item], rules:[] });
      assertTouchOutline(item.shape);
    } catch (failure) { return failure instanceof Error ? failure.message : String(failure); }
    const next = [...areas().filter(old => old.id !== item.id), item];
    const conflict = touchAreaConflict(next, areas(), item.id)?.find(other => other.id !== item.id);
    if (!conflict) return '';
    const label = areaName(conflict);
    return t(`与「${label}」重叠。请在空白处画，或先缩小已有区域。`, `Overlaps “${label}”. Draw in a gap or shrink the existing area first.`);
  }

  function storeArea(item: TouchArea) {
    const list = ensure().areas;
    const saved = list.find(old => old.id === item.id);
    if (saved) Object.assign(saved, item);
    else list.push(item);
  }
  function renderDrawing(value: AreaDraft) {
    const form = doc.createElement('fieldset');
    const title = doc.createElement('legend');
    title.textContent = value.target ? t('重画 ', 'Redraw ') + value.name : t('新建触碰区域','New touch area');
    form.append(title);
    const name = doc.createElement('input');
    if (!value.target) {
      name.value = value.name;
      name.maxLength = 40;
      name.placeholder = t('例如：左手','For example: left hand');
      name.oninput = () => { value.name = name.value; updateDrawing?.(); };
      form.append(field(t('区域名称','Area name'), name), noteField(value.note, note => { value.note = note; }));
    }
    form.append(field(t('图形','Shape'), select(shapes.map(([id, cn, en]) => [id, t(cn,en)]), value.tool, tool => {
      value.tool = tool as TouchShapeTool;
      value.shape = undefined;
      value.points = [];
      feedback.textContent = '';
      render();
      sync();
      details.querySelector('select')?.focus();
    })));
    const hint = doc.createElement('p');
    hint.className = 'touch-drawing-hint';
    hint.textContent = value.tool === 'polygon'
      ? t('在画布上依次点击顶点，然后点完成。','Click the vertices on the canvas, then finish.')
      : t('在画布上拖出范围，然后点完成。','Drag to draw the area on the canvas, then finish.');
    form.append(hint);
    const undo = button(t('撤销上一点','Undo last point'), () => {
      value.points.pop();
      updateDrawing?.();
      sync();
    });
    undo.hidden = value.tool !== 'polygon';
    const redo = button(t('重新绘制','Start over'), () => {
      value.shape = undefined;
      value.points = [];
      updateDrawing?.();
      sync();
    });
    const candidate = (): TouchArea | undefined => {
      const shape = value.tool === 'polygon' && value.points.length >= 3 ? { kind:'polygon' as const, points:[...value.points] } : value.shape;
      return shape ? { id:value.id, name:value.name.trim() || t('新区域','New area'), shape } : undefined;
    };
    const done = button(value.target ? t('应用范围','Apply shape') : t('添加区域','Add area'), () => {
      const item = candidate();
      if (!item || !value.name.trim()) return;
      const issue = shapeIssue(item);
      if (issue) { error(issue); return; }
      storeArea(item);
      if (!value.target) writeNote(item.id, value.note);
      areaId = item.id;
      draft = undefined;
      feedback.textContent = '';
      options.changed();
      render();
      sync();
      focusArea();
    }, true);
    const cancel = button(t('取消','Cancel'), cancelDrawing);
    form.append(row('studio-inline touch-draft-actions', undo, redo, cancel, done));
    details.append(form);
    updateDrawing = () => {
      const item = candidate();
      const issue = item ? shapeIssue(item) : '';
      feedback.textContent = issue;
      done.disabled = !item || !!issue || !value.name.trim() || !ready;
      undo.disabled = value.points.length === 0;
      redo.disabled = !value.shape && !value.points.length;
    };
    updateDrawing();
  }

  function renderArea(item: TouchArea) {
    details.append(noteField(areaNote(item.id), text => {
      writeNote(item.id, text);
      options.changed();
      sync();
    }));
    const section = doc.createElement('fieldset');
    const title = doc.createElement('legend');
    title.textContent = t('范围','Area bounds');
    section.append(title);

    const builtIn = readTouchRegion(item.id);
    const saved = () => areas().find(old => old.id === item.id);
    const latest = () => saved() ?? item;
    const restore = button(builtIn ? t('恢复默认范围','Restore default bounds') : t('移除区域','Remove area'), () => {
      const state = ensure(), next = state.areas.filter(old => old.id !== item.id);
      try { assertTouchAreaChange(next, state.areas); }
      catch (failure) { error(failure); return; }
      state.areas = next;
      if (!builtIn) { forgetArea(item.id); areaId = 'head'; }
      feedback.textContent = '';
      options.changed();
      render();
      sync();
      focusArea();
    });
    restore.disabled = !saved();
    function applyShape(shape: TouchShape) {
      const candidate = { ...latest(), name:areaName(latest()), shape };
      if (JSON.stringify(candidate.shape) === JSON.stringify(latest().shape)) return true;
      const issue = shapeIssue(candidate);
      if (issue) { error(issue); return false; }
      storeArea(candidate);
      restore.disabled = false;
      feedback.textContent = '';
      options.changed();
      sync();
      return true;
    }
    const rect = rectangleBounds(item.shape);
    if (rect) {
      for (const [edge, label] of [
        ['top', t('上边界','Top')], ['bottom', t('下边界','Bottom')],
        ['left', t('左边界','Left')], ['right', t('右边界','Right')],
      ] as const) {
        section.append(range(label, rect[edge], 0, 1, value => {
          const last = rectangleBounds(latest().shape)!;
          const next = { ...last, [edge]:value };
          if (next.right - next.left < .015 || next.bottom - next.top < .015) {
            error(t('范围过小。','Area is too small.'));
            return last[edge];
          }
          return applyShape(touchRectangle(next)) ? value : last[edge];
        }));
      }
    } else if (item.shape.kind === 'ellipse') {
      for (const [part, axis, label] of [
        ['center','x',t('水平位置','Horizontal position')], ['center','y',t('垂直位置','Vertical position')],
        ['radius','x',t('水平范围','Horizontal radius')], ['radius','y',t('垂直范围','Vertical radius')],
      ] as const) {
        section.append(range(label, item.shape[part][axis], part === 'center' ? 0 : .005, part === 'center' ? 1 : .65, value => {
          const shape = latest().shape;
          if (shape.kind !== 'ellipse') return value;
          return applyShape({ ...shape, [part]:{ ...shape[part], [axis]:value } }) ? value : shape[part][axis];
        }));
      }
    }
    if (!builtIn) {
      const name = doc.createElement('input');
      name.value = item.name;
      name.maxLength = 40;
      name.onchange = () => {
        const value = name.value.trim();
        if (!value) { name.value = latest().name; return; }
        storeArea({ ...latest(), name:value });
        options.changed();
        render();
        sync();
        focusArea();
      };
      section.append(field(t('区域名称','Area name'), name));
    }
    const redraw = button(t('重画范围','Redraw bounds'), () => startDrawing(latest()));
    redraw.disabled = !ready;
    section.append(row('studio-inline touch-area-actions', redraw, restore));
    details.append(section);
  }

  function change(rule: TouchRule, patch: Partial<TouchRule>, redraw = true) {
    const rules = ensure().rules;
    const index = rules.findIndex(item => item.area === rule.area && item.gesture === rule.gesture);
    const next = { ...rule, ...patch };
    if (index < 0) rules.push(next);
    else rules[index] = next;
    options.changed();
    sync();
    if (redraw) render();
  }
  function renderRules() {
    rulesPanel.hidden = !!draft;
    if (draft) return;
    const header = doc.createElement('summary');
    header.textContent = t('触碰反应','Touch response');
    const fields = doc.createElement('fieldset');
    rulesPanel.replaceChildren(header, fields);
    fields.append(field(t('手势','Gesture'), select(gestures.map(([id, cn, en]) => [id, t(cn,en)]), gesture, value => {
      gesture = value as TouchGesture;
      render();
      sync();
    })));
    const ruleArea = bodyGesture() ? 'all' : areaId;
    const own = profile?.rules.find(rule => rule.area === ruleArea && rule.gesture === gesture);
    const rule: TouchRule = own ?? { gesture, area: ruleArea, reaction:'inherit', send:'inherit' };
    const key = rule.area + ':' + gesture;
    const reactions: Array<[string,string]> = [
      ['', t('继承默认','Inherit default')], ['auto', t('自动','Automatic')], ['default', t('通用反馈','Generic feedback')],
      ['action', t('指定表现','Assigned action')], ['none', t('无动作','No action')],
    ];
    const assigned = choosingAction === key || rule.reaction === 'action';
    const reactionValue = assigned ? 'action' : own?.reaction === 'inherit' ? '' : own?.reaction ?? '';
    fields.append(
      field(t('本地反应','Local reaction'), select(reactions,reactionValue,value => {
        if (value === 'action') {
          choosingAction = key;
          render();
          rulesPanel.querySelector<HTMLSelectElement>('[data-touch-action]')?.focus();
          return;
        }
        choosingAction = undefined;
        if (!value) {
          if (own && (own.send !== 'inherit' || own.note)) {
            change(rule, { reaction:'inherit', action:undefined });
          } else if (own) {
            ensure().rules = ensure().rules.filter(item => item !== own);
            options.changed();
            sync();
          }
          render();
        } else change(rule, { reaction:value as TouchRule['reaction'], action:undefined });
      })),
      field(t('Coo 上报','Coo reporting'), select([
        ['inherit',t('遵循全局唤醒','Use global wake setting')], ['next',t('随下轮上报','Report in next turn')],
        ['local',t('仅本地','Local only')],
      ],rule.send,value => change(rule,{ send:value as TouchRule['send'] }))),
    );
    if (rule.note) {
      const note = doc.createElement('input');
      note.maxLength = 160;
      note.value = rule.note;
      note.onchange = () => change(rule, { note:note.value.trim() || undefined });
      fields.append(field(t('此手势附注','Gesture note'), note));
    }
    if (assigned) {
      const available = catalog?.resources.filter(item => item.classification !== 'appearance') ?? [];
      const choices: Array<[string,string]> = [
        ['', t('选择动作或表情','Choose an action or expression')],
        ...bindings.map(item => ['word:'+item.word,item.word] as [string,string]),
        ...(packageActions ?? []).map(item => ['word:'+item.id,item.label] as [string,string]),
        ...available.map(item => ['resource:'+item.id,item.title] as [string,string]),
      ];
      const current = rule.action?.word ? 'word:'+rule.action.word : rule.action?.resource ? 'resource:'+rule.action.resource : '';
      const mainAction = select(choices,current,value => {
        if (!value) return;
        choosingAction = undefined;
        if (value.startsWith('word:')) change(rule,{ reaction:'action', action:{ word:value.slice(5) } });
        else {
          const resource = value.slice(9), release = available.find(item => item.id === resource)?.release;
          change(rule, { reaction:'action', action:{ resource, overlays:[], ...(release ? { release } : {}) } });
        }
      });
      mainAction.dataset.touchAction = '';
      fields.append(field(t('主要表现','Main action'), mainAction));
      const id = rule.action?.resource;
      if (id) {
        const overlays = select(available.filter(item => item.kind === 'expression' && item.id !== id).map(item => [item.id,item.title]), '', () => change(rule,{
          action:{ resource:id, release:rule.action?.release, overlays:[...overlays.selectedOptions].map(option => option.value).slice(0,7) },
        }),true,rule.action?.overlays);
        fields.append(field(t('叠加表情','Expression overlays'), overlays));
      }
    }
    if (mode === 'test') fields.append(button(t('试播此规则','Test this rule'), () => run(ruleArea)));
  }

  async function run(hit: string) {
    const sequence = ++playbackSequence;
    const target = bodyGesture() ? 'all' : hit;
    if (target !== 'all') areaId = target;
    render();
    sync();
    const rule = touchRule(profile, gesture, target);
    const label = labelOf(target);
    let binding = bindings.find(item => item.word === rule?.action?.word);
    if (rule?.action?.resource) {
      binding = { word:'happy', resource:rule.action.resource, overlays:rule.action.overlays, release:rule.action.release, nativeOnly:false };
    } else if (!binding && (!rule || rule.reaction === 'auto')) {
      const suggestion = touchSuggestion(catalog?.resources,gesture,target);
      if (suggestion?.resource) binding = { word:'happy', resource:suggestion.resource };
    }
    const verb = gestures.find(([id]) => id === gesture)!;
    const notes = [...new Set([areaNote(target).trim(),rule?.note?.trim()].filter(Boolean))];
    const wakes = rule?.send !== 'next' && (policy?.wakeOn === 'all' || policy?.wakeOn === 'poke' && gesture === 'poke'
      || policy?.wakeOn === 'custom' && policy.wakeKinds?.includes(gesture));
    const report = rule?.send === 'local' ? t('仅本地','Local only')
      : policy?.enabled === false ? t('全局触碰上报已关闭','Touch reporting is off')
      : t('Coo 输入：','Coo input: ') + [t(verb[1],verb[2]),label,...notes,
        wakes ? t('可唤醒','Can wake') : t('随下轮上报','Report next turn')].join(' · ');
    const announce = (result: string) => { if (sequence === playbackSequence) feedback.textContent = [t('命中 ','Hit ') + label,result,report].join(' · '); };
    announce(t('准备试播','Preparing preview'));
    const word = packageActions?.some(action => action.id === rule?.action?.word) ? rule?.action?.word : undefined;
    try {
      const result = await options.send('touch-test',{ gesture,rule,binding,word });
      announce(typeof result.playback === 'string' ? result.playback : t('已试播','Played'));
    } catch (failure) { announce(String(failure)); }
  }

  const clearDialog = doc.createElement('dialog');
  clearDialog.className = 'framework-dialog touch-clear-dialog';
  const clearTitle = doc.createElement('h3');
  clearTitle.id = 'touch-clear-title';
  clearTitle.textContent = t('清空自定义触碰区？','Clear custom touch areas?');
  const clearSummary = doc.createElement('p');
  clearDialog.setAttribute('aria-labelledby', clearTitle.id);
  const keep = button(t('取消','Cancel'), () => clearDialog.close());
  keep.autofocus = true;
  const confirmClear = button(t('清空','Clear'), () => {
    const removed = new Set(custom().map(item => item.id));
    ensure().areas = areas().filter(item => !removed.has(item.id));
    for (const id of removed) forgetArea(id);
    if (removed.has(areaId)) areaId = 'head';
    clearDialog.close();
    options.changed();
    render();
    sync();
    focusArea();
  }, true);
  clearDialog.append(clearTitle, clearSummary, row('studio-inline', keep, confirmClear));
  element.append(clearDialog);
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !clearDialog.open && visible && cancelDrawing()) event.preventDefault();
  },{signal:options.signal});

  function render() {
    const previous = doc.activeElement as HTMLElement | null;
    const fieldName = previous?.dataset.touchField;
    const switchMode = (next: typeof mode) => {
      playbackSequence++;
      mode = next;
      feedback.textContent = '';
      rulesPanel.open = mode === 'test';
      render();
      sync();
      modes.querySelector<HTMLElement>('[aria-pressed=true]')?.focus();
    };
    const edit = button(t('编辑区域','Edit areas'), () => switchMode('edit'));
    const test = button(t('试触','Test touch'), () => switchMode('test'));
    edit.disabled = !!draft;
    test.disabled = !!draft || !ready;
    edit.setAttribute('aria-pressed',String(mode === 'edit'));
    test.setAttribute('aria-pressed',String(mode === 'test'));
    modes.replaceChildren(edit,test);
    const ordered = Object.keys(TOUCH_REGIONS).map(id => area(id)!).concat(custom());
    selector.replaceChildren(...ordered.map(item => {
      const control = button(areaName(item), () => chooseArea(item.id,true));
      control.dataset.area = item.id;
      control.setAttribute('aria-pressed', String(item.id === areaId));
      return control;
    }));
    selector.hidden = !!draft || mode === 'test' && bodyGesture();
    selector.inert = selector.hidden;

    details.replaceChildren();
    updateDrawing = undefined;
    if (draft) renderDrawing(draft);
    else if (mode === 'edit') {
      const create = button(t('新建区域','New area'), () => startDrawing(), true);
      create.dataset.touchCreate = '';
      create.disabled = !ready;
      const actions = row('studio-inline touch-create-actions', create);
      if (custom().length) actions.append(button(t('清空自定义区','Clear custom areas'), () => {
        const count = custom().length;
        clearSummary.textContent = t(`从草稿中移除 ${count} 个自定义区及其说明和反应。`, `Remove ${count} custom areas and their descriptions and responses from the draft.`);
        clearDialog.showModal();
      }));
      details.append(actions);
      if (!ready) {
        const loading = doc.createElement('p');
        loading.className = 'touch-drawing-hint';
        loading.textContent = t('画布就绪后可新建或重画。','You can draw once the canvas is ready.');
        details.append(loading);
      }
      const item = area(areaId);
      if (item) renderArea(item);
    }
    renderRules();
    if (previous && fieldName && !previous.isConnected) {
      const next = [...element.querySelectorAll<HTMLElement>('[data-touch-field]')]
        .find(control => control.dataset.touchField === fieldName && !control.closest('[hidden]'));
      next?.focus({preventScroll:true});
    }
  }

  return {
    element,
    clear() {
      visible = ready = false;
      mode = 'edit';
      areaId = 'head';
      gesture = 'poke';
      draft = undefined;
      choosingAction = undefined;
      rulesPanel.open = false;
      playbackSequence++;
      configSequence++;
    },
    cancelDrawing,
    setPackageActions(actions?: Array<{ id:string; label:string }>) { packageActions = actions; render(); },
    setPolicy(value: TouchPolicy) { policy = value; },
    setBindings(value: NativeBinding[]) { bindings = value; if (visible) render(); },
    read(value: TouchProfile | undefined, resources: ModelNativeCatalog | undefined, configured: NativeBinding[] | undefined) {
      profile = value && structuredClone(value);
      catalog = resources;
      bindings = configured ?? [];
      if (!area(areaId)) areaId = 'head';
      render();
      sync();
    },
    show(active: boolean, previewReady = true) {
      const leaving = visible && !active;
      visible = active;
      ready = previewReady;
      if (leaving) {
        playbackSequence++;
        configSequence++;
        if (!draft) mode = 'edit';
        if (ready) void options.send('touch-config',{tool:null,paused:false}).catch(()=>{});
      }
      render();
      sync();
    },
    value: () => profile && structuredClone(profile),
    isDrawing: () => draft !== undefined,
    pointer(value: { point?: TouchPoint; start?: TouchPoint; area?: string }) {
      if (!visible || !ready) return;
      if (draft) {
        if (!value.point) return;
        if (draft.tool === 'polygon') {
          if (draft.points.length < 32) draft.points.push(value.point);
        } else {
          const shape = touchShapeFromDrag(draft.tool,value.start,value.point);
          if (!shape) { error(t('请拖出一个可见的范围。','Drag to create a visible area.')); return; }
          draft.shape = shape;
        }
        updateDrawing?.();
        sync();
      } else if (mode === 'edit') {
        if (value.area) chooseArea(value.area);
      } else if (value.area) void run(value.area);
      else feedback.textContent = t('未命中模型。','No model hit.');
    },
  };
}
