import { createModelSizeControl } from './model-size.js';
import { createWallpaperPlacementControl } from './wallpaper-placement-control.js';
import { ICONS } from '../ui.js';
import { controlPhoneRect, positionPhone } from './phone-layout.js';
import { CONTROL_COMPONENTS, CONTROL_SECTIONS, defaultControlLayout } from './control-layout.js';


const DETAILS = {
  actions: { component: 'actions', command: 'actions' },
  wardrobe: { component: 'dress', command: 'appearance' },
  interaction: { component: 'interaction' },
  size: { component: 'size', fallback: 'home' },
  scenes: { component: 'scenes', fallback: 'scene' },
  through: { component: 'through', fallback: 'window' },
  close: { component: 'close', fallback: 'window' },
};
export const DEFAULT_CONTROL_PAGE = 'home';
const APP_DETAILS = { size:'size', scenes:'scenes', actions:'actions', dress:'wardrobe', interaction:'interaction', through:'through', close:'close' };

export function createControlPhone({ root, text, command, scenes, helpers }) {
  const doc = root.ownerDocument;
  const node = (tag, cls) => Object.assign(doc.createElement(tag), { className: cls });
  const frame = node('section', 'control-phone');
  const header = node('header', 'control-phone-header');
  const title = node('h2', 'control-phone-title');
  title.id = 'control-phone-title';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-labelledby', title.id);
  root.removeAttribute('aria-label');

  function button(label, icon, run, cls = 'control-phone-row') {
    const el = node('button', cls);
    el.type = 'button';
    if (icon) {
      const picture = node('span', 'ic');
      picture.innerHTML = ICONS[icon] ?? icon;
      el.append(picture);
    }
    const name = node('span', 'control-phone-label');
    name.textContent = label;
    el.append(name);
    if (run) el.addEventListener('click', run);
    return el;
  }

  const back = button(text('返回上一级', 'Back to section'), 'back', () => void navigate(sectionOf(page)), 'control-phone-icon');
  back.classList.add('control-phone-back');
  back.setAttribute('aria-label', text('返回上一级', 'Back to section'));
  const close = button(text('关闭操作台', 'Close controls'), 'close', helpers.close, 'control-phone-icon');
  close.setAttribute('aria-label', text('关闭操作台', 'Close controls'));
  close.title = text('关闭操作台', 'Close controls');
  close.classList.add('control-phone-close');
  title.tabIndex = -1;

  const headerTools = node('div', 'control-phone-header-tools');
  const connection = node('span', 'control-phone-connection');
  connection.setAttribute('role', 'img');
  headerTools.append(connection, close);
  header.append(back, title, headerTools);
  const content = node('div', 'control-phone-content');
  const footer = node('footer', 'control-phone-footer');
  const feedback = node('p', 'control-phone-feedback');
  feedback.setAttribute('role', 'status');
  const dock = node('nav', 'control-phone-dock');

  dock.setAttribute('aria-label', text('桌宠操作分类', 'Pet control sections'));
  const shortcuts = Object.entries(CONTROL_SECTIONS).map(([id, section]) => {
    const item = button(text(...section.label), section.icon, () => {
      if (page !== id) void navigate(id, false);
    }, 'control-phone-shortcut');
    item.dataset.section = id;
    dock.append(item);
    return item;
  });
  footer.append(dock);
  frame.append(header, content, footer, feedback);
  root.replaceChildren(frame);

  let page = DEFAULT_CONTROL_PAGE, epoch = 0;
  let layout = defaultControlLayout(), layoutKey = JSON.stringify(layout.pages);
  let renderedMode;
  let feedbackTimer = 0;
  let sceneFeedback = null;
  let state = null, fault = '', busy = false;
  let sceneOrder = null, appStatus = null;
  let position = null, placementKey = '';
  let filter = '';
  let outfitDraft = null;


  function sectionOf(view) {
    const detail = DETAILS[view];
    if (!detail) return view;
    return Object.keys(layout.pages).find(id => layout.pages[id].includes(detail.component))
      ?? detail.fallback ?? 'apps';
  }

  function note(value, kind = '') {
    if (feedback.textContent === value && feedback.dataset.kind === kind) return;
    clearTimeout(feedbackTimer);
    feedback.textContent = value;
    feedback.dataset.kind = kind;
    if (value && (kind === 'ok' || kind === 'error')) {
      feedbackTimer = setTimeout(() => note(''), kind === 'ok' ? 2800 : 5200);
    }
  }

  const size = createModelSizeControl({ doc, text, mode: helpers.mode, ...helpers.size, report: note });

  const compositionDetails = node('details','wallpaper-placement-details');
  const compositionSummary = node('summary','');
  compositionSummary.textContent = text('角色构图','Character composition');
  const composition = helpers.wallpaper && createWallpaperPlacementControl({
    doc,text,compact:true,
    preview:helpers.wallpaper.preview,
    read:id => command('wallpaper-placement-state',undefined,{id}),
    save:(id,placement,revision) => command('wallpaper-placement',undefined,{id,placement,revision}),
  });
  if (composition) {
    compositionDetails.append(compositionSummary,composition.element);
    compositionDetails.addEventListener('toggle',() => {
      if (compositionDetails.open && compositionDetails.isConnected) composition.showGuide();
      else if (!compositionDetails.open) composition.deactivate();
    });
  }
  function closeComposition() {
    compositionDetails.open = false;
    composition?.deactivate();
  }

  function focusPage() {
    if (frame.contains(doc.activeElement)) return;
    title.focus({ preventScroll: true });
  }

  async function navigate(app, focus = true) {
    const previous = page;
    closeComposition();
    size.stopPreview();
    helpers.cancelVoice();
    page = app;
    const generation = ++epoch;
    state = null; fault = ''; busy = false; appStatus = null; filter = '';
    content.removeAttribute('aria-busy');
    if (previous === 'wardrobe') clearOutfitTrial();
    note('');
    render();
    content.scrollTop = 0;
    if (focus) title.focus({ preventScroll: true });
    const query = DETAILS[app]?.command;
    if (!query) return;
    content.setAttribute('aria-busy', 'true');
    try {
      const data = await command(query);
      if (epoch !== generation) return;
      state = data;
    } catch (error) {
      if (epoch !== generation) return;
      fault = error.message;
    }
    content.removeAttribute('aria-busy');
    render();
  }

  function label(value, fallback) {
    return text(value?.zh ?? value?.en ?? fallback, value?.en ?? value?.zh ?? fallback);
  }

  function subhead(value) {
    const result = node('h3', 'control-phone-section');
    result.textContent = value;
    return result;
  }

  function choice(name, icon, execute, picked = false, detail = '') {
    const el = button(name, icon, execute);
    el.setAttribute('aria-pressed', String(picked));
    if (detail || picked) {
      const value = node('small', 'control-phone-value');
      value.textContent = detail || text('当前', 'Current');
      el.append(value);
    }
    return el;
  }

  async function run(operation, success, options = {}) {
    if (busy) return;
    const generation = epoch;
    const activeControl = doc.activeElement;
    busy = true;
    for (const control of content.querySelectorAll('button:not(:disabled), select:not(:disabled)')) {
      control.dataset.busyEnabled = '';
      control.disabled = true;
    }
    note(text('处理中…', 'Working…'), 'pending');
    try {
      const next = await operation();
      if (epoch !== generation) return;
      if (next?.axes) state = { ...state, ...next };
      note(typeof success === 'function' ? success(next) : success, 'ok');
    } catch (error) {
      if (epoch !== generation) return;
      note(error.message, 'error');
    } finally {
      if (epoch === generation) {
        busy = false;
        if (options.redraw) {
          const scroll = content.scrollTop;
          const fields = [...content.querySelectorAll('select,button')];
          const focused = fields.indexOf(activeControl);
          render();
          content.scrollTop = scroll;
          if (focused >= 0 && doc.activeElement === doc.body) {
            const same = content.querySelectorAll('select,button')[focused];
            if (same && !same.disabled) same.focus({ preventScroll: true });
            else content.querySelector('select,button:not(:disabled)')?.focus({ preventScroll: true });
          }
        } else for (const control of content.querySelectorAll('[data-busy-enabled]')) {
          control.disabled = false;
          delete control.dataset.busyEnabled;
        }
      }
    }
  }

  function empty(message) {
    const p = node('p', 'control-phone-empty');
    p.textContent = message;
    content.append(p);
  }

  function clearOutfitTrial() {
    outfitDraft = null;
    void helpers.restoreOutfit().catch(() => {});
  }

  const appearanceFeedback = value => value?.observed?.status === 'applied'
    ? text('装扮已应用。', 'Outfit applied.') : text('已保存，等待角色更新。', 'Saved. Waiting for the character.');

  function renderWardrobe() {
    const fields = node('div', 'control-phone-group');
    for (const axis of state.axes) {
      const row = node('label', 'control-phone-field');
      const name = node('span', '');
      name.textContent = label(axis.name, axis.id);
      const select = node('select', '');
      for (const option of axis.options) {
        const item = node('option', '');
        item.value = option.id;
        item.textContent = label(option.name, option.id);
        select.append(item);
      }
      select.value = outfitDraft?.[axis.id] ?? state.desired.picks[axis.id];
      select.addEventListener('change', () => {
        const next = select.value;
        const target = { ...outfitDraft, [axis.id]: next }, generation = epoch;
        void run(async () => {
          await helpers.previewOutfit(state.figure, target, () => epoch === generation);
          if (epoch === generation) outfitDraft = target;
        }, text('正在试穿。', 'Trying on the outfit.'), { redraw: true });

      });
      row.append(name, select);
      fields.append(row);
    }
    if (!state.axes.length) empty(text('这个模型没有可切换的装扮。', 'This model has no outfit options.'));
    else {
      content.append(fields);
      renderOutfitActions();
    }
    if (state.presets?.length) {
      content.append(subhead(text('预设', 'Presets')));
      const figure = state.figure;
      const presets = node('div', 'control-phone-group');
      for (const preset of state.presets) {
        presets.append(button(preset.name, 'shirt', () => void run(async () => {
          const generation = epoch;
          const next = await command('preset', figure, preset.id);
          if (epoch === generation) {
            outfitDraft = null;
            await helpers.restoreOutfit(next.desired.scheme);
          }
          return next;
        }, appearanceFeedback, { redraw: true })));
      }
      content.append(presets);
    }
  }

  function renderOutfitActions() {
    const actions = node('div', 'control-phone-form-actions');
    const cancel = button(text('取消试穿', 'Cancel try-on'), null, () => void run(async () => {
      await helpers.restoreOutfit();
      outfitDraft = null;
    }, text('已还原装扮。', 'Outfit restored.'), { redraw: true }), 'control-phone-form-button');
    const apply = button(text('应用装扮', 'Apply outfit'), null, () => void run(async () => {
      const generation = epoch;
      const next = await command('outfit', state.figure, outfitDraft);
      if (generation === epoch) {
        outfitDraft = null;
        await helpers.restoreOutfit(next.desired.scheme);
      }
      return next;
    }, appearanceFeedback, { redraw: true }), 'control-phone-form-button primary');
    cancel.disabled = apply.disabled = !outfitDraft;
    actions.append(cancel, apply);
    content.append(actions);
  }

  function renderActions() {
    if (!state.vocabulary.length) { empty(text('当前角色没有可用的动作。', 'This character has no available actions.')); return; }
    const input = node('input', 'control-phone-search');
    input.type = 'search';
    input.value = filter;
    input.placeholder = text('搜索动作', 'Search actions');
    input.setAttribute('aria-label', input.placeholder);
    const list = node('div', 'control-phone-actions control-phone-group');
    function showActions() {
      const query = filter.trim().toLocaleLowerCase();
      const matches = state.vocabulary.map(action => {
        const names = action.names ?? {};
        const name = text(names.zh?.[0] ?? names.en?.[0] ?? action.id, names.en?.[0] ?? names.zh?.[0] ?? action.id);
        return { action, name };
      }).filter(item => (item.name + ' ' + item.action.id).toLocaleLowerCase().includes(query));
      list.replaceChildren();
      if (!matches.length) {
        const placeholder = node('p', 'control-phone-empty');
        placeholder.textContent = text('没有匹配的动作。', 'No matching actions.');
        list.append(placeholder);
      }
      for (const { action, name } of matches) {
        const el = button(name, 'play', () => {
          if (busy || appStatus) return;
          const generation = epoch;
          void run(async () => {
            const result = await command('play', state.figure, action.id);
            if (epoch === generation) appStatus = result.requestId;
          }, text('动作已加入播放队列。', 'Action queued.'));
        });
        list.append(el);
      }
    }
    input.addEventListener('input', () => { filter = input.value; showActions(); });
    content.append(input, list);
    showActions();
  }


  function entry(app) {
    const spec = CONTROL_COMPONENTS[DETAILS[app].component];
    const el = button(text(...spec.label), spec.icon, () => void navigate(app),'control-phone-row control-phone-entry');
    const arrow = node('span', 'ic control-phone-entry-arrow');
    arrow.innerHTML = ICONS.back;
    arrow.setAttribute('aria-hidden', 'true');
    el.append(arrow);
    el.dataset.app = app;
    return el;
  }

  function action(id, spec) {
    const el = button(text(...spec.label), spec.icon, null);
    el.dataset.action = id;
    el.classList.add('m-action');
    helpers.connect(el, id);
    return el;
  }

  function switchIndicator(el) {
    const indicator = node('span', 'control-phone-switch');
    indicator.setAttribute('aria-hidden', 'true');
    el.setAttribute('role', 'switch');
    el.append(indicator);
  }

  function renderScenes() {
    const choices = node('div', 'control-phone-group');
    choices.setAttribute('aria-label', text('切换场景', 'Switch scene'));
    for (const [id, scene] of Object.entries(scenes)) {
      const el = choice(text(...scene.label), scene.icon, () => helpers.selectScene(id), id === helpers.mode(), sceneOrder?.mode === id ? text('切换中', 'Switching') : '');
      el.dataset.scene = id;
      el.disabled = id === helpers.mode() || !!sceneOrder;
      choices.append(el);
    }
    if (scenes.wallpaper && helpers.openWallpapers) {
      choices.append(choice(text('打开壁纸库','Open wallpaper library'),scenes.wallpaper.icon,helpers.openWallpapers,false,''));
    }
    const wallpaper = helpers.wallpaper?.current();
    if (wallpaper?.id && composition) {
      composition.sync(wallpaper);
      choices.append(compositionDetails);
    }
    if (sceneOrder) note(text('正在切换场景…', 'Switching views…'), 'pending');
    return choices;
  }

  function renderComponent(id) {
    const spec = CONTROL_COMPONENTS[id];
    switch (id) {
      case 'size':
        size.sync();
        return size.element;
      case 'scenes':
        return renderScenes();
      case 'actions': case 'interaction':
        return entry(id);
      case 'dress':
        return entry('wardrobe');
      case 'roam':
        return renderedMode === 'desktop' ? action(id, spec) : null;
      case 'sound': {
        const el = action(id, spec);
        switchIndicator(el);
        return el;
      }
      case 'chat': case 'voice': case 'theme':
        return action(id, spec);
      default:
        return helpers.component(id, button, switchIndicator);
    }
  }

  function application(id) {
    const detail = APP_DETAILS[id];
    const spec = CONTROL_COMPONENTS[id];
    let tile = detail ? entry(detail) : renderComponent(id);
    if (!tile) {
      tile = button(text(...spec.label),spec.icon);
      tile.disabled = true;
      tile.title = id === 'roam' ? text('桌面场景可用','Available on the desktop') : text('当前窗口不可用','Unavailable in this window');
    } else tile.title = text(...spec.label);
    tile.classList.add('control-app-tile');
    if (id === 'close') tile.classList.add('control-app-danger');
    return tile;
  }

  function renderSection(ids) {
    const items = node('div', 'control-phone-items');
    items.dataset.section = page;
    if (page === 'apps') items.classList.add('control-app-grid');
    for (const id of ids) {
      const component = page === 'apps' ? application(id) : renderComponent(id);
      if (!component) continue;
      component.dataset.component = id;
      items.append(component);
    }
    if (items.childElementCount) content.append(items);
    else empty(text('这个页面还没有操作。', 'No controls on this page yet.'));
  }

  function render() {
    renderedMode = helpers.mode();
    root.dataset.app = page;
    back.hidden = !DETAILS[page];
    title.textContent = text(...(DETAILS[page] ? CONTROL_COMPONENTS[DETAILS[page].component] : CONTROL_SECTIONS[page]).label);
    for (const item of shortcuts) {
      if (item.dataset.section === sectionOf(page)) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    content.replaceChildren();
    if (layout.pages[page]) renderSection(layout.pages[page]);
    else if (['size', 'scenes', 'through', 'close'].includes(page)) {
      if (page === 'through' || page === 'close') {
        const hint = node('p','control-phone-description');
        hint.textContent = page === 'through'
          ? text('启用后，鼠标会直接操作桌宠后面的窗口。可以在 Coo 的运行详情恢复。','Clicks go to the window behind the pet. Restore input in Coo’s runtime details.')
          : text('关闭 Live2D 桌宠窗口。可以从 Coo 的工作台再次启动。','Close the Live2D pet window. You can reopen it from the Coo workbench.');
        content.append(hint);
      }
      renderSection([DETAILS[page].component]);
    }
    else if (page === 'interaction') {
      renderSection(['hoverVisibility', 'touchRegions', 'editTouch']);
      const pause = helpers.pauseButton(button);
      if (pause) content.append(pause);
    }
    else if (fault) {
      empty(fault);
      content.append(button(text('重试', 'Retry'), null, () => void navigate(page)));
    } else if (!state) empty(text('正在读取当前角色…', 'Reading the current character…'));
    else if (page === 'wardrobe') renderWardrobe();
    else renderActions();
    syncActions();
  }

  function syncActions() {
    for (const element of content.querySelectorAll('[data-action]')) {
      helpers.drawAction(element, element.dataset.action);
      if (element.classList.contains('control-app-tile')) element.title = element.dataset.description;
    }
  }

  function syncSettings(online) {
    const status = online ? text('桌宠已连接', 'Pet connected') : text('桌宠连接已断开', 'Pet disconnected');
    connection.dataset.online = String(online);
    connection.setAttribute('aria-label', status);
    connection.title = status;
    if (renderedMode !== helpers.mode()) {
      helpers.cancelVoice();
      size.stopPreview();
      closeComposition();
      render();
    } else {
      const wallpaper = helpers.wallpaper?.current();
      if (compositionDetails.isConnected && wallpaper?.id) composition?.sync(wallpaper);
      size.sync();
      syncActions();
    }
  }

  return {
    open(app, pending) {
      position = null;
      placementKey = '';
      sceneOrder = pending;
      sceneFeedback = null;
      void navigate(app);
    },
    show(app) {
      if (app === page) focusPage();
      else void navigate(app);
    },
    close() {
      ++epoch; appStatus = null;
      closeComposition();
      size.stopPreview();
      content.removeAttribute('aria-busy');
      if (page === 'wardrobe') clearOutfitTrial();
      note('');
    },
    place(anchor, viewport, chat, chrome, dock) {
      const key = [viewport.width, viewport.height, chat?.x, chat?.y, chat?.w, chat?.h, chrome?.top, chrome?.bottom, dock?.left, dock?.top, dock?.right, dock?.bottom].join('/');
      if (!position || key !== placementKey) {
        placementKey = key;
        position = controlPhoneRect(anchor, viewport, chat, chrome, chat && position?.placement, layout.panelSize, dock);
        positionPhone(frame, position);
        frame.dataset.placement = position.placement;
      }
    },
    setLayout(next) {
      const key = JSON.stringify(next.pages);
      if (next.panelSize?.width !== layout.panelSize?.width || next.panelSize?.height !== layout.panelSize?.height) position = null;
      layout = next;
      if (key === layoutKey) return;
      layoutKey = key;
      if (!root.hidden && layout.pages[page]) { helpers.cancelVoice(); size.stopPreview(); render(); }
    },
    scene(pending, feedback) {
      const hasScenes = page === 'scenes' || layout.pages[page]?.includes('scenes');
      const newFeedback = sceneFeedback !== feedback;
      sceneFeedback = feedback;
      if (sceneOrder !== pending) {
        sceneOrder = pending;
        if (hasScenes) {
          const focused = doc.activeElement?.dataset.scene;
          render();
          if (focused) content.querySelector('[data-scene="' + focused + '"]:not(:disabled)')?.focus({ preventScroll: true });
        }
      }
      if (hasScenes && newFeedback && feedback) note(feedback.text, feedback.kind);
    },
    status(value, kind) { note(value, kind); },
    syncSettings,
    applyModelSize: size.sync,
    stopModelSizePreview: size.stopPreview,
    clearPreview() {
      closeComposition();
      if (page === 'wardrobe') void navigate(sectionOf('wardrobe'));
    },
    appearanceApplied(figure) {
      if (page === 'wardrobe' && state?.figure === figure && feedback.dataset.kind === 'ok') {
        note(text('装扮已应用。', 'Outfit applied.'), 'ok');
      }
    },
    actionResult(rows) {
      if (!appStatus || page !== 'actions') return;
      const row = rows?.findLast(item => item.requestId === appStatus);
      if (!row) return;
      if (row.status === 'running') note(text('正在播放…', 'Playing…'), 'pending');
      else if (row.status === 'completed') { note(text('播放完成。', 'Finished.'), 'ok'); appStatus = null; }
      else if (row.status === 'failed' || row.status === 'interrupted') {
        note(text('动作未完成，可以重试。', 'Action did not finish. Try again.'), 'error'); appStatus = null;
      }
    },
  };
}
