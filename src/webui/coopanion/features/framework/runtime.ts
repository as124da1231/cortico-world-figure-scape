import { createModelSizeControl } from '../../../../../web/framework/model-size.js';
import type { PetSkin } from '../../../../config.ts';
import type { PageContext } from '../../base/page.ts';
import type { PresentationMode } from '../../../../framework/presentation-service.ts';
import type { HostState } from '../../../../window-host.ts';
import type { WindowCompatibility } from '../../../../framework/window-compatibility.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';
import type { SettingsState, SpeechState } from './settings-panels.ts';
import { sceneTile } from './scene-workspace.ts';

type Presentation = {
  desired: PresentationMode;
  applied: PresentationMode | null;
  available?: PresentationMode[];
  visible?: boolean;
  operation?: { operationId: string; phase: string; mode: PresentationMode } | null;
  error: string | null;
  details?: { rect?: { width?: number; height?: number; w?:number; h?:number }; view?: {width?:number;height?:number}; stage?: {width?:number;height?:number}; wallpaper?: {id?:string;title?:string;kind?:string;paused?:boolean} } | null;
};
export type RuntimeState = {
  inWindow: boolean;
  theme?: string;
  sound?: boolean;
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
  activeScene?: PresentationMode | 'cabin-world' | null;
  presentation?: Presentation;
  cabinWorld?: { phase: string; presented?: boolean };
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
export function visibleScene(state: RuntimeState) {
  if (state.activeScene !== undefined) return state.activeScene;
  if (state.cabinWorld?.phase === 'active' && state.cabinWorld.presented !== false) return 'cabin-world';
  return state.onDesktop && state.bodyReady !== false ? state.presentation?.applied ?? null : null;
}
export const windowLabel = (state: RuntimeState) => visibleScene(state) === 'cabin-world' ? t('小屋世界运行中', 'Cabin World is running')
  : state.onDesktop ? t('显示中', 'Visible')
  : state.inWindow ? t('已隐藏', 'Hidden')
    : state.window?.phase === 'running' ? t('正在连接', 'Connecting')
      : state.window?.phase === 'missing' ? t('缺少窗口运行时', 'Window runtime required')
        : state.window?.phase === 'error' || state.window?.reason?.kind === 'exited' ? t('窗口启动失败', 'Window failed')
          : t('未启动', 'Closed');

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

function windowAction(state: RuntimeState, timedOut: boolean) {
  if (visibleScene(state) === 'cabin-world') return { method: 'openWindow', label: t('返回梦境窗口', 'Return to Figure Scape window') };
  if (state.onDesktop) return { method: 'hideWindow', label: t('隐藏梦境', 'Hide Figure Scape') };
  if (state.inWindow) return { method: 'openWindow', label: t('显示梦境', 'Show Figure Scape') };
  if (timedOut || state.window?.phase === 'error' || state.window?.reason?.kind === 'exited') {
    return { method: 'recoverWindow', label: t('重试启动', 'Retry launch') };
  }
  if (state.window?.phase === 'running') return { method: null, label: t('正在连接…', 'Connecting…') };
  if (state.window?.phase === 'missing') return { method: null, label: t('修复启动', 'Fix launch') };
  return { method: 'openWindow', label: t('启动梦境', 'Start Figure Scape') };
}

export function runtimeControls(ctx: PageContext, refresh: () => Promise<void>, notify: (message: string) => void) {
  const c = studioControls(ctx);

  const view = c.node('section', '', 'studio-runtime-overview');
  const overview = c.node('div', '', 'studio-runtime-overview-line');
  const status = c.status('studio-runtime-state');
  status.textContent = t('正在读取运行状态…', 'Reading runtime status…');
  const lamp = c.node('span', '', 'studio-runtime-indicator');
  lamp.setAttribute('aria-hidden', 'true');
  const tools = c.node('div', '', 'studio-runtime-actions');
  const feedback = c.status('studio-runtime-feedback');
  const artifactFeedback = c.status('studio-runtime-feedback');
  const detail = c.dialog(t('运行详情', 'Runtime details'), 'studio-runtime-dialog');
  const detailList = c.node('dl', '', 'studio-runtime-facts');
  const facts = Array.from({length:3}, () => {
    const row = c.node('div'), key = c.node('dt'), value = c.node('dd');
    row.hidden = true;
    row.append(key,value);
    detailList.append(row);
    return {row,key,value};
  });
  function writeText(element: HTMLElement, message: string) {
    if (element.textContent !== message) element.textContent = message;
  }


  let current: RuntimeState | undefined;
  let openWallpaper: ((opener?: HTMLElement) => void) | undefined;
  let wallpaperSelected: (() => boolean) | undefined;
  let pending = '';
  let waitingForVisibility: boolean | null = null;
  let visibilityTimer: number | undefined;
  let connectionTimer: number | undefined;
  let launchWait = false, timedOut = false, commandFeedback = '';
  const win = c.doc.defaultView!;
  ctx.signal.addEventListener('abort', () => {
    win.clearTimeout(visibilityTimer);
    win.clearTimeout(connectionTimer);
  }, { once: true });
  function openDetails(opener?: HTMLElement) {
    renderDetails();
    detail.open(opener);
  }
  function command(name: string, label: string, primary = false) {
    return c.button(label, () => void change(name), primary);
  }

  const launch = c.button(t('启动梦境', 'Start Figure Scape'), () => {
    if (!current) return;
    const action = windowAction(current, timedOut);
    if (!action.method) { openDetails(); return; }
    void change(action.method, [], true);
  }, true);
  launch.classList.add('studio-runtime-launch');
  const primary = c.button(t('启动梦境', 'Start Figure Scape'), () => {
    const method = current && windowAction(current, timedOut).method;
    if (method) void change(method);
  }, true);
  const close = command('closeWindow', t('关闭窗口', 'Close window'));
  const pass = c.button(t('启用鼠标穿透', 'Enable click-through'), () => void change('setClickThrough', [!current?.clickThrough]));
  const install = command('installElectron', t('安装窗口运行时', 'Install window runtime'), true);
  const statusOf = (phase?: string) => phase === 'ready' ? t('已安装', 'Installed')
    : phase === 'working' ? t('正在安装', 'Installing') : phase === 'error' ? t('安装失败', 'Installation failed')
      : phase === 'missing' || phase === 'absent' ? t('尚未安装', 'Not installed') : phase ?? '—';
  const meter = c.node('progress');
  meter.setAttribute('aria-label', t('窗口运行时安装进度', 'Window runtime installation progress'));
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
  let openedMode: PresentationMode | undefined;
  let openScene: (mode: PresentationMode) => void = () => {};
  const modeStatus = c.status();
  const sceneViewport = c.status();
  const failures = new Map<PresentationMode, string>();
  const cancelMode = c.button(t('取消切换', 'Cancel switch'), () => {
    if (!modeRequest) return;
    const {id, mode} = modeRequest;
    cancelMode.disabled = true;
    void c.call('operation.cancel', [id]).catch(error => {
      if (!ctx.signal.aborted) {
        failures.set(mode, errorText(error));
        if (current) render(current);
      }
    }).finally(() => { if (!ctx.signal.aborted) cancelMode.disabled = false; });
  });
  cancelMode.hidden = true;
  const modeButtons = new Map(Object.entries(modes).map(([key, [title, hint]]) => {
    const mode = key as PresentationMode;
    const {button, chip} = sceneTile(ctx, mode, title, hint, () => openScene(mode));
    const enter = c.button(t('进入场景', 'Enter scene'), () => void chooseMode(mode), true);
    enter.disabled = true;
    const settings = c.node('section', '', 'studio-scene-settings');
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
    settings.append(size.element, sizeFeedback);
    return [mode, { button, chip, size, enter, settings, hint }] as const;
  }));
  const modeActions = c.node('div', '', 'studio-mode-feedback');
  modeActions.append(modeStatus, cancelMode);
  const sceneFeedback = c.node('div', '', 'studio-scene-feedback');
  sceneFeedback.append(modeActions, sceneViewport);

  const browser = c.node('a', t('浏览器预览 ↗', 'Browser preview ↗'), 'studio-runtime-link');
  browser.setAttribute('aria-label', t('在新标签页预览桌宠', 'Preview the pet in a new tab'));
  browser.target = '_blank';
  browser.rel = 'noopener noreferrer';
  browser.hidden = true;
  tools.append(primary, install, pass, close);
  overview.append(lamp, status, tools);
  view.append(overview, feedback, meter, artifactFeedback);
  detail.body.append(view, detailList);
  const links = c.node('div', '', 'studio-runtime-links');
  links.append(browser);

  function renderDetails() {
    if (!current) return;
    const scene = visibleScene(current);
    const action = windowAction(current, timedOut);
    const detached = current.window?.phase === 'missing' || current.window?.phase === 'error' || !!timedOut
      || current.window?.reason?.kind === 'exited';
    const changing = waitingForVisibility !== null || !!pending;
    const bodyLabel = current.onDesktop
      ? current.bodyReady ? t('首帧已就绪', 'First frame ready') : t('等待角色画面', 'Waiting for the character')
      : '';
    lamp.dataset.state = detached ? 'error' : scene ? 'ready' : changing || current.window?.phase === 'running' && !current.inWindow ? 'busy' : 'idle';
    const changingWindow = waitingForVisibility !== null || ['openWindow','hideWindow','closeWindow','recoverWindow'].includes(pending);
    writeText(status, changingWindow ? launch.textContent || windowLabel(current)
      : timedOut ? t('窗口连接超时', 'Window connection timed out')
        : [windowLabel(current),bodyLabel].filter(Boolean).join(' · '));
    primary.hidden = !action.method;
    primary.disabled = changing || !current.skin.figure && !current.inWindow;
    writeText(primary, launch.textContent || action.label);
    pass.hidden = !current.onDesktop || !current.inWindow || scene === 'cabin-world';
    pass.disabled = changing;
    writeText(pass, current.clickThrough ? t('关闭鼠标穿透', 'Disable click-through') : t('启用鼠标穿透', 'Enable click-through'));
    pass.setAttribute('aria-pressed', String(current.clickThrough === true));
    close.hidden = scene === 'cabin-world' || !current.inWindow && current.window?.phase !== 'running';
    close.disabled = changing;
    const artifact = current.electron;
    install.hidden = !artifact?.supported || artifact.phase === 'ready' || current.inWindow;
    install.disabled = changing || artifact?.phase === 'working';
    writeText(install, artifact?.phase === 'error' ? t('重试安装窗口运行时', 'Retry window runtime installation') : t('安装窗口运行时', 'Install window runtime'));
    meter.hidden = pending !== 'installElectron' && artifact?.phase !== 'working';
    if (artifact?.total) { meter.max = artifact.total; meter.value = artifact.done; } else meter.removeAttribute('value');
    writeText(artifactFeedback, artifact?.phase === 'error' || artifact?.phase === 'working' ? artifact.detail ?? '' : '');
    const modelHint = current.previousModelUnavailable
      ? t('上次选中的模型已不可用，请在工作台重新导入。', 'The selected model is unavailable. Reimport it from the workbench.')
      : !current.skin.figure && !current.inWindow
        ? t('请先在工作台导入并选择角色。', 'Import and select a character in the workbench first.') : '';
    writeText(feedback, commandFeedback || modelHint || (current.window?.reason?.kind === 'closed' ? '' : current.windowHint) || '');
    const rows = [
      [current.bodyReady ? t('当前角色', 'Current character') : t('所选角色', 'Selected character'),
        current.figureLabel ?? current.skin.figure ?? t('未选择', 'None selected')],
      [t('当前场景', 'Current scene'), scene === 'cabin-world' ? t('小屋世界', 'Cabin World') : scene ? modeLabel(scene) : ''],
      [t('窗口运行时', 'Window runtime'), statusOf(artifact?.phase)],
    ];
    for (const [i,{row,key,value}] of facts.entries()) {
      writeText(key, rows[i][0]);
      writeText(value, rows[i][1]);
      row.hidden = !rows[i][1];
    }
    browser.hidden = !current.url || !current.skin.figure;
    if (current.url) browser.href = current.url;
  }

  function render(next: RuntimeState) {
    if (!current?.inWindow && next.inWindow && !pending) commandFeedback = '';
    current = next;
    const locked = !!pending;
    if (waitingForVisibility !== null && (!next.inWindow || next.onDesktop === waitingForVisibility)) clearVisibilityRequest();
    if (!next.inWindow && next.window?.phase === 'running' && visibleScene(next) !== 'cabin-world') {
      if (!timedOut && connectionTimer === undefined) connectionTimer = win.setTimeout(() => {
        connectionTimer = undefined;
        if (!current || ctx.signal.aborted || current.inWindow || current.window?.phase !== 'running') return;
        timedOut = true;
        render(current);
      }, 12_000);
    } else {
      clearConnectionTimer();
      timedOut = false;
      if (launchWait && !next.inWindow && next.windowHint) reportLaunchProblem(next.windowHint);
      launchWait = false;
    }
    const action = windowAction(next, timedOut);
    const visibilityBusy = waitingForVisibility !== null;
    const label = waitingForVisibility === false || pending === 'hideWindow' ? t('正在隐藏…', 'Hiding…')
      : waitingForVisibility === true || pending === 'openWindow' && next.inWindow ? t('正在显示…', 'Showing…')
        : pending === 'closeWindow' ? t('正在关闭…', 'Closing…')
          : pending === 'openWindow' || pending === 'recoverWindow' ? t('正在启动…', 'Starting…') : action.label;
    writeText(launch, label);
    const noModel = !next.inWindow && !next.skin.figure;
    launch.disabled = locked || visibilityBusy || noModel && action.method !== null;
    launch.title = noModel ? t('请先导入并选择模型', 'Import and select a model first') : '';
    if (action.method) launch.removeAttribute('aria-haspopup');
    else launch.setAttribute('aria-haspopup', 'dialog');
    const selectedMode = next.presentation?.desired ?? 'desktop';
    const cabinSwitching = next.cabinWorld?.phase === 'active' && next.cabinWorld.presented === false;
    const activeMode = visibleScene(next);
    const cabinActive = activeMode === 'cabin-world';
    const dimensions = next.presentation?.details?.rect;
    const width = dimensions?.w ?? dimensions?.width, height = dimensions?.h ?? dimensions?.height;
    const wallpaper = next.presentation?.details?.wallpaper;
    const wallpaperLabel = wallpaper?.paused ? t('已暂停','Paused') : ({
      'fallback-video':t('备用视频','Fallback video'), 'fallback-image':t('备用封面','Fallback image'),
      'live':t('实时壁纸','Live wallpaper'), failed:t('壁纸已失效，请重新选择。','Wallpaper unavailable. Choose another background.'),
    } as Record<string,string>)[wallpaper?.kind ?? ''];
    sceneViewport.textContent = activeMode === openedMode && openedMode === 'wallpaper' ? [wallpaper?.title, wallpaperLabel].filter(Boolean).join(' · ')
      : activeMode === openedMode && openedMode === 'phone'
      ? t('9:16 · 点击或左右摇晃角色', '9:16 · Tap or shake the character') + (width && height ? ' · ' + Math.round(width) + ' × ' + Math.round(height) : '')
      : openedMode === 'desktop' ? t('桌面活动范围随当前显示器的工作区变化。','The activity area follows the current display work area.') : '';
    for (const [mode, { button, chip, size, enter }] of modeButtons) {
      size.sync();
      const inUse = activeMode === mode;
      const loading = modeRequest?.mode === mode || next.presentation?.operation?.mode === mode;
      const selected = !cabinActive && selectedMode === mode;
      const retry = failures.has(mode) || selected && !!next.presentation?.error;
      const needsWallpaper = mode === 'wallpaper' && !wallpaperSelected?.();
      enter.disabled = locked || !!modeRequest || !!next.presentation?.operation || !!next.framework.model?.busy
        || cabinSwitching || ['connecting','leaving'].includes(next.cabinWorld?.phase ?? '') || next.presentation?.available?.includes(mode) === false
        || !retry && (inUse || selected && !next.onDesktop && !needsWallpaper);
      button.dataset.current = String(inUse);
      chip.textContent = loading
        ? t('正在准备', 'Preparing')
        : inUse ? t('使用中', 'In use')
          : retry ? t('待重试', 'Retry available') : selected ? t('已选定', 'Selected') : '';
      enter.textContent = loading ? t('正在进入…', 'Entering…')
        : retry ? t('重试进入', 'Retry entry')
          : inUse ? t('使用中', 'In use')
            : needsWallpaper ? t('选择背景', 'Choose background')
              : next.onDesktop || cabinActive ? t('进入场景', 'Enter scene')
                : selected ? t('启动后进入', 'On startup') : t('设为启动场景', 'Set as startup scene');
    }
    modeStatus.textContent = !openedMode ? ''
      : modeRequest?.mode === openedMode ? t('正在准备画面，等待窗口确认…', 'Preparing the view and waiting for the window…')
        : failures.get(openedMode) ?? (selectedMode === openedMode && next.presentation?.error ? reason(next.presentation.error) : '');
    cancelMode.hidden = !modeRequest || modeRequest.mode !== openedMode || next.presentation?.operation?.phase === 'committing';
    scene.hidden = openedMode !== 'room' || activeMode !== 'room';
    if (!scene.hidden && scene.isConnected) void readScene();
    if (detail.element.open) renderDetails();
  }

  function clearVisibilityRequest() {
    waitingForVisibility = null;
    win.clearTimeout(visibilityTimer);
  }
  function clearConnectionTimer() {
    win.clearTimeout(connectionTimer);
    connectionTimer = undefined;
  }
  function reportLaunchProblem(message: string) {
    commandFeedback = message;
    if (detail.element.open) writeText(feedback, message);
    else notify(message + ' ' + t('点击版本号查看运行详情。', 'Click the version to see runtime details.'));
  }

  async function change(method: string, args: unknown[] = [], fromHeader = false) {
    if (pending || !current) return;
    commandFeedback = '';
    const visibility = method === 'hideWindow' ? false : method === 'openWindow' && current.inWindow ? true : null;
    const startsWindow = visibility === null && (method === 'openWindow' || method === 'recoverWindow');
    if (startsWindow) { clearConnectionTimer(); timedOut = false; }
    pending = method;
    render(current);
    try {
      const next = await c.call<RuntimeState>('runtime.' + method, args);
      if (ctx.signal.aborted) return;
      if (visibility !== null && next.inWindow) {
        if (next.onDesktop !== visibility) {
          waitingForVisibility = visibility;
          visibilityTimer = win.setTimeout(() => {
            clearVisibilityRequest();
            if (!current || ctx.signal.aborted) return;
            reportLaunchProblem(t('窗口尚未确认显示状态，可以重试。', 'The window did not confirm visibility. Try again.'));
            render(current);
          }, 5000);
        }
      } else if (startsWindow) {
        launchWait = !next.inWindow && next.window?.phase === 'running';
        if (!launchWait && !next.inWindow) {
          reportLaunchProblem(next.windowHint ?? t('窗口未启动。', 'The window did not start.'));
        }
      }
      if (next.skin && next.framework) render(next);
      if (method === 'setClickThrough') commandFeedback = next.clickThrough
        ? t('鼠标穿透已开启。', 'Click-through enabled.') : t('已恢复鼠标交互。', 'Mouse input restored.');
    } catch (error) {
      if (!ctx.signal.aborted) {
        if (fromHeader) reportLaunchProblem(errorText(error));
        else commandFeedback = errorText(error);
      }
    } finally {
      pending = '';
      if (current && !ctx.signal.aborted) { render(current); await refresh(); }
    }
  }

  async function chooseMode(mode: PresentationMode) {
    if (!current || modeRequest || pending) return;
    if (mode === 'wallpaper' && !wallpaperSelected?.()) {
      openWallpaper?.(modeButtons.get(mode)?.enter);
      return;
    }
    failures.delete(mode);
    const id = c.doc.defaultView!.crypto.randomUUID();
    modeRequest = { id, mode };
    render(current);
    try {
      const result = await c.call<{ phase: string; applied: boolean; error?: string }>('presentation.select', [mode, id]);
      if (result.phase === 'failed') failures.set(mode, reason(result.error ?? 'presentation-rejected'));
      if (result.phase === 'cancelled') failures.set(mode, reason('cancelled'));
    } catch (error) {
      failures.set(mode, errorText(error));
    } finally {
      modeRequest = null;
      if (!ctx.signal.aborted) {
        await refresh();
        if (current) render(current);
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

  for (const control of [launch, primary, close, pass, install]) control.disabled = true;
  for (const control of [primary, close, pass, install, meter]) control.hidden = true;
  return {
    launch, openDetails, detail, scene, sceneApps: modeButtons, render, detailBody: detail.body, detailLinks: links,
    onSceneOpen(fn: (mode: PresentationMode) => void) { openScene = fn; },
    showScene(mode: PresentationMode, page: HTMLElement) {
      openedMode = mode;
      page.prepend(sceneFeedback);
      if (current) render(current);
    },
    closeScene(mode: PresentationMode) {
      modeButtons.get(mode)?.size.stopPreview();
      openedMode = undefined;
      scene.hidden = true;
    },
    onWallpaper(open: (opener?: HTMLElement) => void, selected: () => boolean) {
      openWallpaper = open; wallpaperSelected = selected;
    },
    refreshScene: () => { if (!scene.hidden) void readScene(); },
  };
}
