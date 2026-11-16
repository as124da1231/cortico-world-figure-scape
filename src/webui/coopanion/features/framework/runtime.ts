import { createModelSizeControl } from '../../../../../web/framework/model-size.js';
import type { PetSkin } from '../../../../config.ts';
import type { PageContext } from '../../base/page.ts';
import type { PresentationMode } from '../../../../framework/presentation-service.ts';
import type { HostState } from '../../../../window-host.ts';
import type { WindowCompatibility } from '../../../../framework/window-compatibility.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';
import type { SettingsState, SpeechState } from './settings-panels.ts';

type Presentation = {
  desired: PresentationMode;
  applied: PresentationMode | null;
  available?: PresentationMode[];
  visible?: boolean;
  operation?: { operationId: string; phase: string; mode: PresentationMode } | null;
  error: string | null;
  details?: { rect?: { width?: number; height?: number; w?:number; h?:number }; view?: {width?:number;height?:number}; stage?: {width?:number;height?:number}; wallpaper?: {title?:string;kind?:string;paused?:boolean} } | null;
};
export type RuntimeState = {
  inWindow: boolean;
  theme?: string;
  presentationScales?: Record<PresentationMode, number>;
  fontSize?: number;
  bubbleSize?: number;
  onDesktop?: boolean;
  url?: string | null;
  bodyReady?: boolean;
  canOpenLive2d?: boolean;
  clickThrough?: boolean;
  windowHint?: string | null;
  windowCompatibility?: WindowCompatibility;
  overlayUrl?: string | null;
  presentation?: Presentation;
  previousModelUnavailable?: boolean;
  skin: PetSkin;
  figureLabel?: string;
  selfAdjust?: { mode: string; custom: Record<string, boolean> };
  window?: HostState | null;
  electron?: { phase: string; supported?: boolean; done: number; total: number | null; detail?: string | null };
  framework: {
    model?: { phase: string; busy: boolean; candidate?: string; error?: string };
    configuration: { bodyEffects: SettingsState; speech?: SpeechState };
  };
};

type Scene = {
  available: boolean;
  mode: PresentationMode;
  scene?: { targets?: string[]; posture?: string } | null;
  active?: { id: string } | null;
  recent?: { id: string; status: string; reason?: string } | null;
};

const modes = {
  desktop: [t('桌面', 'Desktop'), t('在桌面自由活动', 'Roam the desktop')],
  room: [t('小屋', 'Room'), t('在房间里走动、坐下或休息', 'Walk, sit or rest in the room')],
  phone: [t('竖屏', 'Portrait'), t('以实时角色为背景的 9:16 聊天画面', 'A 9:16 chat view with the live character')],
  wallpaper: [t('壁纸', 'Wallpaper'), t('让角色出现在自选背景里', 'Place the live character over a custom background')],
} satisfies Record<PresentationMode, [string, string]>;
const targets: Record<string, string> = {
  door: t('门口', 'Door'), center: t('房间中央', 'Room center'), chair: t('椅子', 'Chair'),
  sofa: t('沙发', 'Sofa'), bed: t('床', 'Bed'),
};
export const modeLabel = (mode?: PresentationMode | null) => mode ? modes[mode][0] : '—';
export const windowLabel = (state: RuntimeState) => state.onDesktop ? t('显示中', 'Visible')
  : state.inWindow ? t('已隐藏', 'Hidden')
    : state.window?.phase === 'running' ? t('正在连接', 'Connecting') : t('未启动', 'Closed');

function reason(code: string) {
  const names: Record<string, string> = {
    'wallpaper-source-unavailable': t('请先从壁纸库选择可用的背景。', 'Choose an available background from the wallpaper library.'),
    'wallpaper-first-frame-failed': t('壁纸未能显示首帧，当前画面已保留。', 'The wallpaper could not draw its first frame. The current view is still active.'),
    'presentation-timeout': t('新画面未能及时就绪，可以重试。', 'The view took too long to load. Try again.'),
    'window-disconnected': t('窗口连接已断开，请先恢复窗口。', 'Reconnect the pet window and try again.'),
    'presentation-rejected': t('新画面加载失败，保留原画面。', 'Could not load the new view. The previous view is still active.'),
    'unreachable': t('无法到达目标，角色留在当前位置。', 'The character could not reach that spot.'),
    'cancelled': t('操作已取消。', 'Cancelled.'),
  };
  return names[code] ?? code;
}

function windowAction(state: RuntimeState) {
  if (state.onDesktop) return { method: 'hideWindow', label: t('隐藏梦境', 'Hide Figure Scape') };
  if (state.inWindow) return { method: 'openWindow', label: t('显示梦境', 'Show Figure Scape') };
  if (state.window?.phase === 'running') return { method: null, label: t('正在连接…', 'Connecting…') };
  if (state.window?.phase === 'error' || state.window?.reason?.kind === 'exited') {
    return { method: 'recoverWindow', label: t('重试启动', 'Retry launch') };
  }
  if (state.window?.phase === 'missing') return { method: null, label: t('修复启动', 'Fix launch') };
  return { method: 'openWindow', label: t('启动梦境', 'Start Figure Scape') };
}

export function runtimeControls(ctx: PageContext, refresh: () => Promise<void>, notify: (message: string) => void) {
  const c = studioControls(ctx);

  const view = c.section(t('窗口', 'Window'));
  const status = c.status('studio-runtime-state');
  const tools = c.node('div', '', 'studio-inline');
  const windowFeedback = c.status();
  const detail = c.dialog(t('运行详情', 'Runtime details'), 'studio-runtime-dialog');
  const detailList = c.node('dl', '', 'studio-data');
  const detailFeedback = c.status();
  detail.body.append(detailList, detailFeedback);


  let current: RuntimeState | undefined;
  let onDetails: (() => void) | undefined;
  let openWallpaper: ((opener?: HTMLElement) => void) | undefined;
  let wallpaperSelected: (() => boolean) | undefined;
  let roomArtUrl = '';
  let pending = '';
  let waitingForVisibility: boolean | null = null;
  let visibilityTimer: number | undefined;
  let watchingLaunch = false;
  const win = c.doc.defaultView!;
  ctx.signal.addEventListener('abort', () => win.clearTimeout(visibilityTimer), { once: true });
  function openDetails() {
    renderDetails();
    if (detail.open()) onDetails?.();
  }
  const install = c.button(t('安装窗口运行时', 'Install window runtime'), () => void change('installElectron'));
  detail.body.append(install);

  function command(name: string, label: string, primary = false) {
    return c.button(label, () => void change(name), primary);
  }

  const launch = c.button(t('启动梦境', 'Start Figure Scape'), () => {
    if (!current) return;
    const action = windowAction(current);
    if (!action.method) { openDetails(); return; }
    void change(action.method, [], true);
  }, true);
  launch.classList.add('studio-runtime-launch');

  const close = command('closeWindow', t('关闭 Live2D', 'Close Live2D'));
  const pass = c.button(t('启用鼠标穿透', 'Enable click-through'), () => void change('setClickThrough', [!current?.clickThrough]));
  const recover = command('recoverWindow', t('重试启动', 'Retry launch'));
  const statusOf = (phase?: string) => phase === 'ready' ? t('已安装', 'Installed')
    : phase === 'working' ? t('正在安装', 'Installing') : phase === 'error' ? t('安装失败', 'Installation failed')
      : phase === 'missing' || phase === 'absent' ? t('尚未安装', 'Not installed') : phase ?? '—';
  const meter = c.node('progress');
  meter.setAttribute('aria-label', t('窗口运行时安装进度', 'Window runtime installation progress'));
  detail.body.append(meter);
  const scene = c.section(t('在小屋里移动', 'Move around the room'));
  const sceneButtons = c.node('div', '', 'studio-inline');
  const sceneStatus = c.status();
  const stop = c.button(t('停止移动', 'Stop moving'), () => void cancelScene());
  scene.append(sceneButtons, sceneStatus, stop);
  scene.hidden = true;
  let sceneState: Scene | undefined;
  let readingScene: Promise<void> | undefined;
  let sceneSending = false;
  let targetKey = '';
  let modeRequest: { id: string; mode: PresentationMode } | null = null;
  const presentation = c.section(t('选择场景', 'Choose a scene'));
  presentation.classList.add('studio-scene-selector');
  const cards = c.node('div', '', 'studio-mode-grid');
  const modeStatus = c.status();
  const sceneViewport = c.status();
  const retryMode = c.button(t('重试切换', 'Retry switch'), () => { if (lastMode) void chooseMode(lastMode); });
  let lastMode: PresentationMode | undefined;
  const cancelMode = c.button(t('取消切换', 'Cancel switch'), () => {
    if (!modeRequest) return;
    cancelMode.disabled = true;
    void c.call('operation.cancel', [modeRequest.id]).catch(error => {
      if (!ctx.signal.aborted) modeStatus.textContent = errorText(error);
    }).finally(() => { if (!ctx.signal.aborted) cancelMode.disabled = false; });
  });
  cancelMode.hidden = retryMode.hidden = true;
  const modeButtons = new Map(Object.entries(modes).map(([key, [title, hint]]) => {
    const mode = key as PresentationMode;
    const button = c.button('', () => void chooseMode(mode));
    button.className = 'studio-mode';
    button.dataset.mode = mode;
    const art = c.node('span', '', 'studio-mode-art');
    art.setAttribute('aria-hidden', 'true');
    const copy = c.node('span', '', 'studio-mode-copy');
    const chip = c.node('span', '', 'studio-mode-status');
    const name = c.node('span', '', 'studio-mode-name');
    name.append(c.node('strong', title), chip);
    copy.append(name, c.node('small', hint));
    button.append(art, copy);
    const tile = c.node('div', '', 'studio-scene-tile');
    const sizeFeedback = c.status();
    let frame = 0, proposed: number | null = null, inPreview = false;
    let pendingPreview: Promise<unknown> | undefined;
    function dispatchPreview() {
      frame = 0;
      if (pendingPreview || ctx.signal.aborted || current?.presentation?.applied !== mode || !current.onDesktop) return;
      const sent = proposed;
      inPreview = sent !== null;
      pendingPreview = c.call('presentation.previewScale', [mode, sent]).catch(() => {})
        .finally(() => {
          pendingPreview = undefined;
          if (proposed !== sent && !frame && !ctx.signal.aborted) frame = win.requestAnimationFrame(dispatchPreview);
        });
    }
    const size = createModelSizeControl({
      doc:c.doc, text:t, mode:() => mode, signal:ctx.signal,
      read:() => current?.presentationScales?.[mode] ?? 1,
      preview(_mode, value) {
        proposed = value;
        if (!frame && !pendingPreview && current?.presentation?.applied === mode && current.onDesktop) {
          frame = win.requestAnimationFrame(dispatchPreview);
        }
      },
      async save(_mode, value) {
        await pendingPreview;
        win.cancelAnimationFrame(frame);
        frame = 0;
        proposed = value;
        sizeFeedback.textContent = '';
        const result = await c.call<{scale:number}>('presentation.setScale', [mode, value]);
        if (current?.presentationScales) current.presentationScales[mode] = result.scale;
        await refresh();
      },
      report(message) { sizeFeedback.textContent = message; },
    });
    size.element.setAttribute('role','group');
    size.element.setAttribute('aria-label',title);
    ctx.signal.addEventListener('abort', () => {
      win.cancelAnimationFrame(frame);
      if (inPreview && current?.presentation?.applied === mode) c.keepalive('presentation.previewScale',[mode,null]);
    }, {once:true});
    tile.append(button, size.element, sizeFeedback);
    cards.append(tile);
    return [mode, { button, chip, size }] as const;
  }));
  const modeActions = c.node('div', '', 'studio-mode-feedback');
  modeActions.append(modeStatus, cancelMode, retryMode);
  presentation.append(cards, modeActions, sceneViewport);

  const browser = c.node('a', t('在浏览器中查看桌宠', 'View pet in browser'), 'studio-link');
  browser.target = '_blank';
  browser.rel = 'noopener noreferrer';
  browser.hidden = true;
  tools.append(close, pass, recover, browser);
  view.append(status, tools, windowFeedback);
  detail.body.prepend(view);

  function renderDetails() {
    if (!current) return;
    const rows = [
      [t('当前角色', 'Current character'), current.figureLabel ?? current.skin.figure ?? t('未选择模型', 'No model selected')],
      [t('窗口', 'Window'), windowLabel(current)],
      [t('模型首帧', 'Model first frame'), current.bodyReady ? t('已就绪', 'Ready') : t('未确认', 'Unconfirmed')],
      [t('窗口运行时', 'Window runtime'), statusOf(current.electron?.phase)],
      [t('鼠标穿透', 'Click-through'), current.clickThrough ? t('已启用', 'Enabled') : t('关闭', 'Off')],
    ];
    detailList.replaceChildren(...rows.map(([label, value]) => {
      const row = c.node('div', '', 'studio-fact');
      row.append(c.node('dt', label), c.node('dd', value));
      return row;
    }));
    install.hidden = !current.electron?.supported || current.electron.phase === 'ready';
    install.disabled = !!pending || current.electron?.phase === 'working';
    meter.hidden = pending !== 'installElectron' && current.electron?.phase !== 'working';
    const artifact = current.electron;
    if (artifact?.total) { meter.max = artifact.total; meter.value = artifact.done; } else meter.removeAttribute('value');
    detailFeedback.textContent = artifact?.detail ?? current.windowHint ?? '';
  }

  function render(next: RuntimeState) {
    current = next;
    browser.hidden = !next.url;
    if (next.url) browser.href = next.url;
    if (next.url) {
      const url = new URL('/web/vendor/feiyu-house/interior.png', next.url).href;
      if (url !== roomArtUrl && (presentation.isConnected || next.presentation?.desired === 'room')) {
        roomArtUrl = url;
        const artwork = c.node('img');
        artwork.src = url;
        void artwork.decode().then(() => {
          if (ctx.signal.aborted || roomArtUrl !== url) return;
          const image = 'url("' + url + '")';
          cards.style.setProperty('--room-art', image);
          cards.dataset.roomArt = 'ready';
        }).catch(() => {});
      }
    }
    status.textContent = next.previousModelUnavailable
      ? t('上次的模型来源已不可用，请从工作台重新导入。', 'The previous model source is unavailable. Reimport it from the workbench.')
      : !next.skin.figure ? t('请先从工作台导入并选择 Live2D 模型。', 'Import and select a Live2D model in the workbench first.')
      : windowLabel(next) + ' · ' + (next.bodyReady ? t('首帧已就绪', 'First frame ready') : t('身体未就绪', 'Body not ready'));
    const locked = !!pending;
    if (waitingForVisibility !== null && (!next.inWindow || next.onDesktop === waitingForVisibility)) clearVisibilityRequest();
    if (watchingLaunch && next.window?.phase !== 'running' && next.windowHint) reportLaunchProblem(next.windowHint);
    if (next.inWindow) watchingLaunch = false;
    const action = windowAction(next);
    const visibilityBusy = waitingForVisibility !== null;
    const label = visibilityBusy
      ? waitingForVisibility ? t('正在显示…', 'Showing…') : t('正在隐藏…', 'Hiding…')
      : pending === 'openWindow' || pending === 'recoverWindow' ? t('正在启动…', 'Starting…') : action.label;
    if (launch.textContent !== label) launch.textContent = label;
    const noModel = !next.inWindow && !next.skin.figure;
    launch.disabled = locked || visibilityBusy || noModel;
    launch.title = noModel ? t('请先导入并选择模型', 'Import and select a model first') : '';
    if (action.method) launch.removeAttribute('aria-haspopup');
    else launch.setAttribute('aria-haspopup', 'dialog');
    close.disabled = locked || (!next.inWindow && next.window?.phase !== 'running');
    pass.disabled = locked || !next.inWindow;
    pass.textContent = next.clickThrough ? t('关闭鼠标穿透', 'Disable click-through') : t('启用鼠标穿透', 'Enable click-through');
    pass.setAttribute('aria-pressed', String(next.clickThrough === true));
    recover.hidden = !next.windowHint && (next.inWindow || next.window?.phase !== 'running');
    recover.disabled = locked;
    if (next.windowHint && !pending) windowFeedback.textContent ||= next.windowHint;
    const selectedMode = next.presentation?.desired ?? 'desktop';
    const dimensions = next.presentation?.details?.rect;
    const width = dimensions?.w ?? dimensions?.width, height = dimensions?.h ?? dimensions?.height;
    const wallpaper = next.presentation?.details?.wallpaper;
    const wallpaperLabel = wallpaper?.paused ? t('已暂停','Paused') : ({
      'fallback-video':t('备用视频','Fallback video'), 'fallback-image':t('备用封面','Fallback image'),
      'live':t('实时壁纸','Live wallpaper'), failed:t('壁纸已失效，请重新选择。','Wallpaper unavailable. Choose another background.'),
    } as Record<string,string>)[wallpaper?.kind ?? ''];
    sceneViewport.textContent = next.presentation?.applied === 'wallpaper' ? [wallpaper?.title, wallpaperLabel].filter(Boolean).join(' · ')
      : next.presentation?.applied === 'phone'
      ? t('9:16 · 点击或左右摇晃角色', '9:16 · Tap or shake the character') + (width && height ? ' · ' + Math.round(width) + ' × ' + Math.round(height) : '')
      : next.presentation?.applied === 'desktop' ? t('桌面活动范围随当前显示器的工作区变化。','The activity area follows the current display work area.') : '';
    for (const [mode, { button, chip, size }] of modeButtons) {
      size.sync();
      button.disabled = locked || !!modeRequest || !!next.presentation?.operation || !!next.framework.model?.busy
        || next.presentation?.available?.includes(mode) === false;
      button.setAttribute('aria-pressed', String(selectedMode === mode));
      chip.textContent = modeRequest?.mode === mode || next.presentation?.operation?.mode === mode
        ? t('正在准备', 'Preparing')
        : next.presentation?.applied === mode && next.onDesktop ? t('使用中', 'In use')
          : selectedMode === mode ? t('已选定', 'Selected') : '';
    }
    if (!modeRequest) {
      modeStatus.textContent = next.presentation?.error ? reason(next.presentation.error)
        : !next.onDesktop ? t('显示窗口后应用所选呈现。', 'The selected view applies when the window opens.') : '';
    }
    cancelMode.hidden = !modeRequest || next.presentation?.operation?.phase === 'committing';
    scene.hidden = next.presentation?.applied !== 'room' || !next.onDesktop;
    if (!scene.hidden && scene.isConnected) void readScene();
    if (detail.element.open) renderDetails();
  }

  function clearVisibilityRequest() {
    waitingForVisibility = null;
    win.clearTimeout(visibilityTimer);
  }

  function reportLaunchProblem(message: string) {
    watchingLaunch = false;
    if (!detail.element.open) notify(message + ' ' + t('点击右上角版本号查看运行详情。', 'Click the version in the upper right for runtime details.'));
  }

  async function change(method: string, args: unknown[] = [], fromHeader = false) {
    if (pending || !current) return;
    pending = method;
    render(current);
    const requestedVisibility = fromHeader && current.inWindow;
    windowFeedback.textContent = t('正在处理…', 'Working…');
    if (method === 'installElectron') detailFeedback.textContent = t('正在准备运行时…', 'Preparing runtime…');
    try {
      const next = await c.call<RuntimeState>('runtime.' + method, args);
      if (ctx.signal.aborted) return;
      if (requestedVisibility && next.inWindow) {
        const visible = method !== 'hideWindow';
        if (next.onDesktop !== visible) {
          waitingForVisibility = visible;
          visibilityTimer = win.setTimeout(() => {
            clearVisibilityRequest();
            if (!current || ctx.signal.aborted) return;
            render(current);
            notify(t('窗口尚未确认状态，请稍后重试。', 'The window did not confirm its state. Try again.'));
          }, 5000);
        }
      } else if (fromHeader) {
        watchingLaunch = !next.inWindow && next.window?.phase === 'running';
        if (!watchingLaunch && !next.inWindow) {
          reportLaunchProblem(next.windowHint ?? t('窗口未启动。', 'The window did not start.'));
        }
      }
      if (next.skin && next.framework) render(next);
      const feedback = method === 'setClickThrough'
        ? next.clickThrough ? t('穿透已开启，可在这里恢复鼠标交互。', 'Click-through is on. Restore mouse input here.')
          : t('已恢复鼠标交互。', 'Mouse input restored.')
        : next.windowHint ?? '';
      windowFeedback.textContent = detailFeedback.textContent = feedback;
    } catch (error) {
      if (!ctx.signal.aborted) {
        windowFeedback.textContent = detailFeedback.textContent = errorText(error);
        if (fromHeader) reportLaunchProblem(errorText(error));
      }
    } finally {
      pending = '';
      if (current && !ctx.signal.aborted) { render(current); await refresh(); }
    }
  }

  async function chooseMode(mode: PresentationMode) {
    if (!current || modeRequest || pending) return;
    if (mode === 'wallpaper' && (!wallpaperSelected?.() || mode === current.presentation?.desired && !current.presentation?.error)) {
      openWallpaper?.(modeButtons.get(mode)?.button);
      return;
    }
    if (mode === current.presentation?.desired && !current.presentation?.error && retryMode.hidden) return;
    lastMode = mode;
    const id = c.doc.defaultView!.crypto.randomUUID();
    modeRequest = { id, mode };
    retryMode.hidden = true;
    render(current);
    modeStatus.textContent = t('正在准备画面，等待窗口确认…', 'Preparing the view and waiting for the window…');
    let failure = '';
    try {
      const result = await c.call<{ phase: string; applied: boolean; error?: string }>('presentation.select', [mode, id]);
      if (result.phase === 'failed') failure = reason(result.error ?? 'presentation-rejected');
      if (result.phase === 'cancelled') failure = reason('cancelled');
      retryMode.hidden = result.phase !== 'failed';
    } catch (error) {
      failure = errorText(error);
      retryMode.hidden = false;
    } finally {
      modeRequest = null;
      if (!ctx.signal.aborted) {
        await refresh();
        if (failure) modeStatus.textContent = failure;
      }
    }
  }

  function renderScene(next: Scene) {
    sceneState = next;
    const items = (next.scene?.targets ?? []).filter(id => id in targets);
    const key = items.join(',');
    if (key !== targetKey) {
      targetKey = key;
      sceneButtons.replaceChildren(...items.map(id => c.button(targets[id], () => void goTo(id))));
    }
    for (const item of sceneButtons.querySelectorAll('button')) item.disabled = !next.available || sceneSending;
    stop.disabled = !next.active || sceneSending;
    const recent = next.recent;
    sceneStatus.textContent = next.active ? t('正在移动…', 'Moving…')
      : recent?.status === 'completed' ? t('已到达。', 'Arrived.')
        : recent?.reason ? reason(recent.reason) : '';
  }

  function readScene() {
    readingScene ??= c.call<Scene>('scene.state').then(next => {
      if (!ctx.signal.aborted && next?.mode === 'room' && !scene.hidden) renderScene(next);
    }).catch(error => { if (!ctx.signal.aborted) sceneStatus.textContent = errorText(error); })
      .finally(() => { readingScene = undefined; });
    return readingScene;
  }

  async function goTo(id: string) {
    if (!sceneState?.available || sceneSending) return;
    sceneSending = true;
    renderScene(sceneState);
    try {
      await c.call(id === 'chair' || id === 'sofa' || id === 'bed' ? 'scene.interact' : 'scene.move', [id]);
      await readScene();
    } catch (error) { if (!ctx.signal.aborted) sceneStatus.textContent = errorText(error); }
    finally { sceneSending = false; if (sceneState && !ctx.signal.aborted) for (const item of sceneButtons.querySelectorAll('button')) item.disabled = !sceneState.available; }
  }

  async function cancelScene() {
    if (!sceneState?.active) return;
    try { await c.call('scene.cancel', [sceneState.active.id]); await readScene(); }
    catch (error) { if (!ctx.signal.aborted) sceneStatus.textContent = errorText(error); }
  }

  for (const control of [launch, close, pass, recover, ...Array.from(modeButtons.values(), v => v.button)]) control.disabled = true;
  return { launch, openDetails, detail, presentation, scene, render, detailBody: detail.body, onDetails(fn: () => void) { onDetails = fn; }, onWallpaper(open: (opener?: HTMLElement) => void, selected: () => boolean) { openWallpaper = open; wallpaperSelected = selected; }, refreshScene: () => { if (!scene.hidden) void readScene(); } };
}
