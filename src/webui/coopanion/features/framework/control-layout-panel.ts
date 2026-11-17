import type { PageContext } from '../../base/page.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';
import {
  CONTROL_COMPONENTS, CONTROL_PAGE_IDS, CONTROL_RAIL_LIMIT, CONTROL_SECTIONS,
  allowsControl, controlPanelSize, defaultControlLayout, CONTROL_PANEL_LIMITS,
  type ControlId, type ControlLayout, type ControlLayoutState, type ControlPage, type ControlPanelSize, type ControlTarget,
} from '../../../../../web/framework/control-layout.js';
import { sceneScale, sceneSizePosition } from '../../../../../web/framework/model-size.js';
import { ICONS } from '../../../../../web/icons.js';
import type { NotificationKind } from './notifications.ts';
import type { RuntimeState } from './runtime.ts';

type Selection = { id: ControlId; target: ControlTarget };
type Draft = { saved: ControlLayoutState; value: ControlLayout; history: ControlLayout[]; page: ControlPage };
type Notify = (message: string, kind?: NotificationKind) => void;
const drafts = new WeakMap<Document, Draft>();
const targetOrder: ControlTarget[] = [...CONTROL_PAGE_IDS, 'rail'];

export function controlLayoutPanel(ctx: PageContext, notify: Notify) {
  const { doc, node, button, call, dialog } = studioControls(ctx);
  const { signal } = ctx;
  const element = node('section', '', 'layout-editor');
  const header = node('div', '', 'layout-editor-header');
  const status = node('p', '', 'layout-editor-status');
  status.setAttribute('role', 'status');
  const undo = button(t('撤销', 'Undo'), () => {
    const previous = draft?.history.pop();
    if (previous && draft) { draft.value = previous; remember(); render(); }
  });
  const resetConfirm = dialog(t('恢复默认布局？','Restore the default layout?'),'studio-settings-dialog');
  const reset = button(t('恢复默认', 'Restore defaults'), () => resetConfirm.open(reset));
  reset.setAttribute('aria-haspopup','dialog');
  const confirmation = node('div','','studio-inline');
  confirmation.append(button(t('取消','Cancel'),()=>resetConfirm.element.close()),button(t('恢复默认','Restore defaults'),()=>{
    change(defaultControlLayout());resetConfirm.element.close();
  },true));
  resetConfirm.body.append(node('p',t('恢复操作台尺寸、四页布局和靠近按钮。保存布局后应用。','Restore the panel size, four pages and hover buttons. Save the layout to apply.')),confirmation);
  const reload = button(t('重新读取', 'Reload'), () => void read(true));
  const save = button(t('保存布局', 'Save layout'), () => void apply(), true);
  const buttons = node('div', '', 'layout-editor-actions');
  buttons.append(undo, reset, reload, save);
  header.append(status, buttons);

  const grid = node('div', '', 'layout-editor-grid');
  const library = node('section', '', 'layout-editor-library');
  const search = node('input', '', 'layout-editor-search');
  search.type = 'search';
  search.placeholder = t('搜索组件', 'Search controls');
  search.setAttribute('aria-label', search.placeholder);
  const palette = node('div', '', 'layout-palette');
  const addTarget = node('select');
  addTarget.setAttribute('aria-label', t('点按添加到', 'Add on click to'));
  option(addTarget, 'page', t('点按添加到当前页', 'Click to add to the current page'));
  option(addTarget, 'rail', t('点按添加到靠近按钮', 'Click to add to hover buttons'));
  library.append(node('h2', t('组件库','Controls')), search, palette, addTarget);

  const middle = node('section', '', 'layout-editor-center');
  const middleHeading = node('header', '', 'layout-panel-heading');
  const sizeReadout = node('span', '', 'layout-panel-size');
  middleHeading.append(node('h2', t('右键操作台', 'Right-click controls')), sizeReadout);
  const previewStage = node('div', '', 'layout-panel-preview');
  previewStage.style.maxInlineSize = CONTROL_PANEL_LIMITS.maxWidth + 16 + 'px';
  const mock = node('div', '', 'layout-control-phone');
  const mockHeader = node('div', '', 'layout-phone-header');
  const mockTitle = node('strong');
  const chrome = node('span', '', 'layout-phone-chrome');
  const lamp = node('span', '', 'layout-online');
  chrome.append(lamp, icon('close'));
  chrome.setAttribute('aria-hidden', 'true');
  mockHeader.append(mockTitle, chrome);
  const canvas = node('div', '', 'layout-phone-canvas');
  const dock = node('nav', '', 'layout-phone-dock');
  dock.setAttribute('aria-label', t('操作台页面','Control panel pages'));
  for (const id of CONTROL_PAGE_IDS) {
    const spec = CONTROL_SECTIONS[id];
    const key = button(t(...spec.label), () => {
      if (draft) { draft.page = id; selection = undefined; remember(); render(); }
    });
    key.className = 'layout-phone-tab';
    key.prepend(icon(spec.icon));
    key.dataset.tab = id;
    key.dataset.drop = id;
    dock.append(key);
  }
  const resize = node('button', '', 'layout-panel-resize');
  resize.type = 'button';
  resize.setAttribute('aria-label', t('调整操作台尺寸', 'Resize control panel'));
  const resizeHint = t('拖动圆点或按方向键调整。保存布局后应用。', 'Drag the dot or use the arrow keys. Save the layout to apply.');
  resize.title = resizeHint;
  resize.setAttribute('aria-describedby','layout-panel-resize-hint');
  const hint = node('p', resizeHint, 'layout-panel-resize-hint');
  hint.id = 'layout-panel-resize-hint';
  mock.append(mockHeader, canvas, dock, resize);
  previewStage.append(mock);
  middle.append(middleHeading, previewStage, hint);

  const aside = node('section', '', 'layout-editor-aside');
  const railHeader = node('div', '', 'layout-rail-header');
  const visibility = node('input', '', 'control-toggle');
  visibility.type = 'checkbox';
  visibility.setAttribute('role', 'switch');
  visibility.setAttribute('aria-label', t('显示靠近按钮', 'Show hover buttons'));
  const rail = node('div', '', 'layout-hover-rail');
  rail.dataset.drop = 'rail';
  const railPreview = node('div','','floating-controls layout-rail-preview');
  const railEmpty = node('p',t('把组件拖到这里','Drop controls here'),'layout-empty');
  rail.append(railPreview,railEmpty);
  railHeader.append(node('h2', t('靠近按钮','Hover buttons')), visibility);
  aside.append(railHeader, rail);
  grid.append(library, middle, aside);

  const inspector = node('div', '', 'layout-selection');
  const picked = node('strong');
  const destination = node('select');
  destination.setAttribute('aria-label', t('移动或添加到', 'Move or add to'));
  const earlier = button(t('向前', 'Earlier'), () => shift(-1));
  const later = button(t('向后', 'Later'), () => shift(1));
  const remove = button(t('移除', 'Remove'), () => {
    if (!draft || !selection) return;
    const next = structuredClone(draft.value);
    const where = list(next, selection.target);
    where.splice(where.indexOf(selection.id), 1);
    selection = undefined;
    change(next);
  });
  inspector.hidden = true;
  inspector.append(picked, destination, earlier, later, remove);
  element.append(header, grid, inspector);

  let draft = drafts.get(doc);
  let selection: Selection | undefined;
  let dragging: { id: ControlId; from?: ControlTarget } | undefined;
  let dropMark: HTMLElement | undefined;
  let busy = false;
  let problem = '';
  let focusControl = '';
  let previewScale = 1;
  let resizing: { pointer: number; x: number; y: number; start: ControlPanelSize; current: ControlPanelSize } | undefined;

  function icon(key: string) {
    const el = node('span', '', 'layout-icon');
    el.innerHTML = ICONS[key] ?? '';
    return el;
  }
  function option(select: HTMLSelectElement, value: string, label: string) {
    const item = node('option', label);
    item.value = value;
    select.append(item);
  }
  function label(id: ControlId) { return t(...CONTROL_COMPONENTS[id].label); }
  function targetLabel(target: ControlTarget) { return target === 'rail' ? t('靠近按钮', 'Hover buttons') : t(...CONTROL_SECTIONS[target].label); }
  function list(value: ControlLayout, target: ControlTarget) { return target === 'rail' ? value.rail : value.pages[target]; }
  function dirty() { return !!draft && JSON.stringify(draft.value) !== draft.saved.revision; }
  function remember() { if (draft) drafts.set(doc, draft); }
  function change(next: ControlLayout) {
    if (!draft || busy || JSON.stringify(next) === JSON.stringify(draft.value)) { render(); return; }
    draft.history = [...draft.history.slice(-29), draft.value];
    draft.value = next;
    remember();
    render();
  }
  function place(id: ControlId, target: ControlTarget, before?: ControlId) {
    if (!draft || busy || !allowsControl(id, target) || before === id) return;
    const next = structuredClone(draft.value);
    const targetList = list(next, target);
    if (target === 'rail' && targetList.length >= CONTROL_RAIL_LIMIT && !targetList.includes(id)) {
      notify(t('靠近按钮最多显示 ', 'The hover rail can show up to ') + CONTROL_RAIL_LIMIT + t(' 个。', ' controls.'), 'notice');
      return;
    }
    const related = target === 'rail' ? [targetList] : CONTROL_PAGE_IDS.map(page => next.pages[page]);
    for (const entries of related) {
      const old = entries.indexOf(id);
      if (old !== -1) entries.splice(old, 1);
    }
    const index = before ? targetList.indexOf(before) : -1;
    targetList.splice(index < 0 ? targetList.length : index, 0, id);
    if (target !== 'rail') draft.page = target;
    selection = { id, target };
    focusControl = target + '/' + id;
    change(next);
  }
  function shift(offset: number) {
    if (!draft || !selection) return;
    const next = structuredClone(draft.value);
    const ids = list(next, selection.target);
    const index = ids.indexOf(selection.id), to = index + offset;
    if (to < 0 || to >= ids.length) return;
    const id = ids[index];
    ids.splice(index, 1);
    ids.splice(to, 0, id);
    change(next);
  }
  function item(id: ControlId, from?: ControlTarget) {
    const spec = CONTROL_COMPONENTS[id];
    const el = node('button', '', 'layout-piece');
    el.type = 'button';
    el.dataset.control = id;
    if (from) el.dataset.from = from;
    el.draggable = !busy;
    el.disabled = busy;
    el.title = label(id);
    el.setAttribute('aria-label', label(id));
    el.append(icon(spec.icon), node('span', label(id), 'layout-piece-label'));
    if (!from) el.append(node('span', '+', 'layout-add'));
    if (from === 'rail') { el.classList.add('floating-key'); el.dataset.action = id; }
    if (from === 'apps') el.classList.add('control-app-tile');
    if (from && from !== 'rail' && from !== 'apps' && id === 'size') {
      const meter = node('span', '', 'layout-size-preview');
      meter.append(node('span'));
      el.append(meter);
    }
    if (from && from !== 'rail' && from !== 'apps' && (id === 'sound' || id === 'hoverVisibility')) {
      const indicator = node('span', '', 'control-toggle');
      indicator.setAttribute('aria-hidden', 'true');
      el.append(indicator);
    }
    if (from && from === selection?.target && id === selection.id) el.setAttribute('aria-pressed', 'true');
    return el;
  }
  let runtime: RuntimeState | undefined;
  function reflectRuntime(next: RuntimeState) {
    runtime = next;
    const theme = next.theme ?? '';
    mock.dataset.theme = rail.dataset.theme = theme;
    lamp.dataset.online = String(next.onDesktop === true && next.bodyReady === true);
    drawPreviewValues();
  }
  function drawPreviewValues() {
    const meter = canvas.querySelector<HTMLElement>('.layout-size-preview');
    if (meter && runtime) {
      const mode = runtime.presentation?.applied ?? runtime.presentation?.desired ?? 'desktop';
      const scale = sceneScale(mode, runtime.presentationScales?.[mode]);
      meter.firstElementChild!.textContent = Math.round(scale * 100) + '%';
      meter.style.setProperty('--size-fill', sceneSizePosition(mode, scale) * 100 + '%');
    }
    for (const toggle of canvas.querySelectorAll<HTMLElement>('[data-control] > .control-toggle')) {
      const checked = toggle.parentElement?.dataset.control === 'sound' ? runtime?.sound : draft?.value.hoverVisible;
      toggle.dataset.checked = String(checked === true);
    }
  }
  function renderLibrary() {
    const query = search.value.trim().toLocaleLowerCase();
    const items = (Object.keys(CONTROL_COMPONENTS) as ControlId[]).filter(id =>
      (label(id) + ' ' + id).toLocaleLowerCase().includes(query));
    palette.replaceChildren(...items.map(id => item(id)));
    if (!items.length) palette.append(node('p', t('没有匹配的组件','No matching controls'), 'layout-empty'));
  }
  function drawSize(size: ControlPanelSize) {
    mock.style.width = size.width + 'px';
    mock.style.height = size.height + 'px';
    sizeReadout.textContent = size.width + ' × ' + size.height + ' px';
  }
  function finishResize(event: PointerEvent, accept: boolean) {
    if (!resizing || resizing.pointer !== event.pointerId) return;
    const {current} = resizing;
    resizing = undefined;
    delete resize.dataset.active;
    if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId);
    if (accept && draft) change({...draft.value, panelSize:current});
    else if (draft) drawSize(draft.value.panelSize);
  }
  function render() {
    undo.disabled = busy || !draft?.history.length;
    reset.disabled = busy || !draft;
    reload.disabled = busy;
    save.disabled = busy || !!resizing || !dirty();
    resize.disabled = busy || !draft;
    search.disabled = addTarget.disabled = visibility.disabled = busy || !draft;
    status.textContent = problem || (busy ? t('处理中…','Working…') : !draft
      ? t('正在读取布局…','Loading layout…') : dirty() ? t('有未保存的调整','Unsaved changes') : t('布局已保存','Layout saved'));
    grid.hidden = !draft;
    if (!draft) return;
    const { page, value } = draft;
    drawSize(resizing?.current ?? value.panelSize);
    renderLibrary();
    mockTitle.textContent = targetLabel(page);
    canvas.dataset.page = page;
    canvas.dataset.drop = page;
    canvas.classList.toggle('control-app-grid',page === 'apps');
    canvas.replaceChildren(...value.pages[page].map(id => item(id, page)));
    drawPreviewValues();
    if (!canvas.childElementCount) canvas.append(node('p', t('拖组件到此处','Drop controls here'), 'layout-empty'));
    railPreview.replaceChildren(...value.rail.map(id => item(id, 'rail')));
    railPreview.hidden = !value.rail.length;
    railEmpty.hidden = !!value.rail.length;
    railPreview.dataset.off = String(!value.hoverVisible);
    visibility.checked = value.hoverVisible;
    for (const tab of dock.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      tab.disabled = busy;
      if (tab.dataset.tab === page) tab.setAttribute('aria-current','page');
      else tab.removeAttribute('aria-current');
    }
    const selected = selection && list(value, selection.target).includes(selection.id) ? selection : undefined;
    inspector.hidden = !selected;
    if (selected) {
      picked.textContent = label(selected.id);
      const where = list(value, selected.target), index = where.indexOf(selected.id);
      destination.replaceChildren();
      option(destination, '', t('移动或添加到…','Move or add to…'));
      for (const target of targetOrder) {
        if (target !== selected.target && allowsControl(selected.id, target)) option(destination, target, targetLabel(target));
      }
      earlier.disabled = busy || index === 0;
      later.disabled = busy || index === where.length - 1;
      remove.disabled = destination.disabled = busy;
    }
    if (focusControl) {
      const [from, id] = focusControl.split('/');
      element.querySelector<HTMLElement>('[data-from="' + from + '"][data-control="' + id + '"]')?.focus({preventScroll:true});
      focusControl = '';
    }
  }
  async function read(force = false) {
    if (busy || (!force && draft && dirty())) return;
    busy = true;
    problem = '';
    render();
    try {
      const saved = await call<ControlLayoutState>('controls.state');
      if (!signal.aborted) {
        const history = draft && dirty() ? [...draft.history.slice(-29), draft.value] : [];
        draft = { saved, value: saved.layout, history, page: draft?.page ?? 'home' };
        remember();
      }
    } catch (error) {
      problem = errorText(error);
      if (!signal.aborted) notify(problem, 'notice');
    } finally { busy = false; if (!signal.aborted) render(); }
  }
  async function apply() {
    if (!draft || !dirty() || busy || resizing) return;
    busy = true;
    problem = '';
    render();
    try {
      const saved = await call<ControlLayoutState>('controls.save', [draft.value, draft.saved.revision]);
      if (signal.aborted) return;
      draft.saved = saved;
      draft.value = saved.layout;
      remember();
      notify(t('布局已保存并发送给桌宠。','Layout saved and sent to the pet.'), 'success');
    } catch (error) {
      problem = errorText(error);
      if (!signal.aborted) notify(problem, 'notice');
    } finally { busy = false; if (!signal.aborted) render(); }
  }
  function clearMark() { dropMark?.classList.remove('layout-drop-mark'); dropMark = undefined; }

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    previewScale = Math.min(1, previewStage.clientWidth / (CONTROL_PANEL_LIMITS.maxWidth + 16)) || 1;
    mock.style.zoom = String(previewScale);
  });
  observer?.observe(previewStage);
  ctx.lifecycle.add(() => observer?.disconnect());
  resize.addEventListener('pointerdown', event => {
    if (!draft || busy || resizing || event.button !== 0) return;
    const start = draft.value.panelSize;
    resizing = {pointer:event.pointerId, x:event.clientX, y:event.clientY, start, current:start};
    resize.setPointerCapture(event.pointerId);
    resize.dataset.active = 'true';
    save.disabled = true;
  }, {signal});
  resize.addEventListener('pointermove', event => {
    if (!resizing || event.pointerId !== resizing.pointer) return;
    const {x,y,start} = resizing;
    resizing.current = controlPanelSize({
      width:start.width + (event.clientX - x) / previewScale,
      height:start.height + (event.clientY - y) / previewScale,
    });
    drawSize(resizing.current);
  }, {signal});
  resize.addEventListener('pointerup', event => finishResize(event,true), {signal});
  for (const name of ['pointercancel','lostpointercapture'] as const) {
    resize.addEventListener(name, event => {
      finishResize(event,false);
      save.disabled = busy || !dirty();
    }, {signal});
  }
  resize.addEventListener('keydown', event => {
    if (!draft || busy || resizing) return;
    const direction = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 20 : 5;
    const {width,height} = draft.value.panelSize;
    change({...draft.value, panelSize:controlPanelSize({width:width + direction[0] * step,height:height + direction[1] * step})});
  }, {signal});

  search.addEventListener('input', renderLibrary, { signal });
  addTarget.addEventListener('change', renderLibrary, { signal });
  visibility.addEventListener('change', () => {
    if (draft) change({ ...draft.value, hoverVisible: visibility.checked });
  }, { signal });
  destination.addEventListener('change', () => {
    if (selection && destination.value) place(selection.id, destination.value as ControlTarget);
  }, { signal });
  element.addEventListener('click', event => {
    const el = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-control]');
    if (!el || !draft || el.disabled) return;
    const id = el.dataset.control as ControlId, from = el.dataset.from as ControlTarget | undefined;
    if (!from) {
      const requested = addTarget.value === 'rail' ? 'rail' : draft.page;
      const fallback = CONTROL_COMPONENTS[id].railOnly ? 'rail' : draft.page;
      place(id, allowsControl(id, requested) ? requested : fallback);
    }
    else { selection = { id, target: from }; focusControl = from + '/' + id; render(); }
  }, { signal });
  element.addEventListener('dragstart', event => {
    const el = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-control]');
    if (!el || !event.dataTransfer || busy) return;
    dragging = { id: el.dataset.control as ControlId, from: el.dataset.from as ControlTarget | undefined };
    event.dataTransfer.setData('text/plain', label(dragging.id));
    event.dataTransfer.effectAllowed = dragging.from ? 'copyMove' : 'copy';
  }, { signal });
  function dropTarget(event: DragEvent) {
    return (event.target as HTMLElement).closest<HTMLElement>('[data-drop]');
  }
  element.addEventListener('dragover', event => {
    if (!dragging) return;
    const zone = dropTarget(event);
    const target = zone?.dataset.drop as ControlTarget | undefined;
    if (!zone || !target || !allowsControl(dragging.id, target)) { clearMark(); return; }
    event.preventDefault();
    const spot = (event.target as HTMLElement).closest<HTMLElement>('[data-from]') ?? zone;
    if (spot !== dropMark) { clearMark(); spot.classList.add('layout-drop-mark'); dropMark = spot; }
    if (event.dataTransfer) event.dataTransfer.dropEffect =
      !dragging.from || (dragging.from === 'rail') !== (target === 'rail') ? 'copy' : 'move';
  }, { signal });
  element.addEventListener('drop', event => {
    if (!dragging) return;
    const zone = dropTarget(event);
    const target = zone?.dataset.drop as ControlTarget | undefined;
    const before = (event.target as HTMLElement).closest<HTMLElement>('[data-from]')?.dataset.control as ControlId | undefined;
    if (target && allowsControl(dragging.id, target)) {
      event.preventDefault();
      place(dragging.id, target, before);
    }
    dragging = undefined;
    clearMark();
  }, { signal });
  element.addEventListener('dragend', () => { dragging = undefined; clearMark(); }, { signal });
  render();
  return { element, read, reflectRuntime };
}
