import { browserWorkbench, requiresBrowserPreview } from './preview-access.ts';
import type { Page, PageContext } from '../../base/page.ts';
import { version as packageVersion } from '../../../../../package.json';
import { legacyWorkspaceDestination, WORKSPACE_PANELS, type WorkspacePanel } from '../../../../framework/workspace.ts';
import { attachModelEditor } from './model-editor-session.ts';
import { inputPanel } from './input-panel.ts';
import { appearancePresets } from './presets.ts';
import { appearancePanel } from './appearance-panel.ts';
import { actionPanel } from './action-panel.ts';
import { settingsPanel } from './settings-panels.ts';
import { preferences, type PreferenceTask } from './preferences.ts';
import { studioNotifications } from './notifications.ts';
import { voiceService, plannerSwitch } from './audio-services.ts';
import { listening } from './listening.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';
import { modelLibrary } from './model-library.ts';
import { runtimeComponents } from './runtime-components.ts';
import { wallpaperPanel } from './wallpaper-panel.ts';
import { modeLabel, runtimeControls, type RuntimeState } from './runtime.ts';
import { modelServicesPanel } from './model-services.ts';
import { controlLayoutPanel } from './control-layout-panel.ts';
import { phoneLinkPanel } from './phone-link.ts';
import { SELF_DEFAULT, SELF_KEYS } from '../../../../framework/body-preferences.ts';
import './control-layout.css';
import '../../../../../web/framework/control-apps.css';
import '../../../../../web/framework/control-toggle.css';
import '../../../../../web/framework/floating-controls.css';
import './tokens.css';
import './studio.css';
import './workspace-layout.css';
import './wallpaper-panel.css';
import './scene-workspace.css';
import './runtime-details.css';
import './phone-link.css';
import '../../../../../web/framework/wallpaper-placement.css';
import '../../../../../web/framework/scene-size.css';
import { cabinPanel } from './cabin-panel.ts';
import { sceneDetails, sceneWorkspace } from './scene-workspace.ts';
import { mountConversation } from './conversation-panel.ts';

type Section = { id: string; nodes: Node[]; read?: () => void | Promise<unknown> };
const scrollPositions = new WeakMap<Document, Map<WorkspacePanel, number>>();
const editorTasks: Record<string, [string, string]> = {
  framing: ['取景与裁切', 'Framing'], bindings: ['动作与表情', 'Actions and expressions'],
  wardrobe: ['装扮规则', 'Wardrobe rules'], visual: ['模型配色', 'Model colors'],
  behavior: ['移动与注视', 'Movement and gaze'], mouth: ['口型映射', 'Mouth mapping'],
};

export function workspacePage(id: WorkspacePanel): Page {
  const [, cn, en] = WORKSPACE_PANELS.find(panel => panel[0] === id)!;
  const label = t(cn, en);
  return { route: id, label, icon: 'settings', mount: ctx => mount(ctx, id, label) };
}

function mount(ctx: PageContext, panel: WorkspacePanel, label: string): void {
  const { root, signal } = ctx, c = studioControls(ctx);
  const doc = c.doc, win = doc.defaultView!;
  const query = new URLSearchParams(win.location.hash.split('?')[1]);
  const destination = legacyWorkspaceDestination(query, panel);
  if (destination && destination !== win.location.hash) { win.location.replace(destination); return; }

  root.classList.add('pet-studio');
  root.dataset.workspacePanel = panel;
  if (panel === 'framework' && query.get('task') === 'conversation') {
    mountConversation(ctx);
    return;
  }
  const components = runtimeComponents(ctx, packageVersion);
  const surface = c.node('main', '', 'studio-surface');
  surface.setAttribute('aria-label', label);
  surface.tabIndex = -1;
  const body = c.node('div', '', 'studio-task');
  surface.append(body);

  const notifications = studioNotifications(ctx), { notify } = notifications;

  let state: RuntimeState | undefined, reading: Promise<void> | undefined;
  let runtimeError = '';
  const observers: Array<(state: RuntimeState) => void> = [];
  function refresh(): Promise<void> {
    reading ??= c.call<RuntimeState>('runtime.state').then(next => {
      if (signal.aborted) return;
      state = next;
      for (const render of observers) render(next);
      if (runtimeError && notifications.current() === runtimeError) notify('');
      runtimeError = '';
    }).catch(error => {
      if (state || signal.aborted) return;
      runtimeError = t('读取桌宠状态失败。', 'Could not read pet status. ') + errorText(error);
      notify(runtimeError);
    }).finally(() => { reading = undefined; });
    return reading;
  }
  const runtime = runtimeControls(ctx, async () => {
    await reading;
    await refresh();
  }, notify);
  const version = c.button('v' + packageVersion, runtime.openDetails);
  version.classList.add('studio-version');
  version.setAttribute('aria-haspopup', 'dialog');
  version.setAttribute('aria-label', 'v' + packageVersion + ' · ' + t('运行详情', 'Runtime details'));
  version.title = t('运行详情与组件', 'Runtime details and components');
  observers.push(runtime.render);
  const routeRoot = root.parentElement;
  const header = routeRoot?.previousElementSibling?.querySelector(':scope > .providerintro > .pagetitle-row')?.parentElement;
  const headerTools = c.node('div', '', 'studio-header-tools');
  headerTools.append(runtime.launch, version);
  if (header && routeRoot?.classList.contains('panelslot')) {
    header.append(headerTools);
    // Coo reuses this wrapper when selecting another tab in the same World.
    header.parentElement?.classList.add('studio-workspace-chrome');
    const tabs = header.parentElement?.querySelector<HTMLElement>('.providertabs');
    const activeTab = tabs?.querySelector<HTMLElement>('.pagetab.active');
    if (tabs && activeTab) {
      const reveal = () => {
        const view = tabs.getBoundingClientRect(), selected = activeTab.getBoundingClientRect();
        if (selected.left < view.left) tabs.scrollLeft += selected.left - view.left;
        else if (selected.right > view.right) tabs.scrollLeft += selected.right - view.right;
      };
      reveal();
      if (typeof win.ResizeObserver === 'function') {
        const observer = new win.ResizeObserver(reveal);
        observer.observe(tabs);
        signal.addEventListener('abort', () => observer.disconnect(), {once:true});
      }
    }
    signal.addEventListener('abort', () => headerTools.remove(), { once: true });
  } else {
    root.classList.add('studio-standalone');
    root.append(headerTools);
  }
  root.append(surface);
  const prefs = preferences(ctx, notify);
  const startup = c.node('details', '', 'studio-runtime-startup');
  const startupTitle = c.node('summary', t('高级启动设置', 'Advanced startup settings'));
  const diagnostics = c.node('div', '', 'studio-runtime-config');
  startup.append(startupTitle, diagnostics);
  startup.addEventListener('toggle', () => {
    if (startup.open) void preferenceBody('runtime', diagnostics);
  }, {signal});
  const componentLink = c.button(t('Live2D 组件与许可', 'Live2D components and licenses'), () => {
    runtime.detail.element.close();
    version.focus({ preventScroll: true });
    void components.open(() => runtime.openDetails(version));
  });
  componentLink.setAttribute('aria-haspopup', 'dialog');
  componentLink.classList.add('studio-runtime-link');
  runtime.detailLinks.prepend(componentLink);
  runtime.detailBody.append(startup, runtime.detailLinks);

  type SettingsView = ReturnType<typeof c.dialog>;
  const settingsTasks = new Map<string, () => void>();
  function settingsDialog(title: string) {
    return c.dialog(title, 'studio-settings-dialog');
  }
  function preferenceBody(key: PreferenceTask, parent: HTMLElement) {
    if (!parent.querySelector('.studio-settings-fields')) {
      parent.replaceChildren(c.node('p', t('正在读取…', 'Reading…'), 'studio-help'));
    }
    return prefs.view(key).then(node => {
      if (signal.aborted) return;
      node.classList.add('studio-settings-fields');
      if (parent.firstChild !== node || parent.childElementCount !== 1) parent.replaceChildren(node);
    }).catch(error => {
      if (signal.aborted) return;
      const old = parent.querySelector('.studio-settings-fields');
      const problem = c.node('div', '', 'studio-inline studio-settings-retry');
      const message = c.status();
      message.textContent = errorText(error);
      problem.append(message, c.button(t('重试','Retry'), () => void preferenceBody(key, parent)));
      parent.replaceChildren(...(old ? [old, problem] : [problem]));
    });
  }
  function settingsRow(id: string, title: string, summary: HTMLElement, buttons: {
    title: string; open: () => void; extra?: HTMLElement; control?: HTMLElement; below?: HTMLElement;
  }, read?: Section['read']): Section {
    const row = c.node('section', '', 'studio-settings-row');
    const identity = c.node('div', '', 'studio-settings-identity');
    const actions = c.node('div', '', 'studio-settings-actions');
    const configure = c.button(buttons.title, buttons.open);
    configure.setAttribute('aria-haspopup', 'dialog');
    identity.append(c.node('h2', title), summary);
    if (buttons.control) actions.append(buttons.control);
    if (buttons.extra) actions.append(buttons.extra);
    actions.append(configure);
    row.append(identity, actions);
    if (buttons.below) row.append(buttons.below);
    settingsTasks.set(id, () => { configure.focus({preventScroll:true}); buttons.open(); });
    return { id, nodes: [row], read };
  }
  const stateLabel = (on: unknown) => on === true ? t('已开启', 'On') : on === false ? t('已关闭', 'Off') : '';
  const displaySummary = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(' · ') || t('正在读取…', 'Reading…');
  function preferenceRow(
    id: PreferenceTask, title: string, buttonTitle: string, describe: () => string,
    init?: (dialog: SettingsView) => HTMLElement | void, extra?: HTMLElement,
  ) {
    const dialog = settingsDialog(buttonTitle);
    const preferencesPane = c.node('div');
    const summary = c.status('studio-settings-summary');
    const sync = () => { summary.textContent = describe(); };
    prefs.subscribe(sync);
    const additional = init?.(dialog);
    dialog.body.append(preferencesPane);
    if (additional) dialog.body.append(additional);
    const open = () => {
      if (!dialog.open()) return;
      void preferenceBody(id, preferencesPane);
    };
    return settingsRow(id, title, summary, { title: buttonTitle, open, extra }, prefs.refresh);
  }
  function inlinePreferences(id: PreferenceTask, title: string, extra?: HTMLElement): Section {
    const group = c.node('section', '', 'studio-inline-preferences');
    const heading = c.node('header');
    heading.append(c.node('h2', title));
    if (extra) heading.append(extra);
    const fields = c.node('div');
    group.append(heading, fields);
    return { id, nodes: [group], read: () => preferenceBody(id, fields) };
  }
  function bodyEffectsSettings() {
    const view = settingsPanel(ctx, {
      title: t('身体整体效果', 'Whole-body effects'),
      hint: '',
      method: 'setBodyEffects',
      refresh, feedback: notify,
    });
    observers.push(next => view.render(next.framework.configuration.bodyEffects));
    return view.element;
  }
  const sections: Section[] = [];
  let openTask: ((id: string) => void) | undefined;
  let poll: (() => void) | undefined;

  switch (panel) {
    case 'framework': {
      let previewFrame: HTMLIFrameElement | undefined, previewReady = false;
      const receivers = new Map<string, (error?: string) => void>();
      const editor = attachModelEditor(ctx, (kind, input) => {
        if (!editDialog.element.open || (kind === 'restore' && !previewReady)) return;
        if (!previewReady || !previewFrame?.contentWindow) return Promise.reject(Error(t('预览还在准备，稍后再试。', 'The preview is still loading. Try again shortly.')));
        const id = win.crypto.randomUUID();
        const frame = previewFrame;
        return new Promise<void>((resolve, reject) => {
          const timer = win.setTimeout(() => { receivers.delete(id); reject(Error(t('预览响应超时。','Preview response timed out.'))); }, 2800);
          receivers.set(id, error => { win.clearTimeout(timer); receivers.delete(id); if (error) reject(Error(error)); else resolve(); });
          frame.contentWindow?.postMessage({type:'live2d-editor:preview',id,kind,...input},new URL(frame.src).origin);
        });
      });
      const appearance = appearancePanel(ctx), actions = actionPanel(ctx);
      const presets = appearancePresets(ctx, {
        skin: () => state?.skin.figure ? state.skin : undefined,
        confirmSwitch: editor.confirmDiscard,
        changed: async () => { await refresh(); await appearance.refresh(); },
      });
      const editDialog = c.dialog(t('编辑模型', 'Edit model'), 'studio-editor-dialog');
      const currentAppearance = c.dialog(t('当前装扮', 'Current appearance'), 'studio-editor-form');
      const playback = c.dialog(t('动作试播', 'Action playback'), 'studio-editor-form');
      currentAppearance.body.append(appearance.element, presets.element);
      playback.body.append(actions.element);
      const taskMenu = c.node('nav', '', 'studio-editor-nav');
      taskMenu.setAttribute('aria-label', t('编辑任务', 'Editing tasks'));
      const compactTask = c.node('select', '', 'studio-editor-task-picker');
      compactTask.setAttribute('aria-label', t('编辑任务', 'Editing task'));
      const editLayout = c.node('div', '', 'studio-edit-layout');
      const editView = c.node('div', '', 'studio-edit-view');
      const previewArea = c.node('div', '', 'studio-model-edit-preview');
      const previewToggle = c.button(t('查看模型预览', 'Show model preview'), () => setPreview(!editLayout.classList.contains('is-previewing')));
      function setPreview(visible: boolean) {
        editLayout.classList.toggle('is-previewing', visible);
        previewToggle.textContent = visible ? t('返回编辑', 'Back to editing') : t('查看模型预览', 'Show model preview');
        previewToggle.setAttribute('aria-pressed', String(visible));
      }
      previewToggle.classList.add('studio-editor-preview-toggle');
      const viewStatus = c.status('studio-preview-unavailable');
      previewArea.append(viewStatus);
      editView.append(previewArea);
      editLayout.append(taskMenu, editView, editor.element);
      taskMenu.append(compactTask, previewToggle);
      editDialog.body.append(editLayout);
      function editorPreview(target: string | undefined, task: string) {
        previewReady = false;
        previewFrame = undefined;
        previewArea.replaceChildren();
        const id = target ?? state?.skin.figure;
        if (!id || !state?.url) {
          viewStatus.textContent = t('模型预览暂不可用。', 'Model preview is unavailable.');
          previewArea.append(viewStatus);
          return;
        }
        const url = new URL('/model-preview', state.url);
        url.searchParams.set('model', id);
        url.searchParams.set('edit', '1');
        if (requiresBrowserPreview(win)) {
          const link = c.node('a', t('在浏览器中编辑并实时预览', 'Edit and preview in browser'), 'studio-link');
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.href = browserWorkbench(win, url, task, id);
          previewArea.append(link);
          return;
        }
        const frame = c.node('iframe', '', 'studio-preview-frame');
        frame.src = url.href; frame.title = t('模型查看器', 'Model viewer');
        previewArea.append(frame);
        previewFrame = frame;
      }
      win.addEventListener('message', event => {
        if (!previewFrame || event.source !== previewFrame.contentWindow || event.origin !== new URL(previewFrame.src).origin) return;
        if (event.data?.type === 'live2d-editor:ready') previewReady = true;
        else if (event.data?.type === 'live2d-editor:receipt') receivers.get(event.data.id)?.(event.data.error);
        else if (event.data?.type === 'live2d-preview:close') editDialog.element.close();
      }, {signal});
      editDialog.element.addEventListener('close', () => { editor.deactivate(); previewReady = false; previewFrame = undefined; previewArea.replaceChildren(); }, { signal });
      const currentTools = c.node('div', '', 'studio-current-tools');
      const effects = c.dialog(t('身体整体效果', 'Whole-body effects'), 'studio-editor-form');
      effects.body.append(bodyEffectsSettings());
      let pendingTarget = '';
      function selectEditorSection(id: string) {
        setPreview(false);
        editor.selectSection(id);
        compactTask.value = id;
        for (const button of taskMenu.querySelectorAll<HTMLButtonElement>('button[data-section]')) {
          button.setAttribute('aria-pressed', String(button.dataset.section === id));
        }
      }
      compactTask.addEventListener('change', () => selectEditorSection(compactTask.value), {signal});
      async function openEditor(id: string, target?: string) {
        if (editDialog.element.open) { selectEditorSection(id); return; }
        if (pendingTarget) return;
        const token = pendingTarget = c.doc.defaultView!.crypto.randomUUID();
        try {
          const explicitTarget = target && target !== state?.skin.figure ? target : undefined;
          const loaded = await editor.ensureLoaded(explicitTarget);
          if (signal.aborted) return;
          if (!loaded) {
            const failure = editor.loadFailure();
            if (failure) notify(failure);
            return;
          }
          if (!editDialog.open()) return;
          setPreview(false);
          editorPreview(target, id);
          if (signal.aborted || !editDialog.element.open) return;
          const chosen = target ?? state?.skin.figure;
          const cardName = chosen && [...root.querySelectorAll<HTMLElement>('.studio-model-card')].find(card => card.dataset.resource === chosen)?.querySelector('h3')?.textContent;
          editDialog.heading.textContent = cardName ? t('编辑 ', 'Edit ') + cardName : t('编辑模型', 'Edit model');
          selectEditorSection(id);
        } catch (error) { notify(errorText(error)); }
        finally { if (pendingTarget === token) pendingTarget = ''; }
      }
      for (const [id, names] of Object.entries(editorTasks)) {
        const option = c.node('option', t(...names));
        option.value = id;
        compactTask.append(option);
        const button = c.button(t(...names), () => selectEditorSection(id));
        button.dataset.section = id;
        taskMenu.insertBefore(button, compactTask);
      }
      currentTools.append(
        c.button(t('当前装扮', 'Current outfit'), () => { if (currentAppearance.open()) void Promise.all([appearance.refresh(), presets.read()]); }),
        c.button(t('动作试播', 'Try actions'), () => { if (playback.open()) void actions.refresh(); }),
        c.button(t('身体整体效果', 'Whole-body effects'), () => effects.open()),
      );
      async function openBrowserEditor(task: string, id?: string) {
        try {
          const result = await c.call<{open?: boolean}>('runtime.openEditor', [id ?? state?.skin.figure, task]);
          if (!result?.open && Object.hasOwn(editorTasks,task)) await openEditor(task,id);
        } catch(error) { notify(errorText(error)); }
      }
      const phone = phoneLinkPanel(ctx);
      const library = modelLibrary(ctx, editor, refresh, notify, id => void openBrowserEditor('framing', id), currentTools, () => void components.open(), phone.element);
      observers.push(next => { editor.modelChanged(next.skin.figure ?? ''); library.render(next); presets.lock(); });
      sections.push({ id: 'library', nodes: [library.element], read: library.refresh });
      void phone.update();
      openTask = id => {
        if (id === 'appearance') { if (currentAppearance.open()) void Promise.all([appearance.refresh(), presets.read()]); }
        else if (id === 'play') { if (playback.open()) void actions.refresh(); }
        else if (Object.hasOwn(editorTasks, id) || id === 'touch') void openBrowserEditor(id, query.get('model') ?? undefined);
      };
      poll = () => { void library.poll(); if (playback.element.open) void actions.refresh(); if (currentAppearance.element.open) void appearance.refresh(); };
      break;
    }
    case 'sound': {
      const effects = settingsDialog(t('音效设置', 'Sound effect settings'));
      const quick = c.node('div', '', 'studio-effects-quick');
      const effectSummary = c.status('studio-settings-summary');
      const syncEffects = () => {
        effectSummary.textContent = displaySummary(stateLabel(prefs.value('sound')));
      };
      prefs.subscribe(syncEffects);
      const speech = settingsDialog(t('说话声设置', 'Speech settings'));
      const voice = voiceService(ctx, speech.element), planner = plannerSwitch(ctx);
      speech.body.classList.add('studio-sound-panel');
      speech.body.append(voice.element, planner.element);

      const input = settingsDialog(t('输入设置', 'Input settings'));
      input.element.classList.add('studio-input-settings');
      const inputTitle = input.heading.textContent!;
      const back = c.button(t('返回输入设置', 'Back to input settings'), () => showInput());
      back.classList.add('studio-settings-back');
      const advanced = c.button(t('高级识别设置', 'Advanced recognition'), () => {
        inputView(t('高级识别设置', 'Advanced recognition'), recognition);
        void preferenceBody('recognition', recognition);
      });
      const recognition = c.node('div');
      const listen = listening(ctx, advanced, () => inputView(t('最近识别', 'Recent recognition'), listen.recent), notify, true);
      input.body.append(listen.element);
      let inputTrigger: HTMLElement | null = null;
      let inputScroll = 0;
      input.element.addEventListener('close', () => {
        inputTrigger = null;
        inputScroll = 0;
      }, {signal});

      function inputView(title: string, content: HTMLElement) {
        inputTrigger = c.doc.activeElement as HTMLElement | null;
        inputScroll = input.body.scrollTop;
        input.heading.textContent = title;
        input.body.replaceChildren(back, content);
        input.body.scrollTop = 0;
        back.focus();
      }
      function showInput() {
        input.heading.textContent = inputTitle;
        input.body.replaceChildren(listen.element);
        input.body.scrollTop = inputScroll;
        if (inputTrigger?.isConnected) inputTrigger.focus({preventScroll:true});
        inputTrigger = null;
      }
      sections.push(
        settingsRow('sound-effects', t('音效', 'Sound effects'), effectSummary, {
          title: t('音效设置', 'Sound effect settings'), control: quick, open() {
            if (effects.open()) {
              void preferenceBody('sound-effects', effects.body);
            }
          },
        }, () => preferenceBody('sound-quick', quick)),
        settingsRow('speech', t('说话声', 'Voice'), voice.summary, {
          title: t('说话声设置', 'Speech settings'), open() {
            if (!speech.open()) return;
            voice.prepare();
            void Promise.all([voice.read(), planner.read()]);
          },
        }, () => Promise.all([voice.read(), planner.read()])),
        settingsRow('listening', t('语音输入', 'Voice input'), listen.summary, {
          title: inputTitle, control: listen.enabled, below:listen.quick, open() {
            if (!input.open()) return;
            showInput();
            void listen.refresh();
          },
        }, listen.refresh),
      );
      poll = () => {
        void prefs.refresh(); void listen.refresh(); void voice.read();
        if (speech.element.open) void planner.read();
      };
      break;
    }
    case 'desktop': {
      const workspace = sceneWorkspace(ctx);
      const wallpaper = wallpaperPanel(ctx, refresh, workspace);
      const cabin = cabinPanel(ctx, refresh, () => workspace.open(cabinPage, cabin.card));
      const cabinView = sceneDetails(ctx, 'cabin', cabin.hint, cabin.section);
      const cabinPage = {title: cabin.title, body: cabinView.detail, action: cabin.action, open: () => void cabin.refresh()};
      const openApps = new Map<string, () => void>();
      const desktop = inlinePreferences('desktop', t('桌面活动', 'Desktop activity'));
      (desktop.nodes[0] as HTMLElement).classList.add('studio-scene-settings');
      runtime.scene.classList.add('studio-scene-settings');
      for (const [mode, app] of runtime.sceneApps) {
        const extras = mode === 'desktop' ? desktop.nodes as HTMLElement[]
          : mode === 'room' ? [runtime.scene] : mode === 'wallpaper' ? [wallpaper.section] : [];
        const {detail, content} = sceneDetails(ctx, mode, app.hint, app.settings, ...extras);
        const page = {
          title: modeLabel(mode), body: detail, action: app.enter,
          open: () => runtime.showScene(mode, content), close: () => runtime.closeScene(mode),
        };
        const open = () => workspace.open(page, app.button);
        openApps.set(mode, open);
        settingsTasks.set(mode, open);
        if (mode === 'wallpaper') {
          settingsTasks.set('wallpaper', () => { open(); wallpaper.open(wallpaper.openLibrary); });
          settingsTasks.set('wallpaper-enter', () => {
            open();
            if (!wallpaper.hasSelection()) wallpaper.open(app.enter);
          });
        }
        workspace.grid.append(app.button);
      }
      runtime.onSceneOpen(mode => openApps.get(mode)?.());
      runtime.onWallpaper(wallpaper.open, wallpaper.hasSelection);
      workspace.grid.append(cabin.card);
      observers.push(wallpaper.renderRuntime);
      settingsTasks.set('cabin', () => workspace.open(cabinPage, cabin.card));
      sections.push({id: 'space', nodes: [workspace.element], read: async () => {
        await Promise.all([desktop.read?.(), cabin.refresh(), wallpaper.refresh()]);
        if (state && !signal.aborted) runtime.render(state);
      }});
      poll = () => { runtime.refreshScene(); void cabin.refresh(); };
      break;
    }
    case 'interaction': {
      const input = inputPanel(ctx);
      const chat = c.button(t('打开 Coo 对话', 'Open Coo conversation'), () => {
        void c.call('runtime.openConversation').catch(error => notify(errorText(error)));
      });
      const type = c.button(t('打开桌宠打字框', 'Type to the pet'), () => {
        void c.call('runtime.openChat').catch(error => notify(errorText(error)));
      });
      const chatActions = c.node('div', '', 'studio-inline studio-conversation-actions');
      chatActions.append(chat, type);
      function reflectTyping(visible: boolean) {
        type.disabled = !visible;
        type.title = visible ? '' : t('显示 Live2D 后可在桌宠窗口打字', 'Show Live2D to type in the pet window');
      }
      reflectTyping(state?.onDesktop === true);
      observers.push(next => reflectTyping(next.onDesktop === true));
      const editTouch = c.button(t('编辑触碰范围', 'Edit touch areas'), () => {
        void c.call('runtime.openEditor', [state?.skin.figure, 'touch']).catch(error => notify(errorText(error)));
      });
      editTouch.disabled = !state?.skin.figure;
      observers.push(next => { editTouch.disabled = !next.skin.figure; });
      const diagnostics = settingsDialog(t('模型按键测试', 'Model input test'));
      diagnostics.body.append(input.element);
      const test = c.status('studio-settings-summary');
      test.textContent = t('检查当前模型的键鼠响应', 'Check the current model’s keyboard and mouse response');
      sections.push(
        inlinePreferences('shortcuts', t('桌面入口', 'Desktop controls'), c.link(t('编辑操作台布局','Edit control layout'), 'controls')),
        inlinePreferences('touch', t('触摸回应', 'Touch response'), editTouch),
        inlinePreferences('identity', t('对话', 'Conversation'), chatActions),
        settingsRow('input', t('模型按键测试', 'Model input test'), test, {
          title: t('打开测试', 'Open test'), open() { if (diagnostics.open()) void input.refresh(); },
        }),
      );
      poll = () => { if (diagnostics.element.open) void input.refresh(); };
      break;
    }
    case 'controls': {
      const editor = controlLayoutPanel(ctx, notify);
      observers.push(editor.reflectRuntime);
      sections.push({ id: 'layout', nodes: [editor.element], read: editor.read });
      break;
    }
    case 'display': {
      const sample = c.node('aside', '', 'studio-preview-sample');
      sample.append(c.node('h3', t('气泡预览', 'Bubble preview')));
      const bubble = c.node('p', t('嘿，今天想做点什么？', 'Hey, what are we doing today?'), 'studio-display-sample');
      const voice = c.node('p', t('去小屋吧', 'Let’s go to the room'), 'studio-display-sample is-voice');
      voice.setAttribute('aria-label', t('语音转写示例', 'Voice transcript example'));
      bubble.setAttribute('aria-label', t('角色发言示例', 'Character reply example'));
      sample.append(voice,bubble);
      function syncBubble(next = state) {
        if (!next) return;
        sample.dataset.theme = next.theme ?? 'light';
        sample.style.setProperty('--sample-text', (next.fontSize ?? 1) * 14.5 + 'px');
        sample.style.setProperty('--sample-width', Math.min(100, (next.bubbleSize ?? 1) * 78) + '%');
      }
      const rate = c.node('p', '', 'studio-fps-summary');
      rate.setAttribute('role', 'status');
      prefs.subscribe(() => {
        const fps = prefs.value('window.frameRate');
        if (typeof fps !== 'number') return;
        const moving = fps === 0 ? t('跟随屏幕', 'Follow display') : fps + ' FPS';
        const resting = prefs.value('window.lockFrameRate') === true ? moving : '30 FPS';
        rate.textContent = t('活动 ', 'Active ') + moving + ' · ' + t('静止 ', 'At rest ') + resting;
      });
      observers.push(syncBubble);
      const performance = inlinePreferences('performance', t('渲染帧率', 'Frame rate'));
      performance.nodes[0].appendChild(rate);
      const bubbles = preferenceRow('bubbles', t('气泡', 'Bubbles'), t('气泡设置', 'Bubble settings'),
        () => displaySummary(prefs.value('statusBubble') === true ? t('显示状态气泡', 'Status bubbles on') : t('状态气泡关闭', 'Status bubbles off'),
          prefs.value('saidBubbles') === true ? t('显示文字发送气泡', 'Sent text bubbles on') : t('文字发送气泡关闭', 'Sent text bubbles off')));
      bubbles.nodes[0].appendChild(sample);
      const fullscreen = inlinePreferences('fullscreen', t('全屏与直播', 'Fullscreen and streaming'));
      const captureFeedback = c.status('studio-help');
      captureFeedback.hidden = true;
      const overlayUrl = c.node('input');
      overlayUrl.type = 'url';
      overlayUrl.readOnly = true;
      overlayUrl.setAttribute('aria-label', t('OBS 浏览器源地址', 'OBS browser source address'));
      const overlayCopy = c.button(t('复制地址', 'Copy address'), () => {
        const selectAddress = () => { overlayUrl.focus(); overlayUrl.select(); };
        const clipboard = win.navigator.clipboard;
        if (!clipboard) { selectAddress(); return; }
        void clipboard.writeText(overlayUrl.value).then(
          () => notify(t('已复制 OBS 浏览器源地址。', 'Copied the OBS browser source address.'), 'success'),
          selectAddress,
        );
      });
      const overlayControls = c.node('div', '', 'studio-inline studio-overlay-address');
      overlayControls.append(overlayUrl, overlayCopy);
      const overlaySource = c.node('div', '', 'studio-field');
      const overlayDescription = c.node('div', '', 'studio-field-copy');
      overlayDescription.append(c.node('strong', t('OBS 浏览器源', 'OBS browser source')),
        c.node('small', t('OBS 浏览器源主动输出 Live2D 画面。', 'The OBS browser source streams Live2D directly.')));
      overlaySource.append(overlayDescription, overlayControls);
      overlaySource.hidden = true;
      const captureLabels = {
        excluded: t('Windows 已将 Live2D 窗口设为排除采集。', 'Windows has excluded the Live2D window from capture.'),
        allowed: t('Windows 允许采集 Live2D 窗口。', 'Windows allows capture of the Live2D window.'),
        limited: t('Windows 会隐藏窗口内容，录屏中仍可能看到窗口占位。', 'Windows hides the window contents. The window can still appear as a blank area.'),
        failed: t('Windows 未应用截图和录屏设置。', 'Windows did not apply the capture setting.'),
        unverified: t('已请求 Windows 更新录屏设置，暂时无法读取系统状态。', 'Capture settings were sent to Windows. The system state could not be verified.'),
        unsupported: t('当前窗口宿主不支持这项设置。', 'The current window host does not support this setting.'),
        pending: t('等待 Windows 确认采集状态。', 'Waiting for Windows to confirm capture status.'),
        offline: t('下次启动 Live2D 时应用录屏设置。', 'The capture setting will apply when Live2D starts.'),
      };
      observers.push(next => {
        const compatibility = next.windowCompatibility;
        captureFeedback.hidden = prefs.value('window.hideFromCapture') === undefined || !compatibility;
        if (compatibility && captureFeedback.textContent !== captureLabels[compatibility.capture]) {
          captureFeedback.textContent = captureLabels[compatibility.capture];
        }
        overlaySource.hidden = !next.overlayUrl;
        if (overlayUrl.value !== (next.overlayUrl ?? '')) overlayUrl.value = next.overlayUrl ?? '';
      });
      fullscreen.nodes[0].appendChild(captureFeedback);
      fullscreen.nodes[0].appendChild(overlaySource);
      sections.push(
        inlinePreferences('display', t('桌宠外观', 'Pet appearance')),
        bubbles,
        performance,
        fullscreen,
      );
      break;
    }
    case 'permissions': {
      const labels = {
        figure: t('角色', 'Character'), scheme: t('装扮', 'Outfits'), roam: t('活动', 'Roaming'),
        snoreSeconds: t('呼噜时长', 'Purring'), sound: t('音效', 'Sound'), scale: t('角色大小', 'Character size'),
        bubbleSize: t('气泡大小', 'Bubble size'), fontSize: t('文字大小', 'Text size'), theme: t('主题', 'Theme'),
        hoverButtons: t('靠近按钮', 'Hover buttons'), user: t('称呼', 'Name'),
      };
      const list = c.node('dl', '', 'studio-permission-summary');
      const area = c.node('section', '', 'studio-inline-preferences studio-access-editor');
      area.append(c.node('h2',t('允许 Coo 调整桌宠','Allow Coo to adjust the pet')));
      const modeSelect = c.node('select');
      for(const [value, label] of [['off',t('关闭','Off')],['default',t('默认范围','Default scope')],['custom',t('自定义','Custom')],['any',t('全部允许','Allow all')]]) {
        const option=c.node('option',label);option.value=value;modeSelect.append(option);
      }
      const banner = c.status('studio-permission-feedback');
      const fields = c.node('div','','studio-permission-options');
      const switches = SELF_KEYS.map(key=>{
        const box=c.node('input');box.type='checkbox';box.setAttribute('role','switch');
        fields.append(c.field(labels[key],box));return [key,box] as const;
      });
      const buttons = c.node('div','','studio-inline studio-permission-actions');
      let changed=false, saving=false;
      const discard=c.button(t('撤销修改','Revert changes'),()=>{changed=false;banner.textContent='';syncPermissions();});
      const save=c.button(t('应用权限','Apply permissions'),()=>void apply(),true);
      buttons.append(banner,discard,save);
      area.append(c.field(t('授权范围','Permission scope'),modeSelect,t('仅影响 Live2D 的自行调整。','Applies to self-adjustment of this Live2D pet.')),list,fields,buttons);
      function syncPermissions(){
        if(!changed && !saving){
          modeSelect.value=String(prefs.value('selfAdjust')??state?.selfAdjust?.mode??'default');
          for(const [key,box] of switches)box.checked=state?.selfAdjust?.custom[key]??SELF_DEFAULT[key];
        }
        drawPermissions();
      }
      function drawPermissions() {
        const mode = modeSelect.value;
        fields.hidden=mode!=='custom';modeSelect.disabled=saving;
        for(const[,box] of switches)box.disabled=saving;
        save.disabled=discard.disabled=saving||!changed;
        const add = (title: string, values: string) => {
          const row = c.node('div');
          row.append(c.node('dt', title), c.node('dd', values || t('无', 'None')));
          return row;
        };
        if (mode === 'off') {
          list.replaceChildren(add(t('已关闭', 'Off'), t('Coo 的自行调整已关闭。', 'Coo self-adjustment is off.')));
          return;
        }
        const allowed = (key: keyof typeof SELF_DEFAULT) =>
          mode === 'any' || (mode === 'custom' ? switches.find(([id])=>id===key)![1].checked : SELF_DEFAULT[key]);
        const names = (direct: boolean) => SELF_KEYS.filter(key => allowed(key) === direct).map(key => labels[key]).join(t('、', ', '));
        list.replaceChildren(add(t('可直接调整', 'Can adjust'), names(true)), add(t('先询问你', 'Ask first'), names(false)));
      }
      function update(){changed=true;banner.textContent=t('未应用。上方是应用后的权限。','Not applied. The list previews the resulting permissions.');drawPermissions();}
      modeSelect.addEventListener('change',update,{signal});
      for(const[,box] of switches)box.addEventListener('change',update,{signal});
      async function apply(){
        if(saving||!changed)return;
        saving=true;drawPermissions();
        try{
          await prefs.applySelf(modeSelect.value,Object.fromEntries(switches.map(([key,box])=>[key,box.checked])));
          await refresh();
          changed=false;banner.textContent=t('权限已应用','Permissions applied');
        }catch(error){banner.textContent=errorText(error);}
        finally{saving=false;syncPermissions();}
      }
      prefs.subscribe(syncPermissions);
      observers.push(syncPermissions);
      sections.push({id:'autonomy',nodes:[area],read:prefs.refresh});
      break;
    }
    case 'services': {
      const services = modelServicesPanel(ctx, notify);
      sections.push({ id: 'services', nodes: [services.element], read: services.read });
      break;
    }
  }
  if (['sound', 'interaction', 'display', 'permissions'].includes(panel)) body.dataset.layout = 'settings';
  const anchors = new Map<string, HTMLElement>();
  for (const section of sections) {
    const container = c.node('div', '', 'studio-page-section');
    container.dataset.task = section.id;
    container.append(...section.nodes.filter(Boolean));
    body.append(container);
    anchors.set(section.id, container);
  }
  const positions = scrollPositions.get(doc) ?? new Map<WorkspacePanel, number>();
  scrollPositions.set(doc, positions);
  const savedScroll = positions.get(panel) ?? 0;
  surface.scrollTop = savedScroll;
  surface.addEventListener('scroll', () => positions.set(panel, surface.scrollTop), { signal, passive: true });
  const task = query.get('task');
  void Promise.allSettled([refresh(), ...sections.map(section => section.read?.())]).then(results => {
    if (signal.aborted) return;
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') notify(errorText(failure.reason));
    if (!task) { surface.scrollTop = savedScroll; return; }
    const target = ({ recognition: 'listening', tts: 'speech', planner: 'speech', chat: 'identity', editor: 'library', 'desktop-settings': 'desktop' } as Record<string,string>)[task] ?? task;
    if (openTask && (Object.hasOwn(editorTasks, target) || ['appearance', 'play', 'preview'].includes(target))) openTask(target);
    else {
      const anchor = anchors.get(target) ?? (panel === 'desktop' && settingsTasks.has(target) ? anchors.get('space') : undefined);
      if (anchor) {
        surface.scrollTop = anchor.offsetTop - body.offsetTop;
        settingsTasks.get(target)?.();
      }
    }
  });
  ctx.lifecycle.interval(() => { void refresh(); void components.poll(); poll?.(); }, 1500);
}
