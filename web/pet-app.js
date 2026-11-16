/**
 * The pet page. Connects to the World over `/socket?role=pet`, runs the body of the figure pack the
 * skin names in a sandboxed frame, and turns World orders (say,
 * ask, walk, act, listen, and the steps of an app's conversation) into bubbles and motion. It
 * reports back only what happened on screen: arrivals, answers, touches, typed text, and 16 kHz
 * microphone audio while voice input is on.
 *
 * In the pet window (`window.petHost` from the preload) the page is transparent and the
 * window ignores the mouse except over the figure, a bubble, the menu or the hover buttons.
 * Colors follow the World's `theme` through `data-theme` on the root element, and text the app
 * language (i18n.js): the one stamped on the page, then the one the World's prefs carry.
 */
import { applyTheme, clamp, f, ICONS, linked } from './ui.js';
import { language, t, useLanguage } from './i18n.js';
import { createSfx } from './sound.js';

import { createDisplayDrag } from './framework/display-drag.js';
import { createBubbleHover } from './framework/bubble-hover.js';
import { nextToBody, inApproach } from './framework/desktop-controls.js';
import { createDesktopSystem } from './desktop-system.js';
import { fetchLooks, lookAvailable, lookPicture, sameLook, normalizeSkin } from './looks.js';
import { accentColors, announcePainted, bubbleCss, dressFloor, glowColor, lightWall, modeButton, setGlow } from './stage.js';
import { bindAppearance } from './appearance.js';
import { createMic } from './mic.js';
import { runFrames } from './frame-loop.js';
import { createLandscapeChat } from './framework/landscape-chat.js';
import { createPhoneChat } from './framework/phone-chat.js';
import { createPhoneGesture } from './framework/phone-gesture.js';
import { createTouchOverlay } from './framework/touch-overlay.js';
import { createControlPhone, DEFAULT_CONTROL_PAGE } from './framework/phone-controls.js';
import { CONTROL_COMPONENTS } from './framework/control-layout.js';

const $ = (s) => document.querySelector(s);
const host = window.petHost || null;
const windowKey = host ? new URLSearchParams(location.hash.slice(1)).get('key') : null;
document.body.classList.add(host ? 'desk' : 'tab');

// Runtime is assembled below, after the existing surface and audio ports are available.

const stage = $('#stage');
const touchOverlay = createTouchOverlay($('#figureLayer'));
const bubble = $('#bubble'), menu = $('#menu');
const tools = $('#tools'), toolNote = $('#toolNote'), wheel = $('#wheel');
const toolNoteName = toolNote.querySelector('.tool-note-name'), toolNoteHint = toolNote.querySelector('.tool-note-hint');
const accentStyle = document.createElement('style');
// the bubbles' colours of a pack that names its own (bubbleCss)
const bubbleStyle = document.createElement('style');
document.head.append(accentStyle, bubbleStyle);

const prefs = {
  roam: 'calm', sound: true, theme: document.documentElement.dataset.theme, scale: 1, bubbleSize: 1, fontSize: 1, bubbleSpeed: 1, glow: 7, user: '', mic: false, micDevice: '', bot: null,
  /** Voice input: switched on, recognizer ready, why not, how to talk, and the mode in force. */
  voice: { enabled: false, ready: false, detail: null, hint: '', mode: 'hold' },
  /** The actions shown as buttons beside the pet on hover. */
  hoverButtons: ['chat', 'voice', 'menu'], hoverButtonsVisible: true,
  touchRegionsVisible: false,
  rememberPosition: false,
  /** Double-clicking the pet opens the typing box. */
  doubleClickChat: false,
  statusBubble: true,
  /** What the person typed, said or sent from the chat page stays above Coo (see lines); off, speech shows only while it is heard. */
  saidBubbles: true,
  /** Draw at the moving frame rate while the body rests too. */
  /** Frames a second while the body moves; 0 follows the display. */
  frameRate: 60,
  lockFrameRate: false,
  /** Every click passes through the pet (the tray's "click through"): no hover buttons, and a bubble under the cursor does not wait. */
  clickThrough: false,
};
// in a tab (the settings window's preview) the page is its own stage: a wall that answers the pointer, a floor with icons, a night/day button
const modeBtn = host ? null : modeButton(document.body, () => prefs.theme, (theme) => applyPrefs({ theme }));
if (!host) {
  lightWall(document.body, document.documentElement);
  dressFloor($('.floor'));
  // the settings window lends its theme color (--host-accent): the light's color when the body's pack names none
  bindAppearance(document, window);
}
/** The body on screen: its colors light the wall in a tab. */
let shownPack = null;
const lightFor = (s) => {
  if (!host) setGlow(document.body, glowColor(shownPack, s));
  const a = accentColors(shownPack, s);
  accentStyle.textContent = a ? `html:root{--skin-eye:${a.light}}@media (prefers-color-scheme: dark){html:root:not([data-theme="light"]){--skin-eye:${a.dark}}}html:root[data-theme="dark"]{--skin-eye:${a.dark}}` : '';
  bubbleStyle.textContent = bubbleCss(shownPack, s);
};

const sfx = createSfx();
const system = createDesktopSystem({
  audio: sfx,
  input: { document, window },
  scene: { viewport: () => ({ width: innerWidth, height: innerHeight }), floorInset: () => floorGap() },
  surface: {
    stage: $('#stage'), kind: host ? 'existing-native-window' : 'browser-preview', watchWindows: value => host?.watchWindows?.(value),
    exitScene: returnToDesktop,
    wallpaperPointerBlocked: (point,target) => clicksPass() || hitBody(point) || pressing || !!frameDrag
      || !!target.closest?.('.menu,.tools,.bubble,[data-scene-grip],[data-scene-exit],.landscape-chat-dock'),
  },
  receipt: message => send(message),
});
const speech = system.speech;
if (host) sfx.unlock();
else ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => sfx.unlock(), { capture: true }));

/** Native floor coordinate stays stable when the window grows over or shrinks away from the taskbar. */
let below = 0, desktopFloor = null;
const floorGap = () => host ? desktopFloor === null ? 2 + below : Math.max(0, innerHeight - desktopFloor) : 48;
const bounds = () => system.presentation.bounds();
/**
 * The body on screen (body-host.js), null until the first one is ready, and the words it does (its pack's
 * vocab, by id). `T` is the page's clock, in seconds of frames drawn.
 */
let words = new Map(), T = 0;
/** Where the body last said it is (body-host.js `layout`), or null. */
const at = () => system.body?.layout ?? null;
/** What the body is told of the page: talking orders hold its roaming off, and these states. */
const bodyState = { listening: false, thinking: false, thoughtShown: true, dialogOpen: false, still: false, status: null };
const holdRoam = (seconds) => system.body?.set({ hold: seconds });
host?.onFloor?.((floor) => {
  if (typeof floor === 'number') { below = floor; desktopFloor = null; }
  else if (Number.isFinite(floor?.y)) { below = floor.below; desktopFloor = floor.y; }
  else return;
  system.presentation.refresh();
});
// the window reads the windows on its display only while the body on screen asks for them (`watchWindows`)
host?.onWindows?.((desk) => system.body?.setWindows(desk));
addEventListener('resize', () => {
  endFrameDrag();
  system.refreshPresentation();
  // the World reads walk targets and drop spots against the stage the pet is on now
  send({ t: 'hello', screen: { w: innerWidth, h: innerHeight } });
});

/* ---------- connection ---------- */
let ws = null, backoff = 500, watching = false;
function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}
host?.onWorkspace?.(() => send({ t: 'control', action: 'dress' }));
function connect() {
  const params = new URLSearchParams({ role: 'pet', host: host ? 'window' : 'tab' });
  if (windowKey) params.set('key', windowKey);
  ws = new WebSocket(`ws://${location.host}/socket?${params}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { backoff = 500; watching = false; send({ t: 'hello', screen: { w: innerWidth, h: innerHeight }, host: host ? 'window' : 'tab' }); reportVisibility(); };
  ws.onmessage = (e) => { try { onOrder(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = (e) => {
    presenting?.controller.abort();
    system.movement.cancel('disconnected');
    cancelPointer('disconnected');
    system.releasePreview();
    void system.restoreAppearance(undefined, skin.scheme)?.catch(() => {});
    cancelUtterances('disconnected');
    ws = null;
    rejectPhoneControls();
    phoneChat.failed();
    landscapeChat.failed();
    clearTimeout(desktopModeRequestTimer);
    sceneRequest = null;
    sceneExitMessage = '';
    updateMenuStatus();
    resetDesktopControls();
    pendingModel?.controller.abort();
    system.cancelBodySwap();
    stopMic();
    // the World gave up on these steps when the page went; it asks again once the page is back
    dropDialogs();
    setStatus(null);
    if (e.code === 4000 && !host) return;
    setTimeout(connect, backoff);
    backoff = Math.min(8000, backoff * 2);
  };
}
/** The pet window says whether it is shown: hidden from its menu or the tray, it stays connected. */
let windowShown = true;
function reportVisibility() { if (host) send({ t: 'visibility', hidden: !windowShown }); }
// the page itself always reads as visible (its window does not throttle it): the window process says when it is hidden
host?.onShown?.((shown) => {
  windowShown = shown; sfx.setShown(shown);
  system.presentation.setVisible?.(shown);
  if (!shown) { resetDesktopControls(); presenting?.controller.abort(Error('window-hidden')); cancelUtterances('window-hidden'); system.movement.cancel('window-hidden'); cancelPointer('window-hidden'); }
  else applyInitialPresentation();
  reportVisibility();
});
/** Clicks pass through because a fullscreen window covers the pet's display and the setting says so; the window process decides. */
let fullscreenThrough = false;
host?.onFullscreenThrough?.((on) => { fullscreenThrough = on; if (on) { endFrameDrag(); resetDesktopControls(); } });
/** Every click passes through the pet right now, by the tray or the fullscreen setting. */
const clicksPass = () => prefs.clickThrough || fullscreenThrough;

/* ---------- OBS overlay: while the window streams, each frame drawn is reported with the part it sends, the pet and its bubbles ---------- */
let overlayOn = false;
/** The body's box with room for its halo and what floats above its head, joined with the bubbles shown; null with no body. */
function overlayRect() {
  const b = at()?.box;
  if (!b) return null;
  // the halo reaches about 40% of the body's width out; emotes and z's float up to its height above; a pack's effects as far as it says
  const reach = (shownPack?.effects?.reach ?? 0) * 256 * bounds().S;
  const side = Math.max(24, .4 * b.w, reach), top = Math.max(48, b.h, reach);
  const parts = [{ x: b.x - side, y: b.y - top, width: b.w + 2 * side, height: b.h + top + side }];
  if (system.mode === 'phone') parts.push(phoneChat.frame.getBoundingClientRect());
  for (const el of [bubble, ...lines.map((l) => l.el)]) if (!el.hidden) parts.push(rectOf(el));
  const x = Math.max(0, Math.min(...parts.map((r) => r.x))), y = Math.max(0, Math.min(...parts.map((r) => r.y)));
  const right = Math.min(innerWidth, Math.max(...parts.map((r) => r.x + r.width))), bottom = Math.min(innerHeight, Math.max(...parts.map((r) => r.y + r.height)));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
host?.onOverlay?.((on) => { overlayOn = on; });
// the text is in before anything is shown
void useLanguage().then(() => { document.title = t('pet.title'); host?.setLanguage?.(language()); connect(); });

/*
 * A loaded body reports its model and supported words. The World commits a new
 * selection after its first frame. A failed candidate leaves the confirmed body in place.
 */
let skin = normalizeSkin(null), wanted = null, pendingModel = null, lastModelCommit = null;
let skinLoad = null;
function reportFigure(id, ok, reason, scheme, known, request) {
  send({ t: 'figure', id, ok, ...(scheme ? { scheme } : {}), ...(reason ? { reason } : {}), ...(known !== undefined ? { words: known } : {}), ...(request ? { request } : {}),
    ...(ok&&system.body?.pack===id&&system.body.modelConfiguration?{configuration:system.body.modelConfiguration}:{}) });
}
function bodyFailed(id, err) {
  console.error(err);
  reportFigure(id, false, String(err?.message ?? err));
  if (system.body?.pack === id) clearCurrentBody();
}
function clearCurrentBody() {
  resetDesktopControls();
  system.removeBody();
  shownPack = null;
  words.clear();
}
/** Where the first body stands: the spot the World remembered (`restorePosition`), facing the middle of the screen; `firstY` for a body off the floor. */
let firstX = null, firstY = null;
/** The pack whose body is being loaded: skins that come meanwhile wait for it (`skin` holds the latest). */
let loading = null;
async function showFigure(s) {
  wanted = s.figure;
  if (!s.figure) {
    if (system.body) clearCurrentBody();
    return;
  }
  if (loading === s.figure) return;
  // An outfit change on the existing model fades in.
  if (system.body?.pack === s.figure) {
    system.cancelBodySwap();
    system.body.set({ skin: s });
    await system.body.setScheme(s.scheme, { fade: .45 });
    lightFor(s);
    reportFigure(s.figure, true, null, s.scheme);
    if (!menu.hidden) controlPhone.appearanceApplied(s.figure);
    return;
  }
  loading = s.figure;
  try { await swapBody(s); } finally { if (loading === s.figure) loading = null; }
  // a pick that came while the body was loading
  if (system.body?.pack === skin.figure && skin !== s) await showFigure(skin);
}
async function swapBody(s, modelLoad) {
  const signal = modelLoad?.controller.signal;
  const response = await fetch('/api/bodies/' + encodeURIComponent(s.figure), { signal });
  const pack = response.ok ? await response.json() : null;
  if (!pack) throw new Error(t('figure.notInstalled'));
  const was = at();
  const x = was?.x ?? firstX ?? innerWidth * .7, y = was ? was.y : firstY;
  const holder = {};
  const next = await system.swapBody({
    layer: $('#figureLayer'), pack, theme: prefs.theme, bounds: bounds(),
    signal,
    // the new body stands where the old one stood; the first one drops in
    start: { x, ...(typeof y === 'number' ? { y } : {}), facing: was?.facing ?? (x < innerWidth / 2 ? 1 : -1), enter: system.body ? undefined : 'drop', skin: s, scheme: s.scheme },
    onEvent: (kind, d) => { if (system.body === holder.body) onBody(kind, d); },
    onSound: (name, kind, ...args) => { if (system.body === holder.body) sfx.play(name, kind, ...args); },
    onError: (err) => { if (system.body === holder.body) bodyFailed(pack.id, err); },
    onBodyEffects: () => { if (system.body === holder.body) reportBodyEffects(); },
  }, {
    validate() {
      if (modelLoad) {
        signal.throwIfAborted();
        if (modelLoad.previous !== skin.figure || worn || loading) throw new Error(t('figure.changedWhileLoading'));
      } else if (wanted !== s.figure) throw new DOMException('Figure choice superseded', 'AbortError');
    },
    configure(candidate, currentBody) {
      if ((modelLoad || system.mode !== 'desktop') && currentBody?.layout) {
        const current = currentBody.layout;
        candidate.place(current.x, current.facing, current.y);
      }
      holder.body = candidate;
      candidate.set({ roam: system.mode === 'desktop' ? prefs.roam : 'off', ...bodyState });
    },
  });
  // Identity/render lifecycle has committed. The page owns only UI/model metadata.
  if (was) { resetDesktopControls(); cancelUtterances('body-changed'); }
  if (modelLoad) {
    lastModelCommit = { request: modelLoad.request, next: s.figure, previous: skin };
    skin = s;
    wanted = s.figure;
  }
  reportBodyEffects();
  words = new Map(pack.vocab.map((w) => [w.id, w]));
  shownPack = pack;
  lightFor(s);
  sfx.usePack(pack.base, pack.sounds, pack.voice);
  reportFigure(s.figure, true, null, s.scheme, next.words, modelLoad?.request);
  applyInitialPresentation();
}
let lastFrameworkReport = -Infinity;
let initialPresentation = null, presenting = null;
function applyInitialPresentation() {
  if (!initialPresentation || !system.body || presenting || !windowShown) return;
  const mode = initialPresentation;
  initialPresentation = null;
  void changePresentation({ mode, request: null });
}
async function changePresentation(message) {
  if (presenting) {
    send({ t: 'presentation-result', request: message.request, ok: false, mode: system.mode,
      figure: system.body?.pack, reason: 'presentation-busy' });
    return;
  }
  const controller = new AbortController();
  presenting = { request: message.request, controller };
  updateMenuStatus();
  syncPhoneChat();
  try {
    let wallpaper = message.wallpaper;
    if (!wallpaper && message.mode === 'wallpaper') {
      const response = await fetch('/api/wallpaper-settings', {signal:controller.signal});
      if (!response.ok) throw Error('wallpaper-source-unavailable');
      wallpaper = await response.json();
    }
    await system.selectPresentation(message.mode, {
      signal: controller.signal,
      wallpaper, replace:message.replace,
      beforeCommit() {
        cancelPointer('presentation-changed');
        if (hold.el?.closest('.phone-chat-dock,.landscape-chat-dock')) endHold(true);
        controlPhone.stopModelSizePreview();
        controlPhone.clearPreview();
      },
      async confirm() {
        if (message.request === null) return;
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timeout); reject(controller.signal.reason); };
          const timeout = setTimeout(() => controller.abort(Error('presentation-confirmation-timeout')), 2500);
          controller.signal.addEventListener('abort', abort, { once: true });
          presenting.confirm = () => {
            clearTimeout(timeout);
            controller.signal.removeEventListener('abort', abort);
            resolve();
          };
          send({ t: 'presentation-ready', request: message.request, mode: message.mode, figure: system.body?.pack });
        });
      },
      async ready(figure, revision, area, signal, scope) {
        const until = performance.now() + 3500;
        while (performance.now() < until) {
          signal.throwIfAborted();
          const box = figure.layout?.box;
          if (figure.frameRevision > revision && figure.reportedFrameScope === scope && windowShown
            && box?.w > 0 && box?.h > 0 && area.W > 0 && area.H > 0) return;
          await new Promise(resolve => setTimeout(resolve, 16));
        }
        throw Error('presentation-first-frame-timeout');
      },
    });
    sceneExitMessage = '';
    if (sceneRequest?.exiting && sceneRequest.request === message.request) closeMenu();
    sentX = sentY = null;
    reportFramework();
    send({ t: 'presentation-result', request: message.request, ok: true, mode: system.mode,
      figure: system.body?.pack, generation: system.modelGeneration, presentation: system.presentation.snapshot() });
    reportPosition();
  } catch (error) {
    send({ t: 'presentation-result', request: message.request, ok: false, mode: system.mode,
      figure: system.body?.pack, reason: String(error.message ?? error) });
  } finally { presenting = null; updateMenuStatus(); syncPhoneChat(); applyInitialPresentation(); }
}

function startSceneOrder(message) {
  try {
    if (system.switching || message.mode && message.mode !== system.mode) throw Error('scene-changed');
    let target = message.target;
    const area = system.scene.rect?.();
    if (area && message.normalized && typeof target === 'object') {
      target = { x: area.x + target.x * area.w, y: area.y + (target.y ?? .78) * area.h };
    }
    if (system.mode === 'desktop') {
      if (typeof target !== 'object' || message.interact) throw Error('target-unreachable');
      system.actions.walk({ t: 'walk', id: message.id, to: target.x, run: !!message.run, sceneOrder: true }, null);
      return;
    }
    system.movement.start({ ...message, target });
  } catch (error) {
    const reason = String(error.message ?? error);
    if (message.tool) send({ t: 'interrupted', walkId: message.id, x: .5, by: reason });
    send({ t: 'scene-result', id: message.id, status: 'failed', reason });
  }
}

function reportFramework() {
  lastFrameworkReport = T;
  send({ t: 'framework-state', figure: system.body?.pack ?? null, snapshot: system.snapshot() });
}
function reportBodyEffects() {
  reportFramework();
  const state = system.snapshot();
  send({ t: 'body-effects', figure: system.body?.pack, requested: state.bodyEffects, report: state.bodyEffectsStatus });
}
async function applyFigure(s) {
  try { await showFigure(s); } catch (err) { if (err?.name !== 'AbortError') bodyFailed(s.figure, err); }
}

async function loadDesktopFigure({ request, skin: nextSkin }) {
  pendingModel?.controller.abort();
  const s = normalizeSkin(nextSkin);
  const load = { request, previous: skin.figure, controller: new AbortController() };
  pendingModel = load;
  try {
    // The socket connects before its saved body has drawn the first frame.
    // Let that render settle before staging the user's explicit selection.
    while (skinLoad) {
      await skinLoad;
      load.controller.signal.throwIfAborted();
    }
    await swapBody(s, load);
  } catch (error) {
    if (!load.controller.signal.aborted) reportFigure(s.figure, false, String(error?.message ?? error), null, undefined, request);
  } finally { if (pendingModel === load) pendingModel = null; }
}

async function configureDesktopModel({request,id,configuration}) {
  try {
    if(pendingModel)throw Error('A different model is loading');
    const applied=await system.configureModel(id,configuration);
    if(applied.actions){
      words=new Map(applied.actions.filter(word=>!system.body.words||system.body.words.includes(word.id)).map(word=>[word.id,word]));
      if(shownPack?.id===id)shownPack={...shownPack,vocab:applied.actions};
    }
    reportFramework();
    send({t:'model-configuration',request,id,ok:true,configurationRevision:applied.revision,words:system.body.words});
  }catch(error){send({t:'model-configuration',request,id,ok:false,reason:String(error?.message??error)});}
}

/**
 * The pet window puts the pet where it stood when the World last stopped (`startX`, a share of the window
 * width, and `startY` of its height for a body that stood off the floor) from the first `init` only; after a reconnect it stays where it is. While `rememberPosition` is on it
 * reports where the pet stands each time the body changes mode, so the World holds the place of its last stop.
 */
let restored = false, sentX = null, sentY = null;
function restorePosition(startX, startY) {
  sentX = null;
  if (restored) return;
  restored = true;
  // She starts facing the middle of the screen, so a pet
  // resting on the right half is not turned away from the likely interaction area.
  if (host && typeof startX === 'number') {
    ({ x: firstX, y: firstY } = system.scene.restore(startX, startY));
    system.body?.place(firstX, firstX < innerWidth / 2 ? 1 : -1, firstY ?? undefined);
  }
}
function reportPosition() {
  const l = at();
  if (!host || !l || system.switching) return;
  const normalized = system.scene.normalize(l), x = normalized.x, y = normalized.y ?? null;
  if (sentX !== null && Math.abs(x - sentX) * innerWidth < 1 && (y === null) === (sentY === null) && Math.abs((y ?? 0) - (sentY ?? 0)) * innerHeight < 1) return;
  sentX = x; sentY = y;
  const saved = system.rememberPosition(l);
  if (saved && prefs.rememberPosition) send({ t: 'position', mode: system.mode, ...saved });
}

/** The skin as the config has it while a dialog card dresses the body in another (`tryOn`); null otherwise. */
let worn = null;
function trackSkinLoad(applying) {
  skinLoad = applying;
  void applying.finally(() => { if (skinLoad === applying) skinLoad = null; });
}
function putOn(s) {
  if ((system.body?.pack === s.figure || loading === s.figure) && JSON.stringify(s) === JSON.stringify(skin)) return;
  skin = s;
  trackSkinLoad(applyFigure(skin));
}
/** A dialog card's skin on the body, over the config's, until the step ends (`takeOff`). */
function tryOn(patch) {
  worn ??= skin;
  putOn(normalizeSkin({ ...worn, ...patch }));
}
/** Ends a card's try-on: `keep` leaves it on (it was the answer, and the config takes it next), else the config's skin comes back. */
function takeOff(keep) {
  if (!worn) return;
  const was = worn;
  worn = null;
  if (!keep) putOn(was);
}

let windowPolicyRequest = 0;
async function applyWindowPolicy(hideFromCapture, overTaskbar) {
  const request = ++windowPolicyRequest, socket = ws;
  let capture = 'unsupported', overlap = null;
  if (host?.windowCompatibility) {
    try {
      const report = await host.windowCompatibility({ hideFromCapture, overTaskbar });
      capture = report?.capture ?? 'failed';
      overlap = report?.overTaskbar ?? null;
    } catch { capture = 'failed'; }
  }
  if (request === windowPolicyRequest && socket === ws) {
    send({ t: 'window-compatibility', hideFromCapture, capture, overTaskbar: overlap });
  }
}

function applyPrefs(p) {
  system.configuration.apply(p);
  // while a card is tried on, the config's skin waits until the step ends
  if (p.skin) { if (worn) worn = normalizeSkin(p.skin); else putOn(normalizeSkin(p.skin)); }
  if (p.roam) { prefs.roam = p.roam; system.configuration.apply({ roam: p.roam }); }
  if (typeof p.sound === 'boolean') { prefs.sound = p.sound; sfx.set(p.sound); }
  if (p.sounds && typeof p.sounds === 'object') sfx.configure({ kinds: p.sounds, snoreSeconds: p.sounds.snoreSeconds, panByPosition: p.sounds.panByPosition, volume: p.sounds.volume });
  if (p.theme === 'dark' || p.theme === 'light') { prefs.theme = p.theme; applyTheme(p.theme); modeBtn?.show(p.theme); system.body?.set({ theme: p.theme }); }
  if (typeof p.glow === 'number') prefs.glow = p.glow;
  if (p.presentationScales) { prefs.presentationScales = p.presentationScales; controlPhone.applyModelSize(); }
  else if (typeof p.scale === 'number') { prefs.scale = p.scale; controlPhone.applyModelSize(); }
  if (typeof p.bubbleSize === 'number') { prefs.bubbleSize = p.bubbleSize; sizeVar('--bubble-size', p.bubbleSize); }
  if (typeof p.fontSize === 'number') { prefs.fontSize = p.fontSize; sizeVar('--bubble-font', p.fontSize); }
  if (typeof p.bubbleSpeed === 'number') prefs.bubbleSpeed = p.bubbleSpeed;
  if (typeof p.rememberPosition === 'boolean') { prefs.rememberPosition = p.rememberPosition; reportPosition(); }
  if (typeof p.user === 'string') prefs.user = p.user;
  if (typeof p.micDevice === 'string' && p.micDevice !== prefs.micDevice) { prefs.micDevice = p.micDevice; stopMic(); }
  if (typeof p.mic === 'boolean') { prefs.mic = p.mic; p.mic && !watching ? startMic() : stopMic(); }
  if (p.voice && typeof p.voice === 'object') prefs.voice = { ...prefs.voice, ...p.voice };
  if (typeof p.doubleClickChat === 'boolean') prefs.doubleClickChat = p.doubleClickChat;
  if (typeof p.statusBubble === 'boolean') { prefs.statusBubble = p.statusBubble; setBody({ thoughtShown: p.statusBubble }); }
  if (typeof p.saidBubbles === 'boolean') { prefs.saidBubbles = p.saidBubbles; if (!p.saidBubbles) for (const line of lines) if (!line.live) fadeLine(line); }
  if (typeof p.lockFrameRate === 'boolean') prefs.lockFrameRate = p.lockFrameRate;
  if (typeof p.frameRate === 'number' && p.frameRate >= 0) prefs.frameRate = p.frameRate;
  // the window process does the hiding and the passing through; the page only passes the settings on
  if (typeof p.hideWhenFullscreen === 'boolean') host?.hideWhenFullscreen?.(p.hideWhenFullscreen);
  if (typeof p.passWhenFullscreen === 'boolean') host?.passWhenFullscreen?.(p.passWhenFullscreen);
  if (host && typeof p.hideFromCapture === 'boolean' && typeof p.overTaskbar === 'boolean') {
    void applyWindowPolicy(p.hideFromCapture, p.overTaskbar);
  }
  if (typeof p.clickThrough === 'boolean') { prefs.clickThrough = p.clickThrough; host?.clickThrough?.(p.clickThrough); if (p.clickThrough) { endFrameDrag(); resetDesktopControls(); } }
  if (typeof p.hoverButtonsVisible === 'boolean') prefs.hoverButtonsVisible = p.hoverButtonsVisible;
  if (typeof p.touchRegionsVisible === 'boolean') prefs.touchRegionsVisible = p.touchRegionsVisible;
  if (p.controlLayout) {
    prefs.hoverButtons = p.controlLayout.rail.filter(id => Object.hasOwn(ACTIONS, id));
    controlPhone.setLayout(p.controlLayout);
  } else if (Array.isArray(p.hoverButtons)) {
    prefs.hoverButtons = [...p.hoverButtons.filter(id => Object.hasOwn(ACTIONS, id)), 'menu'];
  }
  if (p.bot) prefs.bot = p.bot;
  if (typeof p.language === 'string' && p.language !== language()) void switchLanguage(p.language);
  if ('status' in p) setStatus(p.status);
  refreshButtons();
}

/** Sets a bubble size factor on the page (pet.css); at 1 it is unset, so the bubbles are drawn exactly as pet.css writes them. */
function sizeVar(name, k) {
  if (k === 1) document.documentElement.style.removeProperty(name);
  else document.documentElement.style.setProperty(name, String(k));
}

/** A new app language: what is drawn from the page's own text is drawn again; bubbles already up keep theirs. */
async function switchLanguage(code) {
  await useLanguage(code);
  document.title = t('pet.title');
  host?.setLanguage?.(code);
  refreshButtons();
}

function onOrder(m) {
  switch (m.t) {
    case 'init':
      lastModelCommit = null;
      restorePosition(m.startX, m.startY);
      system.setPositions(m.presentationPositions);
      if (host) initialPresentation = m.presentationMode ?? 'desktop';
      applyPrefs(m);
      if (host && system.body?.pack === m.skin?.figure) applyInitialPresentation();
      if (!host) announcePainted();
      break;
    case 'desktop-presentation-result': finishDesktopScene(m); break;
    case 'phone-message-result': phoneChat.receipt(m); landscapeChat.receipt(m); break;
    case 'phone-history': phoneChat.history(m); break;
    case 'phone-control-result': settlePhoneControl(m); break;
    case 'presentation-resume': if (host) { initialPresentation = m.mode; applyInitialPresentation(); } break;
    case 'presentation-apply': if (host) void changePresentation(m); break;
    case 'presentation-scale-preview':
      system.configuration.previewScale(m.mode,m.scale);
      break;
    case 'wallpaper-options':
      system.configuration.apply({wallpaper:m.wallpaper});
      updateMenuStatus();
      reportFramework();
      break;
    case 'presentation-confirm': if (presenting?.request === m.request) presenting.confirm?.(); break;
    case 'presentation-cancel': if (presenting?.request === m.request) presenting.controller.abort(); break;
    case 'preview-model-visual':
      try { system.previewVisual(m.figure, m.owner, m.value, m.id); }
      catch (error) { send({ t: 'visual-preview-failed', figure: m.figure, owner: m.owner, request: m.id, reason: String(error.message ?? error) }); }
      break;
    case 'scene-order': if (host) startSceneOrder(m); break;
    case 'scene-cancel': if (!system.movement.cancel('cancelled', m.id)) system.actions.stopWalk(m.id); break;
    case 'prefs': applyPrefs(m); break;
    case 'load-figure': void loadDesktopFigure(m); break;
    case 'configure-model': void configureDesktopModel(m); break;
    case 'confirm-figure-load':
      if (lastModelCommit?.request === m.request) lastModelCommit = null;
      break;
    case 'cancel-figure-load':
      if (pendingModel?.request === m.request) pendingModel.controller.abort();
      if (lastModelCommit?.request === m.request) {
        const previous = lastModelCommit;
        lastModelCommit = null;
        if (skin.figure === previous.next) putOn(previous.previous);
      }
      break;
    case 'watching': watching = true; stopMic(); break;
    // the settings window's 「在桌面上隐藏」: the same as the menu's 「隐藏」
    case 'hide': host?.hide?.(); break;
    case 'show': host?.show?.(); break;
    case 'desktop-release':
      stopMic(); cancelUtterances('desktop-released'); cancelPointer('desktop-released');
      system.actions.interrupt('desktop-released');
      queue.length = 0; closeBubble(); closeWheel();
      break;
    case 'type': openTyping(); break;
    case 'speech-preview': if (!item && !queue.length) speech.audition(m.id); else send({ t: 'speech-media', id: m.id, status: 'cancelled', reason: 'speech-busy' }); break;
    case 'speech-stop':
      if (m.reason === 'voice-input') stopForVoiceInput();
      else speech.stop();
      break;
    case 'say': dropAsks(); queue.push({ ...m, kind: 'say', i: -1 }); holdRoam(20); break;
    case 'ask': dropAsks(); queue.push({ kind: 'ask', id: m.id, question: m.question, options: m.options || [], own: m.own !== false }); holdRoam(20); break;
    case 'confirm': dropAsks(); rushLines(); queue.push({ kind: 'ask', confirm: true, id: m.id, question: m.question, options: m.options, own: false }); holdRoam(20); break;
    case 'walk': walk(m); break;
    case 'move': walk(m); break;
    case 'walk-stop': if (!system.movement.cancel('cancelled', m.id)) system.actions.stopWalk(m.id); break;
    case 'ask-close': closeAsk(m.id); break;
    case 'held-input-preview': if (system.body?.pack === m.figure) system.input.preview(m.snapshot, m.id); break;
    case 'release-edit-preview':
      if (system.body?.pack === m.figure) {
        system.releasePreview(m.owner);
        void system.restoreAppearance(m.owner, skin.scheme)?.then(reportFramework).catch(() => {});
      }
      break;
    case 'preview-draft-wardrobe': system.previewDraftWardrobe(m); break;
    case 'preview-edit-appearance':
      void system.previewAppearance(m.figure, m.owner, m.scheme, skin.scheme).then(reportFramework, reportFramework);
      break;
    case 'draft-action': {
      void system.draftAction(m.figure, m.command, m.id).then(report => {
        reportFramework();
        send({ t: 'draft-action-result', figure: m.figure, requestId: m.id, ok: true, report });
      }, error => send({ t: 'draft-action-result', figure: m.figure, requestId: m.id, ok: false, reason: String(error?.message ?? error) }));
      break;
    }
    case 'framing-preview': if (system.body?.pack === m.figure) system.framing.command(m.command,m.owner,m.id); break;
    case 'speech-control': if (system.body?.pack === m.figure) speech.preview(m.kind, m.id); break;
    case 'act': if (m.figure && m.figure !== system.body?.pack) { system.actions.rejectRequest(m.id, m.actions, 'body-changed'); break; } system.actions.enqueueRequest(m.id ?? null, ...m.actions); holdRoam(20); break;
    case 'listen': onListen(m); break;
    // a message sent from the chat page, once the bot has it, and one taken back before delivery
    case 'said': {
      const text = typeof m.text === 'string' ? m.text : '';
      const images = Number(m.images) || 0;
      if (prefs.saidBubbles) addLine('chat', text, false, { images, cursor: m.cursor ?? null });
      break;
    }
    case 'said-withdrawn': withdrawLine(m.cursor); break;
    case 'status': setStatus(m.status); break;
    case 'dialog': queue.push({ kind: 'dialog', id: m.id, d: m }); holdRoam(20); break;
    case 'dialog-update': updateDialog(m); break;
    case 'dialog-close': endDialog(m.id); break;
  }
}

/** Tells the body of a change in the page's states (listening, thinking, a bubble that wants it to stay put). */
function setBody(change) {
  if (Object.entries(change).every(([k, v]) => bodyState[k] === v)) return;
  Object.assign(bodyState, change);
  system.body?.set(change);
}

/* ---------- body events → World ---------- */
function onBody(kind, d) {
  if (kind === 'scene-drop') {
    if (pendingSceneDrop && d.id === pendingSceneDrop.id) {
      const { point, mode } = pendingSceneDrop;
      pendingSceneDrop = null;
      if (d.dropped && !system.switching && mode === system.mode) system.movement.drop(point);
    }
  } else if (kind === 'touch-reaction') {
    send({ t: 'touch-reaction', ...d });
  } else if (kind === 'touch') {
    send({ t: 'touch', ...d, figure:system.body?.pack });
    if (d.kind === 'grab') { resetDesktopControls(); system.movement.cancel('dragged'); }
  } else if (kind === 'visual-preview') reportFramework();
  else if (kind === 'mode') { reportPosition(); if (system.mode !== 'desktop') reportFramework(); }
}

/** World commands enter Action; Scene resolves targets, Body executes and emits receipts. */
function walk(m) {
  if (system.mode === 'desktop') { system.actions.walk(m, pointerSeen ? lastPointer : null); return; }
  const area = system.scene.rect();
  const target = m.t === 'move' ? m.move.to : m.to === 'cursor' && pointerSeen ? { ...lastPointer }
    : { x: area.x + area.w * Math.max(.07, Math.min(.93, m.to === 'cursor' ? .5 : m.to)), y: area.y + area.h * .79 };
  startSceneOrder({ id: m.id, target, run: m.run ?? m.move?.run, interact: m.t === 'move', tool: true });
}

/* ---------- say / ask ---------- */
const queue = [];
let item = null;
/** Where typing pauses: sentence and clause marks, Latin and full-width (Chinese and Japanese share 。、). */
const PAUSE = /[,.!?;:…，。！？；：、]/;

function cancelClips(utterance, reason) {
  // The player reports the clip it owns. Release only the clips that have yet to reach it.
  for (const id of utterance.clips?.slice(Math.max(0, utterance.i + (utterance.startedBeat ? 1 : 0))) ?? []) {
    if (id) send({ t: 'speech-media', id, status: 'cancelled', reason });
  }
  utterance.clips = [];
}

function cancelUtterances(reason) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].kind === 'say') cancelClips(queue.splice(i, 1)[0], reason);
  }
  if (item?.kind === 'say') closeBubble(reason);
  else speech.stop(reason);
}

function stopForVoiceInput() {
  for (const it of [item, ...queue]) if (it?.kind === 'say') cancelClips(it, 'voice-input');
  speech.stop('voice-input');
}

/** Lines queued before a World's confirmation are shown quickly in text. */
const RUSH = 6, RUSH_HOLD = 1;
function rushLines() {
  for (const q of [item, ...queue]) {
    if (q?.kind !== 'say' || q.rush) continue;
    q.rush = true;
    cancelClips(q, 'confirmation');
    if (q === item) { speech.stop('confirmation'); if (q.beatDone) q.holdUntil = Math.min(q.holdUntil, T + RUSH_HOLD); }
  }
}

/** A newer question replaces the bot's open one; a World's confirmation stays until answered. */
function dropAsks() {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === 'ask' && !queue[i].confirm) queue.splice(i, 1);
  if (item && item.kind === 'ask' && !item.answered && !item.confirm) closeBubble();
}

const bubbleHover = createBubbleHover();
let holdingBubble = false;
function openBubble(kind, html) {
  bubbleHover.open();
  holdingBubble = false;
  bubble.className = 'bubble ' + kind;
  bubble.removeAttribute('aria-label');
  delete bubble.dataset.kind; delete bubble.dataset.icon;
  bubble.innerHTML = html;
  bubble.hidden = false;
  void bubble.offsetWidth;
  bubble.classList.add('pop');
}
function closeBubble(reason = 'bubble-closed') {
  if (item?.kind === 'say' || item?.kind === 'ask' && !item.confirm) rememberSpoken(item);
  releaseKeys(item);
  // a step taken off the bubble unanswered puts back the skin a card tried on
  if (item?.kind === 'dialog') { talk.motion = null; takeOff(false); }
  bubble.hidden = true; bubble.innerHTML = '';
  // the lines it answered fade a moment after (stepLines)
  if (item) item.endedAt = T;
  if (item?.kind === 'say') cancelClips(item, reason);
  item = null;
  speech.stop(reason);
}

/**
 * The typing key: the typing box, as a double-click opens it, or the one already open. The pet window
 * takes the keyboard from the window in front and gives it back when the box closes (releaseKeys).
 */
function openTyping() {
  if (system.mode === 'phone') { host?.focus?.(); return phoneChat.focusInput(); }
  if (system.mode !== 'desktop' && item?.kind !== 'input') return landscapeChat.open();
  if (item?.kind !== 'input') openInput();
  // a question waiting on an answer keeps the bubble
  if (item?.kind !== 'input') return;
  // again for a box already open: the keyboard may have gone back to another window meanwhile
  if (host?.grabFocus) { item.grabbed = true; host.grabFocus(); }
  setTimeout(() => bubble.querySelector('textarea')?.focus(), 30);
}

/**
 * While a question's options are up, the pet window takes the keyboard so 1–9 pick one right
 * away, and gives it back to the window that had it once the question is answered or gone.
 */
function grabKeys(it) {
  if (!host?.grabFocus || !it.options.length) return;
  it.grabbed = true;
  host.grabFocus();
}
function releaseKeys(it) {
  if (!it?.grabbed) return;
  it.grabbed = false;
  host.releaseFocus();
}

function startItem(it) {
  item = it;
  if (it.kind === 'say' || it.kind === 'ask') answerLines(it);
  if (it.kind === 'dialog') { openDialog(it); return; }
  if (it.kind === 'ask') {
    openBubble('ask', `<button class="b-close" type="button" aria-label="${esc(t('bubble.close'))}">×</button><p class="b-text"></p><div class="b-opts" hidden></div>`);
    bubble.querySelector('.b-close').addEventListener('click', () => dismissAsk());
    it.text = it.question; it.shown = 0; it.acc = 0; it.optsShown = false;
    if (it.confirm) sfx.confirm();
    else sfx.pop();
    if (it.confirm) {
      // the bubble stays where it opened while Coo moves; the World counts the wait from now
      const a = at()?.bubble ?? { x: innerWidth / 2, y: innerHeight };
      it.pinX = a.x; it.pinY = a.y;
      send({ t: 'confirm-shown', id: it.id });
    }
  }
}

/**
 * The cursor is on Coo's bubble: a line's countdown stands still meanwhile, so it can be read to the end or its link
 * clicked. Decided from where the cursor is now, as stepTools does: `:hover` stays with the last mouse event, and a
 * click-through window stops getting them once the cursor has left.
 */
function pointedAt() {
  const p = cursor.at;
  if (clicksPass() || bubble.hidden || !p) return false;
  const r = bubble.getBoundingClientRect();
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

function rememberSpoken(it) {
}

function skipBeat() {
  if (item?.kind !== 'say' || bubble.hidden || !bubble.classList.contains('say')) return;
  speech.stop('skipped');
  holdingBubble = false;
  item.beatDone = true;
  item.holdUntil = -Infinity;
  bubble.hidden = true;
}

function stepDialog(dt) {
  if (!item && queue.length && at() && !at().busy) startItem(queue.shift());
  const it = item;
  if (!it) return;
  if (it.kind === 'say') {
    if (it.i < 0 || it.beatDone) {
      if (it.beatDone && holdingBubble) it.holdUntil += dt;
      if (it.beatDone && T < it.holdUntil) return;
      if (it.i + 1 >= it.beats.length) { closeBubble(); return; }
      if (it.beatDone) rememberSpoken(it);
      it.i++;
      it.beatDone = false;
      const b = it.beats[it.i];
      let lead = 0;
      for (const a of b.actions || []) { system.actions.enqueue(a); lead = .45; }
      it.shown = 0; it.acc = 0; it.fired = 0; it.startAt = T + lead; it.startedBeat = false;
      bubble.hidden = true;
      return;
    }
    const b = it.beats[it.i];
    if (T < it.startAt) return;
    if (!b.text) { it.beatDone = true; it.holdUntil = T + .8 / prefs.bubbleSpeed; return; }
    if (!it.startedBeat) {
      it.startedBeat = true;
      const clip = it.clips?.[it.i];
      const current = it.figure === system.body?.pack && (it.modelGeneration === undefined || it.modelGeneration === system.modelGeneration);
      if (clip && (!current || prefs.mic)) send({ t: 'speech-media', id: clip, status: 'cancelled', reason: prefs.mic ? 'voice-input' : 'target-changed' });
      speech.start(b, { text: b.text, clip: current && !prefs.mic ? clip : null,
        cues: it.i === it.clips?.findIndex(Boolean) ? it.cues : undefined, wantsPlan: it.planClips?.includes(clip), face: it.faces?.[it.i] });
    }
    const progress = speech.progress(b);
    if (progress.mode === 'waiting') return;
    if (bubble.hidden) {
      openBubble('say', `<button class="b-close" type="button" aria-label="${esc(t('bubble.skip'))}" title="${esc(t('bubble.skip'))}">×</button><p class="b-text"></p>`);
      bubble.querySelector('.b-close').addEventListener('click', skipBeat);
    }
    if (progress.mode === 'audio') {
      it.shown = Math.max(it.shown, progress.shown);
      const p = bubble.querySelector('.b-text');
      p?.replaceChildren(linked(b.text, it.shown));
      const anchors = b.anchors ?? [];
      while (it.fired < anchors.length && anchors[it.fired].at <= it.shown) system.actions.enqueue(...anchors[it.fired++].actions);
      if (!progress.done) return;
    } else typeText(it, b.text, dt, b.anchors || []);
    if (it.shown >= b.text.length && !it.beatDone) {
      it.beatDone = true;
      const last = it.i === it.beats.length - 1;
      it.holdUntil = T + (it.rush ? RUSH_HOLD : (last ? 1.6 + b.text.length * .07 : .9 + b.text.length * .03) / prefs.bubbleSpeed);
    }
    return;
  }
  if (it.kind === 'ask') {
    if (it.shown < it.text.length) { typeText(it, it.text, dt, []); return; }
    if (!it.optsShown) { it.optsShown = true; showOptions(it); }
  }
  if (it.kind === 'dialog') stepTalk(it, dt);
}

function typeText(it, text, dt, anchors) {
  const p = bubble.querySelector('.b-text');
  if (!p || it.shown >= text.length) return;
  // estimateSeconds mirrors this text-only rate and the holds in stepDialog.
  it.acc += dt * 20 * prefs.bubbleSpeed * (it.rush ? RUSH : 1);
  while (it.acc >= 1 && it.shown < text.length) {
    const ch = text[it.shown++];
    it.acc -= PAUSE.test(ch) ? 5 : 1;
    while (it.fired < anchors.length && anchors[it.fired].at <= it.shown) system.actions.enqueue(...anchors[it.fired++].actions);
  }
  if (it.marks?.length) p.innerHTML = marked(text, it.shown, it.marks);
  else p.replaceChildren(linked(text, it.shown));
}

/** The first `n` characters of `text`, escaped, with every one of `words` in it wrapped for the theme color. */
function marked(text, n, words) {
  const on = new Array(text.length).fill(false);
  for (const w of words) {
    if (!w) continue;
    for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) on.fill(true, i, i + w.length);
  }
  let out = '', open = false;
  for (let i = 0; i < n; i++) {
    if (on[i] !== open) { out += on[i] ? '<b class="d-mark">' : '</b>'; open = on[i]; }
    out += esc(text[i]);
  }
  return open ? out + '</b>' : out;
}

function showOptions(it) {
  const box = bubble.querySelector('.b-opts');
  it.options.forEach((label, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'b-opt';
    b.innerHTML = i < 9 ? `<kbd>${i + 1}</kbd><span></span>` : '<span></span>';
    b.querySelector('span').textContent = label;
    b.style.animationDelay = (i * .07) + 's';
    b.addEventListener('click', () => answer(b, { index: i }));
    box.appendChild(b);
    setTimeout(() => sfx.blub(), i * 70);
  });
  if (it.own) {
    const form = document.createElement('form');
    form.className = 'b-own';
    form.innerHTML = `<input type="text" maxlength="200" autocomplete="off" placeholder="${esc(t('bubble.ownPlaceholder'))}" aria-label="${esc(t('bubble.ownLabel'))}"><button type="submit">${esc(t('bubble.send'))}</button>`;
    form.style.animationDelay = (it.options.length * .07) + 's';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = form.querySelector('input'), v = input.value.trim();
      if (!v) { input.focus(); return; }
      answer(form, { text: v });
    });
    box.appendChild(form);
  }
  box.hidden = false;
  grabKeys(it);
}

function answer(node, a) {
  const it = item;
  if (!it || it.kind !== 'ask' || it.answered) return;
  it.answered = true;
  sfx.select();
  node.classList.add('chosen');
  bubble.querySelectorAll('.b-opt, .b-own').forEach((n) => { if (n !== node) n.classList.add('dim'); });
  send(it.confirm ? { t: 'confirmed', id: it.id, index: a.index } : { t: 'answer', askId: it.id, ...a });
  if (!it.confirm) {
    rememberSpoken(it);
    phoneChat.message('user', a.text ?? it.options[a.index], 'answer-' + it.id);
  }
  // the bubble stays a moment longer; the keyboard goes back now
  releaseKeys(it);
  system.body?.cue('cheer');
  setTimeout(() => { if (item === it) closeBubble(); }, 700);
}
/** The question was answered elsewhere (the chat page): it leaves the queue or the bubble without an answer from here. */
function closeAsk(id) {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === 'ask' && queue[i].id === id) queue.splice(i, 1);
  if (item && item.kind === 'ask' && item.id === id && !item.answered) { item.answered = true; closeBubble(); }
}
function dismissAsk() {
  const it = item;
  if (!it || it.kind !== 'ask' || it.answered) return;
  it.answered = true;
  send(it.confirm ? { t: 'confirmed', id: it.id, index: null } : { t: 'answer', askId: it.id, dismissed: true });
  closeBubble();
}

/* ---------- an app's conversation: one step at a time in Coo's bubble ---------- */
/** How Coo moves while a step's choice cards are up, around the spot the bubble is pinned to. */
const talk = { motion: null, next: 0 };
/** Pixels Coo strays either side of the bubble while showing a motion. */
const TALK_RANGE = 240;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function dropDialogs() {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === 'dialog') queue.splice(i, 1);
  if (item?.kind === 'dialog') closeBubble();
}

function openDialog(it) {
  const d = it.d;
  const dots = Array.isArray(d.step) ? Array.from({ length: d.step[1] }, (_, i) => `<i class="${i + 1 < d.step[0] ? 'past' : i + 1 === d.step[0] ? 'on' : ''}"></i>`).join('') : '';
  const back = typeof d.back === 'string' && d.back ? `<button class="d-back" type="button">${esc(d.back)}</button>` : '';
  openBubble('talk', `${dots || d.closable || back ? `<div class="d-top">${back}<span class="d-dots">${dots}</span>${d.closable ? `<button class="b-close" type="button" aria-label="${esc(t('bubble.skip'))}" title="${esc(t('bubble.skip'))}">×</button>` : ''}</div>` : ''}<p class="b-text"></p><div class="d-body" hidden></div>`);
  bubble.querySelector('.b-close')?.addEventListener('click', () => settleDialog(it, { closed: true }));
  bubble.querySelector('.d-back')?.addEventListener('click', () => settleDialog(it, { back: true }));
  for (const a of d.actions || []) system.actions.enqueue(a);
  it.text = d.text || ''; it.shown = 0; it.acc = 0; it.bodyShown = false; it.readUntil = 0;
  it.marks = Array.isArray(d.marks) ? d.marks.filter((w) => typeof w === 'string') : [];
  sfx.pop();
}

function stepTalk(it, dt) {
  if (it.shown < it.text.length) { typeText(it, it.text, dt, []); return; }
  if (it.bodyShown) return;
  it.bodyShown = true;
  if (!it.d.input) { it.readUntil = T + (1.4 + it.text.length * .05) / prefs.bubbleSpeed; return; }
  showDialogInput(it);
}

/** A step with nothing to answer ends once its line has been read. */
function stepTalkRead(dt) {
  const it = item;
  if (it?.kind !== 'dialog' || !it.readUntil) return;
  if (holdingBubble) it.readUntil += dt;
  if (T > it.readUntil) settleDialog(it, { done: true });
}

function showDialogInput(it) {
  const body = bubble.querySelector('.d-body'), input = it.d.input;
  if (!body) return;
  if (input.kind === 'buttons') {
    if (input.keys) body.insertAdjacentHTML('beforeend', `<div class="d-keys"><kbd class="d-key${input.taps > 1 ? ' taps' : ''}">${esc(input.keys)}</kbd>${input.taps > 1 ? `<span class="d-taps">×${Number(input.taps)}</span>` : ''}</div>`);
    const row = Object.assign(document.createElement('div'), { className: 'd-row' });
    input.options.forEach((o, i) => row.appendChild(pill(o.label, o.primary, () => settleDialog(it, { index: i }), o.hover)));
    body.appendChild(row);
  } else if (input.kind === 'choices') {
    const cards = Object.assign(document.createElement('div'), { className: input.list ? 'd-cards list' : 'd-cards' });
    const extra = Array.isArray(input.more?.options) ? input.more.options : [];
    const all = [...input.options, ...extra];
    const pick = (i, speak) => {
      it.value = i;
      cards.querySelectorAll('.d-card').forEach((c) => c.classList.toggle('on', Number(c.dataset.i) === i));
      const o = all[i];
      // the bubble stays put from here on, so the cards do not run off while Coo shows how it moves
      if (it.pinX === undefined) { const a = at()?.bubble ?? { x: innerWidth / 2, y: innerHeight }; it.pinX = a.x; it.pinY = a.y; }
      talk.motion = o?.motion ?? null; talk.next = 0;
      if (o?.skin) tryOn(o.skin);
      if (speak && o?.line) { it.text = o.line; it.shown = 0; it.acc = 0; }
      if (speak && o?.actions) system.actions.enqueue(...o.actions);
    };
    const card = (o, k, onClick) => {
      const c = document.createElement('button');
      const tint = o.tint;
      c.type = 'button'; c.className = tint ? 'd-card tint' : 'd-card';
      if (tint) { c.style.setProperty('--tint-l', tint.light); c.style.setProperty('--tint-d', tint.dark); }
      c.style.animationDelay = (k * .07) + 's';
      const image = typeof o.image === 'string' && o.image.startsWith('data:image/') ? `<img class="d-cardimg" alt="" src="${esc(o.image)}">` : '';
      c.innerHTML = `${image || (o.icon && ICONS[o.icon] ? `<span class="d-cardic ic-${esc(o.icon)}">${ICONS[o.icon]}</span>` : '')}<span class="d-cardlbl">${esc(o.label)}</span>${o.note ? `<span class="d-cardnote">${esc(o.note)}</span>` : ''}${o.level ? `<b class="d-level">${esc(o.level)}</b>` : ''}`;
      c.addEventListener('click', () => { sfx.tick(); onClick(); });
      cards.appendChild(c);
      setTimeout(() => sfx.blub(), k * 70);
      return c;
    };
    const add = (from, to, k0) => { for (let i = from; i < to; i++) card(all[i], k0 + i - from, () => pick(i, true)).dataset.i = String(i); };
    const start = typeof input.value === 'number' ? input.value : 0;
    const folded = extra.length > 0 && start < input.options.length;
    add(0, folded ? input.options.length : all.length, 0);
    if (folded) {
      const more = card(input.more, input.options.length, () => {
        // the "more" card gives its place to the first of the rest, and the cards grow to the new rows instead of jumping there
        const from = cards.offsetHeight;
        more.remove();
        add(input.options.length, all.length, 0);
        pick(input.options.length, false);
        const to = cards.offsetHeight;
        if (to !== from && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          cards.classList.add('unfolding');
          cards.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: 320, easing: 'cubic-bezier(.3,1.1,.5,1)' })
            .finished.finally(() => cards.classList.remove('unfolding'));
        }
      });
    }
    body.appendChild(cards);
    const row = Object.assign(document.createElement('div'), { className: input.hint ? 'd-row d-foot-row' : 'd-row' });
    if (input.hint) {
      const h = input.hint, at = h.text.indexOf(h.mark);
      const mark = `<b>${ICONS[h.icon] ?? ''}${esc(h.mark)}</b>`;
      row.insertAdjacentHTML('beforeend', `<span class="d-hint">${at < 0 ? esc(h.text) : esc(h.text.slice(0, at)) + mark + esc(h.text.slice(at + h.mark.length))}</span>`);
    }
    row.appendChild(pill(input.confirm, true, () => settleDialog(it, { index: it.value ?? 0 })));
    body.appendChild(row);
    pick(start, false);
  } else if (input.kind === 'text') {
    const form = Object.assign(document.createElement('form'), { className: 'd-field' });
    form.innerHTML = `<input type="${input.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false" maxlength="${Number(input.maxLength) || 200}">${input.secret ? `<button class="d-peek" type="button" aria-label="${esc(t('bubble.peek'))}" title="${esc(t('bubble.peek'))}">${ICONS.eye}</button>` : ''}<button class="d-send" type="submit"></button>`;
    const field = form.querySelector('input');
    field.placeholder = input.placeholder || '';
    field.value = input.value || '';
    if (Array.isArray(input.suggestions) && input.suggestions.length && !input.secret) {
      const list = document.createElement('datalist');
      list.id = `d-list-${it.id}`;
      for (const s of input.suggestions) list.appendChild(Object.assign(document.createElement('option'), { value: String(s) }));
      form.appendChild(list);
      field.setAttribute('list', list.id);
    }
    field.setAttribute('aria-label', it.text);
    form.querySelector('.d-send').textContent = input.submit;
    form.querySelector('.d-peek')?.addEventListener('click', (e) => {
      const show = field.type === 'password';
      field.type = show ? 'text' : 'password';
      e.currentTarget.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
      field.focus();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = field.value.trim();
      if (!v) { form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); field.focus(); return; }
      settleDialog(it, { text: v });
    });
    body.appendChild(form);
    if (input.link || input.alt) {
      const row = Object.assign(document.createElement('div'), { className: 'd-links' });
      if (input.link) {
        const a = Object.assign(document.createElement('a'), { className: 'd-link', href: input.link.url, target: '_blank', rel: 'noopener' });
        a.innerHTML = `<span></span>${ICONS.external}`;
        a.querySelector('span').textContent = input.link.label;
        row.appendChild(a);
      }
      if (input.alt) {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'd-alt', textContent: input.alt });
        b.addEventListener('click', () => settleDialog(it, { alt: true }));
        row.appendChild(b);
      }
      body.appendChild(row);
    }
    // the window takes the keyboard so the box can be typed in right away
    host?.focus?.();
    setTimeout(() => field.focus(), 30);
  } else if (input.kind === 'progress') {
    body.innerHTML = `<div class="d-bar${typeof it.progress === 'number' ? '' : ' wait'}"><i></i></div><div class="d-barlbl"><span></span><b></b></div>`;
    body.querySelector('.d-barlbl span').textContent = input.label || '';
    drawProgress(it);
  }
  body.hidden = false;
  body.querySelector('.d-send, .d-pill.primary')?.focus?.({ preventScroll: true });
}

/** A button; with `hover`, that label replaces `label` while the button is pointed at or focused, and names it to screen readers. */
function pill(label, primary, onClick, hover) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: `d-pill${primary ? ' primary' : ''}`, textContent: label });
  if (hover) {
    b.classList.add('swap');
    b.setAttribute('aria-label', hover);
    b.innerHTML = `<span class="d-pill-rest">${esc(label)}</span><span class="d-pill-hover">${esc(hover)}</span>`;
  }
  b.addEventListener('click', onClick);
  return b;
}

function drawProgress(it) {
  const bar = bubble.querySelector('.d-bar');
  if (!bar) return;
  const p = it.progress;
  bar.classList.toggle('wait', typeof p !== 'number');
  bar.querySelector('i').style.width = typeof p === 'number' ? `${Math.round(clamp(p, 0, 1) * 100)}%` : '';
  bubble.querySelector('.d-barlbl b').textContent = typeof p === 'number' ? `${Math.floor(clamp(p, 0, 1) * 100)}%` : '';
}

function updateDialog(m) {
  const it = item?.kind === 'dialog' && item.id === m.id ? item : queue.find((q) => q.kind === 'dialog' && q.id === m.id);
  if (!it) return;
  if ('progress' in m) it.progress = m.progress;
  if (typeof m.text === 'string') {
    it.d = { ...it.d, text: m.text };
    if (it === item) { it.text = m.text; it.shown = 0; it.acc = 0; }
  }
  if (it === item) drawProgress(it);
}

function endDialog(id) {
  const i = queue.findIndex((q) => q.kind === 'dialog' && q.id === id);
  if (i >= 0) queue.splice(i, 1);
  if (item?.kind === 'dialog' && item.id === id) closeBubble();
}

function settleDialog(it, answer) {
  if (item !== it || it.answered) return;
  it.answered = true;
  send({ t: 'dialog', id: it.id, ...answer });
  takeOff('index' in answer);
  if (answer.done) { closeBubble(); return; }
  sfx.select();
  bubble.querySelectorAll('button, input').forEach((n) => { n.disabled = true; });
  if ('index' in answer) bubble.querySelectorAll('.d-pill')[answer.index]?.classList.add('chosen');
  // the chosen button shows a moment; the app's next step waits in the queue meanwhile
  setTimeout(() => { if (item === it) closeBubble(); }, 260);
}

/** Coo shows the picked card's motion near the pinned bubble: standing still, strolling, or running about. */
function stepTalkMotion() {
  const it = item;
  if (it?.kind !== 'dialog') return;
  holdRoam(20);
  const l = at();
  if (!talk.motion || it.pinX === undefined || !l || l.busy || T < talk.next || l.mode !== 'idle') return;
  const home = it.pinX, R = Math.min(TALK_RANGE, innerWidth * .25);
  if (talk.motion === 'still') {
    if (Math.abs(l.x - home) > 30) system.actions.local({ kind: 'walk', x: home, run: false });
    talk.next = T + 1;
    return;
  }
  const run = talk.motion === 'run';
  if (run && Math.random() < .3 && words.has('hop')) { system.actions.local({ kind: 'word', word: 'hop' }); talk.next = T + .5; return; }
  // to the other side of the bubble each time, so every move is plain to see
  const x = l.x < home ? home + R * (.4 + Math.random() * .6) : home - R * (.4 + Math.random() * .6);
  system.actions.local({ kind: 'walk', x: clamp(x, 40, innerWidth - 40), run });
  talk.next = T + (run ? .1 : 1.2 + Math.random() * 1.2);
}

/* ---------- typed input: the hover button, or double-click when switched on ---------- */
/**
 * Pictures pasted into the box are fitted as the chat page fits them (console/base/ui/images.ts): only ever
 * shrunk, the long edge to IMAGE_EDGE; one still past IMAGE_BYTES is encoded again as JPEG. The box holds
 * BOX_IMAGES, one row of thumbnails; the chat page takes more.
 */
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const IMAGE_EDGE = 2048, IMAGE_BYTES = 6 * 1024 * 1024, BOX_IMAGES = 4;

/** One pasted picture as `{ name, mime, base64, bytes, width, height }`; a picture that cannot be used rejects with the note to show. */
async function fitImage(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error(t('bubble.imageUnreadable')); }
  try {
    const name = file.name || 'image';
    const scale = Math.min(1, IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    if (scale === 1 && file.size <= IMAGE_BYTES) return { name, mime: file.type, base64: await base64Of(file), bytes: file.size, width, height };
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const encode = (mime, quality) => new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
    // canvas has no GIF encoder
    let mime = file.type === 'image/gif' ? 'image/png' : file.type;
    let blob = await encode(mime);
    if (blob && blob.size > IMAGE_BYTES && mime !== 'image/jpeg') { mime = 'image/jpeg'; blob = await encode(mime, .85); }
    if (!blob) throw new Error(t('bubble.imageUnreadable'));
    if (blob.size > IMAGE_BYTES) throw new Error(t('bubble.imageTooLarge', { mb: IMAGE_BYTES / 1048576 }));
    return { name, mime, base64: await base64Of(blob), bytes: blob.size, width, height };
  } finally {
    bitmap.close();
  }
}
function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t('bubble.imageUnreadable')));
    reader.onload = () => { const url = String(reader.result); resolve(url.slice(url.indexOf(',') + 1)); };
    reader.readAsDataURL(blob);
  });
}

function openInput() {
  closeMenu();
  if (system.mode === 'phone') { host?.focus?.(); phoneChat.focusInput(); return; }
  if (system.mode !== 'desktop') {
    if (item?.kind === 'input') { host?.focus?.(); bubble.querySelector('textarea')?.focus(); }
    else landscapeChat.open();
    return;
  }
  if (item?.kind === 'input') { host?.focus?.(); bubble.querySelector('textarea')?.focus(); return; }
  if (item && item.kind === 'ask' && !item.answered) return;
  if (item) closeBubble();
  const it = item = { kind: 'input', images: [], pending: 0, pasted: 0 };
  const expand = prefs.bot?.buttons?.chat
    ? `<button class="b-expand" type="button" aria-label="${esc(t('bubble.expand'))}" title="${esc(t('bubble.expand'))}">${ICONS.expand}</button>`
    : '';
  openBubble('ask', `<button class="b-close" type="button" aria-label="${esc(t('bubble.close'))}">×</button><div class="b-imgs" hidden></div><form class="b-own"><textarea rows="1" maxlength="500" autocomplete="off" placeholder="${esc(t('bubble.typePlaceholder'))}" aria-label="${esc(t('bubble.typeLabel'))}"></textarea>${expand}<button type="submit">${esc(t('bubble.send'))}</button></form><span class="b-hint b-note" hidden></span>`);
  const form = bubble.querySelector('form'), input = form.querySelector('textarea');
  const tray = bubble.querySelector('.b-imgs'), note = bubble.querySelector('.b-note');
  const say = (text) => { note.textContent = text || ''; note.hidden = !text; };
  const draw = () => {
    tray.hidden = !it.images.length;
    tray.replaceChildren(...it.images.map((img) => {
      const cell = document.createElement('span');
      cell.className = 'b-img';
      cell.innerHTML = `<img alt="" src="data:${esc(img.mime)};base64,${img.base64}"><button type="button" aria-label="${esc(t('bubble.removeImage'))}" title="${esc(t('bubble.removeImage'))}">×</button>`;
      cell.querySelector('button').addEventListener('click', () => { it.images.splice(it.images.indexOf(img), 1); say(''); draw(); input.focus(); });
      return cell;
    }));
  };
  // Enter sends, Shift+Enter starts a new line; Enter that confirms an input method's text does neither
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  // a paste that carries pictures adds them and leaves the text as it was, as the chat page does
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => IMAGE_MIMES.includes(f.type));
    if (!files.length) return;
    e.preventDefault();
    if (it.images.length + it.pending + files.length > BOX_IMAGES) { say(t('bubble.tooManyImages', { max: BOX_IMAGES })); return; }
    say(prefs.bot?.imagesSeen === false ? t('bubble.imagesUnseen', { bot: prefs.bot.name || 'Coo' }) : '');
    for (const file of files) {
      // the order is the paste's, though a big picture takes longer to fit
      const order = ++it.pasted;
      it.pending++;
      fitImage(file).then((img) => {
        if (item !== it) return;
        it.images.push({ ...img, order });
        it.images.sort((a, b) => a.order - b.order);
        draw();
      }, (err) => {
        if (item === it) say(err.message);
      }).finally(() => { it.pending--; });
    }
  });
  bubble.querySelector('.b-close').addEventListener('click', () => closeBubble());
  // the chat page takes longer text and more images; the draft goes with it
  bubble.querySelector('.b-expand')?.addEventListener('click', () => {
    send({ t: 'expand', text: input.value, images: it.images });
    closeBubble();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (it.pending || (!v && !it.images.length)) return;
    if (!send({ t: 'text', text: v, ...(it.images.length ? { images: it.images.map(({ mime, base64, name }) => ({ mime, base64, name })) } : {}) })) {
      say(desktopLabel('连接已断开，输入已保留。','Disconnected. The draft is kept.'));
      return;
    }
    sfx.select(); system.body?.cue('cheer');
    closeBubble();
    if (prefs.saidBubbles) addLine('type', v, false, { images: it.images.length });
  });
  host?.focus?.();
  setTimeout(() => input.focus(), 30);
}

/* ---------- listening ---------- */
/** `line` is the episode's bubble in the stack (see below) while it is heard; `text` is settled, `interim` still being heard. */
const listen = { phase: null, line: null, text: '', interim: '' };
function onListen(m) {
  // the quick tap before a talk key is held: Coo perks up, and the hold that follows starts listening
  if (m.phase === 'ready') {
    if (listen.phase) return;
    sfx.tick();
    system.body?.cue('perk');
    return;
  }
  if (m.phase === 'start') {
    if (!listen.phase) sfx.listenStart();
    listen.phase = 'hearing';
    setBody({ listening: true });
    showHeard();
  } else if (m.phase === 'transcribing') {
    listen.phase = listen.phase || 'hearing';
    showHeard();
  } else if (m.phase === 'partial') {
    listen.text = m.text || '';
    listen.interim = m.interim || '';
    showHeard();
  } else if (m.phase === 'heard') {
    const line = listen.line ?? addLine('voice', '', true);
    endListen();
    settleLine(line, m.text || '');
    if (phoneChat.log.contains(line.el)) dropLine(line);
    if (!prefs.saidBubbles) fadeLine(line);
    sfx.listenEnd();
    system.body?.cue('heard');
  } else if (m.phase === 'none') {
    if (listen.line) dropLine(listen.line);
    endListen();
  }
}
function endListen() {
  listen.phase = null; listen.line = null; listen.text = ''; listen.interim = '';
  setBody({ listening: false });
}
/**
 * Draws what is being heard into the episode's bubble, the newest of the stack. `interim`, greyed, may still change.
 * The bubble is built once and then only updated, so a click on its cancel button is not lost to a redraw.
 */
function showHeard() {
  listen.line ??= addLine('voice', '', true);
  const el = listen.line.el, { text, interim } = listen;
  // the World drops what this bubble shows and closes it; with the talk key off (always) there is no capture to cancel
  el.querySelector('.b-cancel').hidden = false;
  el.querySelector('.fin').textContent = text;
  // a space only before Latin text that follows Latin text or ASCII punctuation; Chinese sentences run on
  el.querySelector('.interim').textContent = text && interim && /[A-Za-z0-9.,!?;:]$/.test(text) && /^[A-Za-z0-9]/.test(interim) ? ' ' + interim : interim;
  el.querySelector('.b-hint').textContent = t(text || interim ? 'heard.more' : 'heard.listening');
}

/*
 * ---------- what the person said: typed in the box, heard, or sent from the chat page ----------
 * Each line stays above Coo as a bubble of the heard kind (grey, no tail), the newest at the bottom. A line is
 * answered by the first speech or question Coo starts after it settled; until that reply's bubble has closed (and,
 * for a line not answered yet, while Coo works or has speech queued) the line and those before it stay, and they
 * fade REPLIED_FADE seconds after it closes. A line Coo does not answer fades UNANSWERED_FADE seconds after it was
 * said. The stack holds at most MAX_LINES bubbles and MAX_ROWS rows of text: past either the oldest fades, answered
 * or not, and the newest always stays. A click fades a settled line at once; one still being heard has its cancel button.
 */
const REPLIED_FADE = 1, UNANSWERED_FADE = 8;
const MAX_LINES = 3, MAX_ROWS = 6;
/** Seconds a line takes to fade out (pet.css `.bubble.said`). */
const LINE_FADE = .4;
/** A settled line's mark, the icon of the way it came: the voice button's microphone, the chat page's arrows; typed in the box, none. */
const MARKS = { voice: ICONS.mic, chat: ICONS.expand };
/**
 * `src`: 'type' | 'voice' | 'chat'; `live` while being heard; `settledAt` on the page clock; `reply`, the item that
 * answers it; `fadeAt` once it fades; `ox`, `oy`, its eased offset from Coo's head; `images` and `cursor`, a chat line's.
 */
const lines = [];

function addLine(src, text, live = false, extra = {}) {
  const el = document.createElement('div');
  el.className = 'bubble heard said pop';
  el.setAttribute('role', 'status');
  document.body.append(el);
  const line = { el, src, text, live, settledAt: live ? null : T, reply: null, fadeAt: null, ox: null, oy: null, images: 0, cursor: null, ...extra };
  el.addEventListener('click', () => { if (!line.live && line.fadeAt === null) { sfx.tick(); fadeLine(line); } });
  if (live) {
    el.innerHTML = '<p class="b-text"><span class="fin"></span><span class="interim"></span><span class="caret" aria-hidden="true"></span></p><div class="b-foot"><span class="b-hint"></span><button class="b-cancel" type="button"></button></div>';
    el.querySelector('.b-cancel').textContent = t('heard.cancel');
    el.querySelector('.b-cancel').addEventListener('click', () => { sfx.tick(); send({ t: 'cancel' }); });
  } else drawLine(line);
  lines.push(line);
  return line;
}
function drawLine(line) {
  const mark = MARKS[line.src] ? `<span class="said-mark" aria-hidden="true">${MARKS[line.src]}</span>` : '';
  const images = line.images ? `<span class="b-hint">${line.text ? '' : mark}${esc(t('said.images', { count: line.images }))}</span>` : '';
  line.el.innerHTML = (line.text || !line.images ? `<p class="b-text">${mark}${esc(line.text)}</p>` : '') + images;
  line.el.classList.add('settled');
  line.el.title = t('bubble.close');
}
function settleLine(line, text) {
  line.live = false; line.text = text; line.settledAt = T;
  drawLine(line);
}
function fadeLine(line) {
  if (line.fadeAt !== null) return;
  line.fadeAt = T;
  line.el.classList.add('fading');
}
function dropLine(line) {
  line.el.remove();
  lines.splice(lines.indexOf(line), 1);
}
/** A chat-page message the person took back before delivery: its line goes. */
function withdrawLine(cursor) {
  const line = lines.find((l) => l.cursor === cursor);
  if (line) fadeLine(line);
}
/** Coo starts speaking or asking (`it`): the settled lines not answered yet are answered by it. */
function answerLines(it) {
  for (const line of lines) if (!line.live && !line.reply) line.reply = it;
}
/** Rows of text a line shows: its text (pet.css clamps it at MAX_ROWS), plus the image line. */
function rowsOf(line) {
  const p = line.el.querySelector('.b-text');
  const hint = line.images ? 1 : 0;
  if (!p) return Math.max(1, hint);
  const lh = parseFloat(getComputedStyle(p).lineHeight) || 20;
  return Math.max(1, Math.round(p.getBoundingClientRect().height / lh)) + hint;
}
function stepLines() {
  // Coo is still on it: working, or with speech queued
  const busy = !!status.wanted || queue.some((q) => q.kind === 'say' || q.kind === 'ask');
  let held = -1, answered = -1;
  lines.forEach((line, i) => {
    if (line.live) return;
    const r = line.reply;
    if (r ? r.endedAt === undefined : busy) held = i;
    else if (r && T >= r.endedAt + REPLIED_FADE) answered = i;
  });
  lines.forEach((line, i) => {
    if (line.fadeAt !== null || line.live || i <= held) return;
    if (i <= answered || (!line.reply && T >= line.settledAt + UNANSWERED_FADE)) fadeLine(line);
  });
  const up = lines.filter((l) => l.fadeAt === null);
  let rows = up.reduce((n, l) => n + rowsOf(l), 0);
  while (up.length > 1 && (up.length > MAX_LINES || rows > MAX_ROWS)) {
    const line = up.shift();
    rows -= rowsOf(line);
    fadeLine(line);
  }
  for (const line of [...lines]) if (line.fadeAt !== null && T - line.fadeAt >= LINE_FADE) dropLine(line);
}

/* ---------- activity: the same bubble, with conversation always taking priority ---------- */
const status = { wanted: null, since: 0, shown: null, shownAt: 0, fadeAt: null };
function setStatus(next) {
  setBody({ thinking: next?.kind === 'think', status: next?.kind ?? null });
  const prev = status.wanted;
  if (prev?.kind === next?.kind && prev?.text === next?.text && prev?.detail === next?.detail && prev?.count === next?.count) return;
  if (prev?.kind !== next?.kind) status.since = T;
  status.wanted = next;
}
function drawStatus(next, pop) {
  const icon = next.kind;
  if (!bubble.classList.contains('status') || bubble.dataset.icon !== icon) {
    bubble.className = 'bubble status';
    bubble.dataset.icon = icon;
    bubble.innerHTML = `<span class="status-icon">${ICONS[`status_${icon}`] || ICONS.status_work}</span><span class="status-text"></span>`;
  }
  bubble.dataset.kind = next.kind;
  const label = next.text + (next.detail ? ` · ${next.detail}` : '') + (next.count > 1 ? t('status.more', { others: next.count - 1 }) : '');
  bubble.querySelector('.status-text').textContent = label;
  bubble.setAttribute('aria-label', next.kind === 'think' ? t('status.thinking') : label);
  bubble.classList.remove('fading');
  bubble.hidden = false;
  if (pop) { bubble.classList.remove('pop'); void bubble.offsetWidth; bubble.classList.add('pop'); }
}
function stepStatus() {
  // Never replace dialogue with activity, including while a queued line waits for the body.
  if (!prefs.statusBubble || listen.phase || item || queue.length) {
    if (bubble.classList.contains('status')) bubble.hidden = true;
    status.shown = null; status.fadeAt = null;
    return;
  }
  if (status.fadeAt !== null && T - status.fadeAt >= .2) {
    bubble.hidden = true;
    status.shown = null; status.fadeAt = null;
  }
  const next = status.wanted, shown = status.shown;
  if (next?.kind === 'think' && T - status.since < .6) return;
  if (shown && next && shown.kind === next.kind && shown.text === next.text) {
    if (shown !== next || status.fadeAt !== null) drawStatus(next, false);
    status.shown = next; status.fadeAt = null;
  } else if (!shown || T - status.shownAt >= 1.2) {
    if (next) {
      drawStatus(next, shown?.kind !== next.kind);
      status.shown = next; status.shownAt = T; status.fadeAt = null;
    } else if (shown && status.fadeAt === null) {
      status.fadeAt = T;
      bubble.classList.add('fading');
    }
  }
}

/* ---------- microphone: open while `prefs.mic`, which the World turns on and off with a held talk key in hold mode ---------- */
const { start: startMic, stop: stopMic } = createMic({ prefs, send, sendAudio: (data) => { if (ws && ws.readyState === 1) ws.send(data); } });

/* ---------- actions: the menu's lower zone and the hover buttons draw from one list ---------- */
const ROAM_ORDER = ['off', 'calm', 'free'];
const roamName = (id) => (ROAM_ORDER.includes(id) ? t(`roam.${id}`) : '');

/**
 * Every button the menu and the hover buttons can show, in the menu's order. `icon`, `state` and
 * `on` read the current prefs: `state` is the line that says what the button does and where it
 * stands, `on` lights a switch that is on (undefined for plain actions). `keep` leaves the menu
 * open after a click, so a switch shows its new state there.
 */
const desktopLabel = (zh, en) => language().startsWith('zh') ? zh : en;
const controlDesktop = action => send({ t: 'control', action });
const ON_OFF = (on) => desktopLabel(on ? '开启' : '关闭', on ? 'On' : 'Off');
const openQuickPage = (id, page) => openMenu(tools.querySelector('[data-action="' + id + '"]'), page);
const ACTIONS = {
  scenes: { icon: () => desktopScenes[system.mode].icon, available: () => !!host, state: () => desktopLabel('切换场景', 'Switch scenes'), run: () => openQuickPage('scenes', 'scenes') },
  size: { icon: () => ICONS.scale, state: () => desktopLabel('角色大小', 'Character size'), run: () => openQuickPage('size', 'size') },
  actions: { icon: () => ICONS.play, state: () => desktopLabel('动作与表情', 'Actions & expressions'), run: () => openQuickPage('actions', 'actions') },
  interaction: { icon: () => ICONS.cursor, available: () => !!host, state: () => desktopLabel('互动设置', 'Interaction settings'), run: () => openQuickPage('interaction', 'interaction') },
  workbench: { icon: () => ICONS.settings, available: () => !!prefs.bot?.buttons?.settings, state: () => desktopLabel('打开工作台', 'Open workbench'), run: () => controlDesktop('settings') },
  hoverVisibility: { icon: () => ICONS.eye, available: () => !!host, state: () => desktopLabel('显示靠近按钮', 'Show hover buttons'), run: () => openQuickPage('hoverVisibility', 'interaction') },
  close: { icon: () => ICONS.power, available: () => !!host, state: () => desktopLabel('关闭 Live2D', 'Close Live2D'), run: () => openQuickPage('close', 'close') },
  through: { icon: () => ICONS.cursor, available: () => !!host, state: () => desktopLabel('鼠标穿透', 'Click-through'), run: () => openQuickPage('through', 'through') },
  menu: {
    icon: () => ICONS.apps, available: () => !!host,
    state: () => desktopLabel('打开操作台', 'Open controls'), run: () => openMenu(tools.querySelector('[data-action=menu]')),
  },
  desktopThrough: {
    icon: () => ICONS.cursor, available: () => !!host,
    state: () => desktopLabel('启用鼠标穿透', 'Enable click-through'), run: () => controlDesktop('desktop-through'),
  },
  desktopClose: {
    icon: () => ICONS.power, available: () => !!host,
    state: () => desktopLabel('关闭 Live2D 桌宠', 'Close Live2D Desktop Pet'), run: () => controlDesktop('desktop-close'),
  },
  chat: {
    icon: () => ICONS.chat,
    state: () => t(prefs.doubleClickChat ? 'action.chatDoubleClick' : 'action.chat'),
    run: () => openInput(),
  },
  voice: {
    keep: true,
    icon: () => (prefs.voice.enabled ? ICONS.mic : ICONS.micOff),
    value: () => !prefs.voice.enabled ? ON_OFF(false) : prefs.voice.ready ? desktopLabel('就绪', 'Ready') : desktopLabel('待就绪', 'Waiting'),
    on: () => prefs.voice.enabled,
    state: () => (!prefs.voice.enabled ? desktopLabel('请在声音设置中启用语音输入', 'Enable voice input in Sound settings')
      : !prefs.voice.ready ? t('action.voiceNotReady', { detail: prefs.voice.detail || t('action.voiceNoService') })
      : desktopLabel('按住说话，松开发送', 'Hold to talk, release to send')),
    run: () => controlDesktop('desktop-voice-settings'),
  },
  roam: {
    keep: true,
    icon: () => ICONS[`roam_${prefs.roam}`] ?? ICONS.roam_calm,
    value: () => roamName(prefs.roam),
    state: () => {
      const next = ROAM_ORDER[(ROAM_ORDER.indexOf(prefs.roam) + 1) % ROAM_ORDER.length];
      return t('action.roam', { name: roamName(prefs.roam), next: roamName(next) });
    },
    run: () => cycleRoam(),
  },
  theme: {
    keep: true,
    icon: () => (prefs.theme === 'dark' ? ICONS.moon : ICONS.sun),
    on: () => prefs.theme === 'dark',
    value: () => desktopLabel(prefs.theme === 'dark' ? '深色' : '浅色', prefs.theme === 'dark' ? 'Dark' : 'Light'),
    state: () => t(prefs.theme === 'dark' ? 'action.themeDark' : 'action.themeLight'),
    run: () => toggleTheme(),
  },
  sound: {
    keep: true,
    icon: () => (prefs.sound ? ICONS.sound : ICONS.soundOff),
    on: () => prefs.sound,
    state: () => t(prefs.sound ? 'action.soundOn' : 'action.soundOff'),
    run: () => send({ t: 'prefs', sound: !prefs.sound }),
  },
  hide: {
    icon: () => ICONS.eyeOff, available: () => !!host?.hide,
    state: () => t('action.hide'),
    run: () => host.hide(),
  },
  dress: {
    icon: () => ICONS.shirt,
    state: () => t('action.dress'),
    run: () => {
      if (host) { openMenu(tools.querySelector('[data-action=dress]'), 'wardrobe'); return; }
      if (prefs.bot?.buttons?.dress) send({ t: 'control', action: 'dress' });
      else if (!host) window.open('/workspace-entry.html?task=appearance', '_blank');
    },
  },
  worlds: {
    // only where the embedding app has a World list to show
    available: () => !!prefs.bot?.buttons?.worlds,
    icon: () => ICONS.boxes,
    state: () => t('action.worlds'),
    run: () => send({ t: 'control', action: 'worlds' }),
  },
};
const available = (id) => ACTIONS[id] && (ACTIONS[id].available?.() ?? true);

/** One action as a button: its icon, the badge, and whether a switch is on. */
function drawAction(b, id) {
  const a = ACTIONS[id], on = a.on?.();
  const badge = a.badge?.() ?? '';
  const image = b.querySelector('.ic');
  const icon = a.icon();
  if (image.dataset.icon !== icon || image.dataset.badge !== badge) {
    image.dataset.icon = icon;
    image.dataset.badge = badge;
    image.innerHTML = icon;
    if (badge && !b.classList.contains('m-action')) {
      const key = document.createElement('b');
      key.className = 'badge';
      key.textContent = badge;
      image.append(key);
    }
  }
  b.classList.toggle('on', on === true);
  b.classList.toggle('off', on === false);
  if (id === 'voice') b.classList.toggle('waiting', prefs.voice.enabled && !prefs.voice.ready);
  const description = a.state();
  const role = b.getAttribute('role');
  const isSwitch = role === 'switch';
  const label = isSwitch ? b.querySelector('.control-phone-label').textContent : description;
  if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
  b.dataset.description = description;
  if (on !== undefined) b.setAttribute(isSwitch || role === 'menuitemcheckbox' ? 'aria-checked' : 'aria-pressed', String(on));
  if (isSwitch) return;
  const value = a.value?.() ?? (on === undefined ? '' : ON_OFF(on));
  const state = b.querySelector('.m-state');
  if (state) state.textContent = value;
  else if (value && b.classList.contains('m-action')) {
    const indicator = document.createElement('small');
    indicator.className = 'm-state';
    indicator.textContent = value;
    b.append(indicator);
  }
}

function cycleRoam() {
  const roam = ROAM_ORDER[(ROAM_ORDER.indexOf(prefs.roam) + 1) % ROAM_ORDER.length];
  applyPrefs({ roam });
  send({ t: 'prefs', roam });
}

function toggleTheme() {
  const theme = prefs.theme === 'dark' ? 'light' : 'dark';
  applyPrefs({ theme });
  send({ t: 'prefs', theme });
}

/* ---------- Desktop Live2D Pet menu ---------- */
const desktopScenes = {
  desktop: {label:['桌面', 'Desktop'], icon:ICONS.desktop},
  room: {label:['小屋', 'Room'], icon:ICONS.room},
  phone: {label:['竖屏', 'Portrait'], icon:ICONS.phone},
  wallpaper: {label:['壁纸', 'Wallpaper'], icon:ICONS.wallpaper},
};
let sceneRequest = null;
let sceneExitMessage = '';
let menuTrigger = null;
let menuMessage = null;
let desktopModeRequestTimer = 0;
const phoneRequests = new Map();
const phoneUnavailable = () => desktopLabel('桌宠连接已断开，请重试。', 'The pet is disconnected. Try again.');

function phoneCommand(command, figure, value) {
  const request = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    if (!send({ t: 'phone-control', request, command, figure, value })) { reject(Error(phoneUnavailable())); return; }
    const timeout = setTimeout(() => {
      phoneRequests.delete(request);
      reject(Error(desktopLabel('桌宠未及时返回结果，请重试。', 'The pet did not respond. Try again.')));
    }, 5000);
    phoneRequests.set(request, { resolve, reject, timeout });
  });
}
function settlePhoneControl(message) {
  const pending = phoneRequests.get(message.request);
  if (!pending) return;
  phoneRequests.delete(message.request);
  clearTimeout(pending.timeout);
  if (message.ok) pending.resolve(message.result);
  else pending.reject(Error(message.reason));
}
function rejectPhoneControls() {
  for (const { timeout, reject } of phoneRequests.values()) {
    clearTimeout(timeout);
    reject(Error(phoneUnavailable()));
  }
  phoneRequests.clear();
}

const controlPhone = createControlPhone({
  root: menu, text: desktopLabel, command: phoneCommand, scenes: desktopScenes,
  helpers: {
    close: () => closeMenu(true), mode: () => system.mode, selectScene: selectDesktopScene,
    openWallpapers: () => {
      if (send({t:'control',action:'desktop-wallpapers'})) closeMenu();
    },
    wallpaper: host ? {
      current: () => system.mode === 'wallpaper' ? system.presentation.snapshot().wallpaper : null,
      preview: value => system.presentation.previewPlacement?.(value),
    } : null,
    hasWindow: !!host,
    component: renderControlComponent, pauseButton: controlPauseButton,
    connect: connectAction, drawAction,
    cancelVoice: () => { if (hold.el && menu.contains(hold.el)) endHold(true); },
    size: {
      label: mode => desktopLabel(...desktopScenes[mode].label) + ' · ' + desktopLabel('角色大小', 'Character size'),
      read: mode => prefs.presentationScales?.[mode] ?? prefs.scale,
      preview: (mode, scale) => system.configuration.previewScale(mode, scale),
      async save(mode, scale) {
        const applied = await phoneCommand('model-size', undefined, {mode,scale});
        (prefs.presentationScales ??= {})[mode] = applied.scale;
        system.configuration.apply({presentationScales:prefs.presentationScales});
      },
    },
    async previewOutfit(figure, picks, current) {
      const { scheme } = await phoneCommand('preview-outfit', figure, picks);
      if (current()) await system.previewAppearance(figure, 'control-phone', scheme, skin.scheme);
    },
    restoreOutfit: async scheme => { await system.restoreAppearance('control-phone', scheme ?? skin.scheme); },
  },
});
function syncPhoneChat() {
  if (system.switching) return;
  const mode = system.mode;
  const active = mode === 'phone';
  const online = ws?.readyState === WebSocket.OPEN && !watching;
  const switching = !!(sceneRequest || presenting);
  if (active) landscapeChat.render({mode});
  phoneChat.render({
    active, area: active ? system.scene.rect() : null,
    name: shownPack?.name?.[language()] ?? shownPack?.name?.zh ?? prefs.bot?.name ?? 'Coo',
    online, controlsOpen: !menu.hidden, switching,
    speaking: active ? [item,...queue].filter(it => Number.isSafeInteger(it?.cursor)).map(it => it.cursor) : [],
  });
  if (active && listen.line && !phoneChat.log.contains(listen.line.el)) phoneChat.attachListening(listen.line.el);
  if (!active) landscapeChat.render({mode, area:mode === 'desktop' ? null : system.scene.rect(), online, switching, lines, inputOpen:item?.kind === 'input'});
}
function updateMenuStatus() {
  system.presentation.exitState?.(!!(sceneRequest || presenting), sceneExitMessage);
  if (menu.hidden) return;
  controlPhone.scene(sceneRequest, menuMessage);
  controlPhone.syncSettings(ws?.readyState === WebSocket.OPEN && !watching);
  const hover = menu.querySelector('[data-hover-switch]');
  if (hover) hover.setAttribute('aria-checked', String(prefs.hoverButtonsVisible));
  for (const toggle of menu.querySelectorAll('[data-touch-regions-switch]')) toggle.setAttribute('aria-checked', String(prefs.touchRegionsVisible));
  const pause = menu.querySelector('[data-bot-pause]');
  if (pause) pause.querySelector('.control-phone-label').textContent = prefs.bot?.paused ? desktopLabel('恢复 Coo', 'Resume Coo') : desktopLabel('暂停 Coo', 'Pause Coo');
}
function returnToDesktop() { selectDesktopScene('desktop', true); }
function selectDesktopScene(mode, exiting = false) {
  if (sceneRequest || presenting || mode === system.mode) return;
  if (ws?.readyState !== WebSocket.OPEN) {
    menuMessage = { text: phoneUnavailable(), kind: 'error' };
    if (exiting) {
      sceneExitMessage = menuMessage.text;
      if (system.mode === 'phone') phoneChat.feedback(sceneExitMessage);
    }
    updateMenuStatus();
    return;
  }
  const request = crypto.randomUUID();
  sceneRequest = {request, mode, exiting};
  sceneExitMessage = '';
  if (exiting && system.mode === 'phone') phoneChat.feedback('');
  desktopModeRequestTimer = setTimeout(() => finishDesktopScene({request, reason:'presentation-timeout'}), mode === 'wallpaper' ? 25000 : 7000);
  menuMessage = null;
  updateMenuStatus();
  syncPhoneChat();
  send({ t: 'control', action: 'desktop-presentation', request, mode });
}
function finishDesktopScene(message) {
  if (message.request !== sceneRequest?.request) return;
  const {exiting} = sceneRequest;
  if (exiting && message.ok) closeMenu();
  const label = desktopLabel(...desktopScenes[sceneRequest.mode].label);
  clearTimeout(desktopModeRequestTimer);
  sceneRequest = null;
  const reasons = {
    'wallpaper-source-unavailable': ['请先打开壁纸库，选择可用的背景。', 'Open the wallpaper library and choose a background.'],
    'wallpaper-first-frame-failed': ['壁纸未能显示首帧，当前画面已保留。', 'The wallpaper could not draw its first frame. The current view is still active.'],
    'body-busy': ['角色正在加载，请稍后重试。', 'The character is loading. Try again shortly.'],
    'presentation-timeout': ['窗口未及时确认新场景，可再次尝试。', 'The new scene timed out. Try again.'],
    'window-disconnected': ['桌宠连接已断开。', 'The pet is disconnected.'],
  };
  menuMessage = message.ok
    ? { text: desktopLabel('已切换到' + label, 'Switched to ' + label), kind: 'ok' }
    : { text: desktopLabel(...(reasons[message.reason] ?? ['场景切换失败，可以重试。', 'Could not switch views. Try again.'])), kind: 'error' };
  if (exiting && !message.ok) {
    sceneExitMessage = menuMessage.text;
    if (system.mode === 'phone') phoneChat.feedback(sceneExitMessage);
  }
  updateMenuStatus();
  syncPhoneChat();
}
function controlPauseButton(button) {
  if (!prefs.bot?.buttons?.pause || system.mode === 'phone') return null;
  const pause = button(prefs.bot.paused ? desktopLabel('恢复 Coo', 'Resume Coo') : desktopLabel('暂停 Coo', 'Pause Coo'),
    'pause', () => {
      if (controlDesktop(prefs.bot?.paused ? 'resume' : 'pause')) controlPhone.status(desktopLabel('已提交。', 'Requested.'), 'ok');
    });
  pause.dataset.botPause = '';
  return pause;
}

function renderControlComponent(id, button, switchIndicator) {
  if (!host) return null;
  switch (id) {
    case 'editTouch':
      return button(desktopLabel('编辑触碰', 'Edit touch'), 'settings', async () => {
        try {
          await phoneCommand('edit-touch');
          closeMenu();
        } catch (error) { controlPhone.status(error.message, 'error'); }
      });
    case 'hoverVisibility':
    case 'touchRegions': {
      const regions = id === 'touchRegions';
      const pref = regions ? 'touchRegionsVisible' : 'hoverButtonsVisible';
      const command = regions ? 'touch-regions' : 'hover-buttons';
      const label = regions ? desktopLabel('显示触碰判定区', 'Show touch regions') : desktopLabel('显示靠近按钮', 'Show hover buttons');
      const toggle = button(label, 'eye', async () => {
        toggle.disabled = true;
        try {
          const { visible } = await phoneCommand(command, undefined, !prefs[pref]);
          applyPrefs({ [pref]: visible });
        } catch (error) {
          if (toggle.isConnected && !menu.hidden) controlPhone.status(error.message, 'error');
        } finally { toggle.disabled = false; }
      });
      toggle.dataset[regions ? 'touchRegionsSwitch' : 'hoverSwitch'] = '';
      toggle.setAttribute('aria-checked', String(prefs[pref]));
      switchIndicator(toggle);
      return toggle;
    }
    case 'workbench':
      return available(id) ? button(desktopLabel('打开工作台', 'Open workbench'), 'settings', ACTIONS[id].run) : null;
    case 'hide':
      return available(id) ? button(desktopLabel('隐藏桌宠', 'Hide pet'), 'eyeOff', ACTIONS[id].run) : null;
    case 'close': {
      const close = button(desktopLabel('关闭 Live2D', 'Close Live2D'), 'power', ACTIONS.desktopClose.run);
      close.classList.add('control-phone-danger');
      return close;
    }
    case 'through': {
      const through = button(desktopLabel('鼠标穿透', 'Click-through'), 'cursor', () => {
        if (through.dataset.confirm === 'true') {
          if (!controlDesktop('desktop-through')) controlPhone.status(phoneUnavailable(), 'error');
          return;
        }
        through.dataset.confirm = 'true';
        through.querySelector('.control-phone-label').textContent = desktopLabel('确认启用穿透', 'Confirm click-through');
        controlPhone.status(desktopLabel('启用后可在 Coo 的运行详情里恢复鼠标操作。', 'Restore mouse input from Coo’s runtime details.'));
      });
      return through;
    }
    default: return null;
  }
}
function openMenu(trigger = null, app) {
  if (clicksPass() || !at() || system.switching) return;
  const opening = menu.hidden;
  app ??= opening ? DEFAULT_CONTROL_PAGE : menu.dataset.app;
  if (!opening && trigger && trigger === menuTrigger && app === menu.dataset.app) {
    closeMenu(true);
    return;
  }
  if (opening || trigger) {
    if (menuTrigger?.getAttribute('aria-controls') === menu.id) menuTrigger.setAttribute('aria-expanded', 'false');
    menuTrigger = trigger ?? document.activeElement;
    if (menuTrigger?.getAttribute('aria-controls') === menu.id) menuTrigger.setAttribute('aria-expanded', 'true');
  }
  if (opening) {
    menu.hidden = false;
    closeWheel();
    endHold(true);
    toolNote.hidden = tools.hidden = true;
    menuMessage = null;
    controlPhone.open(app, sceneRequest);
  } else {
    controlPhone.show(app);
  }
  updateMenuStatus();
  placeMenu(at());
  host?.focus?.();
}
function placeMenu(layout) {
  if (!layout || system.switching) return;
  const chat = system.mode === 'phone' ? system.scene.rect() : null;
  const dock = chat ? null : activeSceneComposer()?.getBoundingClientRect();
  controlPhone.place(chat ?? layout.box, { width: innerWidth, height: innerHeight }, chat, chat ? phoneChat.chromeBounds() : undefined, dock);
}
function closeMenu(restoreFocus = false) {
  if (menu.hidden) return;
  menu.hidden = true;
  controlPhone.close();
  endHold(true);
  const trigger = menuTrigger;
  menuTrigger = null;
  if (trigger?.getAttribute('aria-controls') === menu.id) trigger.setAttribute('aria-expanded', 'false');
  toolsMuted = !restoreFocus;
  toolsUntil = restoreFocus && tools.contains(trigger) ? T + TOOLS_LINGER : 0;
  if (restoreFocus && !clicksPass()) {
    if (prefs.hoverButtonsVisible && trigger && tools.contains(trigger)) tools.hidden = false;
    if (trigger?.isConnected && trigger !== document.body && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
    else if (system.mode === 'phone') phoneChat.focusControls();
  }
}
function refreshButtons() {
  updateMenuStatus();
  renderTools();
}


/* ---------- proximity controls ---------- */
/** Seconds the buttons stay after the pointer leaves both the pet and them. */
const TOOLS_LINGER = .8;
let toolsUntil = 0;
/** Set when the menu closes; cleared once the pointer is off the body and the hover buttons. */
let toolsMuted = false;
let toolIds = '';
let toolAnchor = null;
let toolNoteTarget = null, toolNoteAt = 0;
function hideToolNote() {
  toolNoteTarget = null;
  toolNote.hidden = true;
}
function refreshToolNote(bodyX) {
  const focused = tools.querySelector('.tool:focus-visible');
  const hovered = focused ?? tools.querySelector('.tool:hover');
  if (!hovered || !menu.hidden || !wheel.hidden) { hideToolNote(); return; }
  if (hovered !== toolNoteTarget) {
    toolNoteTarget = hovered;
    toolNoteAt = performance.now() + 220;
  }
  toolNote.hidden = !focused && performance.now() < toolNoteAt;
  if (toolNote.hidden) return;
  const label = desktopLabel(...CONTROL_COMPONENTS[hovered.dataset.action].label);
  const hint = hovered.dataset.description === label ? '' : hovered.dataset.description ?? '';
  if (toolNoteName.textContent !== label) toolNoteName.textContent = label;
  if (toolNoteHint.textContent !== hint) toolNoteHint.textContent = hint;
  const box = hovered.getBoundingClientRect(), rail = tools.getBoundingClientRect();
  const width = toolNote.offsetWidth, height = toolNote.offsetHeight;
  const left = rail.left - width - 8, right = rail.right + 8;
  const preferLeft = rail.left + rail.width / 2 < bodyX;
  const choices = preferLeft ? [left,right] : [right,left];
  const x = choices.find(value => value >= 8 && value + width <= innerWidth - 8) ?? choices[0];
  toolNote.style.left = Math.round(clamp(x,8,Math.max(8,innerWidth-width-8))) + 'px';
  toolNote.style.top = Math.round(clamp(box.top + (box.height - height) / 2, 8, Math.max(8, innerHeight - height - 8))) + 'px';
}
function resetDesktopControls() {
  closeMenu();
  closeWheel();
  endHold(true);
  if (tools.contains(document.activeElement)) document.activeElement.blur();
  toolsUntil = 0;
  toolsMuted = true;
  tools.hidden = true;
  hideToolNote();
  toolAnchor = null;
}

function renderTools() {
  if (!prefs.hoverButtonsVisible) {
    tools.hidden = true;
    hideToolNote();
    toolsUntil = 0;
    if (hold.el && tools.contains(hold.el)) endHold(true);
    if (tools.contains(document.activeElement)) document.activeElement.blur();
    return;
  }
  const ids = [...new Set(prefs.hoverButtons)].filter(id => available(id) && (id !== 'roam' || system.mode === 'desktop'));
  if (ids.join(',') !== toolIds) {
    toolIds = ids.join(',');
    endHold(true);
    tools.innerHTML = '';
    toolAnchor = null;
    tools.style.setProperty('--tools-count', String(Math.max(1, ids.length)));
    for (const id of ids) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tool floating-key'; b.dataset.action = id;
      b.innerHTML = '<span class="ic"></span>';
      if (['menu', 'scenes', 'size', 'actions', 'interaction', 'hoverVisibility', 'through', 'dress', 'close'].includes(id) && host) {
        b.setAttribute('aria-haspopup', 'dialog');
        b.setAttribute('aria-controls', 'menu');
        b.setAttribute('aria-expanded', 'false');
      }
      connectAction(b, id);
      tools.appendChild(b);
    }
  }
  for (const b of tools.children) drawAction(b, b.dataset.action);
}

function connectAction(button, id) {
  if (id === 'voice') { wireVoiceTool(button); return; }
  button.addEventListener('click', () => {
    sfx.tick();
    if (!ACTIONS[id].keep) toolsUntil = 0;
    ACTIONS[id].run();
    refreshButtons();
  });
}

const hold = { el: null, pointer: null };
function endHold(cancelled = false) {
  const button = hold.el;
  if (!button) return;
  const pointer = hold.pointer;
  hold.el = hold.pointer = null;
  button.classList.remove('holding');
  if (pointer !== null && button.hasPointerCapture?.(pointer)) button.releasePointerCapture(pointer);
  send(cancelled ? { t: 'cancel' } : { t: 'speak-hold', down: false });
}
function wireVoiceTool(button) {
  function begin(pointer) {
    if (!windowShown || hold.el) return;
    if (!prefs.voice.enabled) { ACTIONS.voice.run(); return; }
    if (!prefs.voice.ready || !send({ t: 'speak-hold', down: true })) {
      const message = prefs.voice.detail || phoneUnavailable();
      if (!menu.hidden) controlPhone.status(message, 'error');
      else if (system.mode === 'phone') phoneChat.feedback(message);
      else {
        const notice = { kind: 'work', text: message };
        setStatus(notice);
        setTimeout(() => { if (status.wanted === notice) setStatus(null); }, 3500);
      }
      return;
    }
    hold.el = button;
    hold.pointer = pointer;
    button.classList.add('holding');
    stopForVoiceInput();
  }
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    begin(event.pointerId);
    if (hold.el === button && hold.pointer === event.pointerId && event.isTrusted) button.setPointerCapture?.(event.pointerId);
  });
  button.addEventListener('pointerup', event => { if (hold.el === button && hold.pointer === event.pointerId) endHold(); });
  for (const type of ['lostpointercapture', 'pointercancel', 'blur']) {
    button.addEventListener(type, () => { if (hold.el === button) endHold(true); });
  }
  button.addEventListener('keydown', event => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (!event.repeat) begin(null);
  });
  button.addEventListener('keyup', event => {
    if ((event.key === ' ' || event.key === 'Enter') && hold.el === button && hold.pointer === null) endHold();
  });
}
window.addEventListener('blur', () => endHold(true));

/** Where the cursor is, in page pixels, or null when it is off the page. */
const cursor = { at: null };
const phoneChat = createPhoneChat({
  doc: document, bubble, text: desktopLabel, send,
  toggleControls: button => { if (menu.hidden) openMenu(button); else closeMenu(true); },
  closePortrait: returnToDesktop,
  connectMic: wireVoiceTool,
  syncMic(button) {
    drawAction(button, 'voice');
    if (button.title !== button.dataset.description) button.title = button.dataset.description;
  },
});
const landscapeChat = createLandscapeChat({
  doc:document,bubble,text:desktopLabel,send,connectMic:wireVoiceTool,
  syncMic:button => { drawAction(button,'voice'); if (button.title !== button.dataset.description) button.title = button.dataset.description; },
  focus:() => host?.focus?.(),
  releaseMic:form => { if (hold.el && form.contains(hold.el)) endHold(true); },
  delivered(value) { sfx.select(); if (prefs.saidBubbles) addLine('type',value); },
});
/** Pixels around the hover buttons that count as on them, as the gaps between them do. */
const TOOLS_MARGIN = 3;
function overTools(p) {
  if (tools.hidden) return false;
  const r = tools.getBoundingClientRect(), m = TOOLS_MARGIN;
  return p.x >= r.left - m && p.x <= r.right + m && p.y >= r.top - m && p.y <= r.bottom + m;
}
function stepTools() {
  // shown while the cursor is on the pet or on the buttons, and a moment after it leaves; decided
  // from where the cursor is now, not from the last move event, which may be stale
  const p = cursor.at;
  const l = at();
  const box = l?.box;
  const nearBody = p && box && p.x >= box.x - 12 && p.x <= box.x + box.w + 12
    && p.y >= box.y - 12 && p.y <= box.y + box.h + 12;
  const bar = tools.hidden ? null : tools.getBoundingClientRect();
  const near = (document.hasFocus() && !!tools.querySelector('.tool:focus-visible')) || (!!p && (nearBody || overTools(p) || inApproach(p, box, bar) || overWheel(p)));
  if (!near) toolsMuted = false;
  if (near && !toolsMuted) toolsUntil = T + TOOLS_LINGER;
  const confirming = item?.kind === 'ask' && item.confirm && !item.answered;
  tools.hidden = !(prefs.hoverButtonsVisible && system.mode !== 'phone' && !clicksPass() && windowShown && (T < toolsUntil || hold.el && tools.contains(hold.el)) && l && !frameDrag && !pressing && !l.pressing && !l.busy && menu.hidden && !confirming && toolIds !== '');
  if (tools.hidden) {
    if (hold.el && tools.contains(hold.el)) endHold(true);
    toolAnchor = null;
    hideToolNote();
  }
  else if (nearBody || p && (overTools(p) || inApproach(p, box, bar))) holdRoam(.3);
  for (const mic of [tools.querySelector('[data-action=voice]'), menu.querySelector('[data-action=voice]')]) {
    mic?.classList.toggle('live', listen.phase === 'hearing');
  }
}

/* ---------- look wheel: hovering a dress button shows the looks in a row over the body, the one worn in the middle ---------- */
/** Seconds the wheel stays after the pointer leaves it and every dress button. */
const WHEEL_LINGER = .5;
/** Pixels between two looks in the row, and how many show on each side of the middle one. */
const WHEEL_STEP = 54, WHEEL_SIDE = 3;
/** Opacity of a look by its distance from the middle. */
const WHEEL_FADE = [1, .55, .3, .12];
/** Wheel delta that turns the row one look (a mouse notch is about 100; a touchpad sends many small ones). */
const WHEEL_NOTCH = 40;
const wheelState = { items: [], at: 0, until: 0, acc: 0, request: null };

/**
 * The favourite looks to switch between (looks.js), leaving out those whose pack was uninstalled; none, none shown.
 * A look worn that is not among them leads the row, so turning the row away from it can turn back to it.
 */
async function wheelItems() {
  const [saved, figures] = await Promise.all([fetchLooks(), fetch('/api/models').then((r) => r.json()).catch(() => null)]);
  const list = Array.isArray(figures) ? figures : [];
  const items = saved.filter((l) => lookAvailable(l.skin, list))
    .map((l) => ({ skin: l.skin, on: sameLook(l.skin, skin), html: lookPicture(l.skin, list) }));
  if (!items.length) return [];
  if (!items.some((i) => i.on)) items.unshift({ skin, on: true, worn: true, html: lookPicture(skin, list) });
  return items;
}

async function openWheel() {
  if (!wheel.hidden || wheelState.request) return;
  const request = wheelState.request = {};
  const items = await wheelItems().catch(() => []);
  if (wheelState.request !== request) return;
  wheelState.request = null;
  if (!items.length || !menu.hidden || tools.hidden || clicksPass()) return;
  wheelState.items = items;
  wheelState.at = Math.max(0, items.findIndex((i) => i.on));
  wheelState.acc = 0;
  wheel.innerHTML = '';
  items.forEach((item, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = item.worn ? 'w-item worn' : 'w-item';
    b.innerHTML = item.html;
    b.setAttribute('aria-label', item.on ? desktopLabel('当前装扮', 'Current outfit') : desktopLabel('穿上装扮', 'Wear outfit'));
    b.addEventListener('click', () => spinTo(i, true));
    wheel.appendChild(b);
  });
  wheel.style.width = (2 * WHEEL_SIDE + 1) * WHEEL_STEP + 'px';
  wheel.hidden = false;
  drawWheel();
  const l = at();
  if (l) placeWheel(l);
}

function closeWheel() {
  wheelState.request = null;
  wheel.hidden = true;
}

function drawWheel() {
  [...wheel.children].forEach((b, i) => {
    const d = i - wheelState.at, n = Math.abs(d);
    b.style.transform = `translate(-50%, -50%) translateX(${d * WHEEL_STEP}px) scale(${Math.max(.6, 1 - .14 * n)})`;
    b.style.opacity = String(WHEEL_FADE[n] ?? 0);
    b.style.zIndex = String(10 - n);
    b.style.pointerEvents = n > WHEEL_SIDE ? 'none' : '';
    b.classList.toggle('on', wheelState.items[i].on);
    b.classList.toggle('focused-look', d === 0);
    b.tabIndex = n > WHEEL_SIDE ? -1 : 0;
  });
}

/** Puts on the look in the middle of the row, unless Coo wears it already. */
function wearWheel() {
  const item = wheelState.items[wheelState.at];
  if (!item || sameLook(item.skin, skin)) return;
  void fetch('/api/skin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skin: item.skin }) }).catch(() => {});
}

/** Scrolling browses the presets. Clicking applies the chosen look. */
function spinTo(i, now = false) {
  const n = clamp(i, 0, wheelState.items.length - 1);
  if (n === wheelState.at && !now) return;
  if (n !== wheelState.at) { wheelState.at = n; drawWheel(); }
  sfx.tick();
  if (now) wearWheel();
}

/** Centred over the body, just above its head. */
function placeWheel(l) {
  const b = l.box, w = wheel.offsetWidth, h = wheel.offsetHeight;
  wheel.style.left = f(clamp(b.x + b.w / 2 - w / 2, 8, innerWidth - w - 8)) + 'px';
  wheel.style.top = f(clamp(b.y - h - 22, 8, innerHeight - h - 8)) + 'px';
}

const inRect = (p, r, m = 0) => p.x >= r.left - m && p.x <= r.right + m && p.y >= r.top - m && p.y <= r.bottom + m;
function overWheel(p) { return !wheel.hidden && inRect(p, wheel.getBoundingClientRect(), 6); }
/** A dress button on screen, in the menu or among the hover buttons, is under the pointer. */
function overDress(p) {
  for (const b of tools.querySelectorAll('[data-action="dress"]')) {
    if (b.offsetParent && inRect(p, b.getBoundingClientRect(), 4)) return true;
  }
  return false;
}
function stepWheel() {
  // a bubble over the pet (the typing box, a reply, a question) takes the wheel's place until it closes
  if (!menu.hidden || tools.hidden || (!bubble.hidden && !bubble.classList.contains('status'))) { closeWheel(); return; }
  const p = cursor.at;
  const dress = !!p && overDress(p);
  if (dress || (p && overWheel(p))) wheelState.until = T + WHEEL_LINGER;
  if (dress && wheel.hidden && !clicksPass()) void openWheel();
  if (!wheel.hidden && T > wheelState.until) closeWheel();
}
// the mouse wheel turns the row while it shows, over the row or over a dress button
document.addEventListener('wheel', (e) => {
  if (wheel.hidden || !e.target.closest?.('.wheel, [data-action="dress"]')) return;
  e.preventDefault();
  wheelState.acc += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (Math.abs(wheelState.acc) < WHEEL_NOTCH) return;
  spinTo(wheelState.at + Math.sign(wheelState.acc));
  wheelState.acc = 0;
  wheelState.until = T + WHEEL_LINGER;
}, { passive: false });

/* ---------- pointer ---------- */
let pointerSeen = false;
const lastPointer = { x: 0, y: 0 };
/** Whether the page is on screen and drawing; the mouse is not taken while it is not. */
const FRAME_STALL_MS = 1000;
let lastFrameAt = performance.now();
const rendering = () => windowShown && document.visibilityState === 'visible' && performance.now() - lastFrameAt < FRAME_STALL_MS;
/** How often the wish for the mouse is renewed; the window process's lease is longer. */
const MOUSE_RENEW_MS = 500;
let interactive = null, renewedAt = -Infinity;
/**
 * `by`: which check decided, 'move' (the page's pointermove) or 'poll' (the window's cursor report).
 * `on` is a wish renewed as a lease; see host/mouse-lease.cjs.
 */
function setInteractive(on, by) {
  if (!host) return;
  const now = performance.now();
  const changed = interactive !== on;
  if (!changed && !(on && now - renewedAt >= MOUSE_RENEW_MS)) return;
  interactive = on;
  renewedAt = now;
  host.setInteractive(on);
  if (changed) logPointer('flip', by);
}

/**
 * Pointer diagnostics, one console line `[pointer] {json}` that reaches the run log: each time the
 * window switches between taking the mouse and passing it through, with what both checks last saw
 * (position, hit on the body or the UI, how long ago, and the pointerType of the move), and each
 * time the pointerType of the moves changes.
 */
const diag = { move: null, poll: null, type: '', types: new Set(), skipped: 0, lastAt: -Infinity, timer: 0, held: null };
/**
 * Fewest milliseconds between two lines; the lines in between are counted into the next one, and
 * the last of them is written once the gap has passed. A flickering pointer flips the window at
 * the cursor report rate (up to 66 a second) or faster; one line a second still names the check that
 * flipped it, and an hour of flicker stays under 3600 lines.
 */
const POINTER_LOG_EVERY_MS = 1000;
function logPointer(event, by) {
  const now = performance.now(), wait = POINTER_LOG_EVERY_MS - (now - diag.lastAt);
  diag.held = { event, by };
  if (wait <= 0) { writePointer(now); return; }
  diag.skipped++;
  diag.timer ||= setTimeout(() => { diag.skipped--; writePointer(performance.now()); }, wait);
}
/** What a check last saw, with how many milliseconds ago in place of when. */
function seen(s, now) {
  if (!s) return null;
  const { at, ...rest } = s;
  return { ...rest, ageMs: Math.round(now - at) };
}
function writePointer(now) {
  clearTimeout(diag.timer);
  diag.timer = 0;
  const c = at()?.side ?? { x: 0, y: 0 };
  console.log('[pointer] ' + JSON.stringify({
    ...diag.held, interactive, pressing: !!at()?.pressing,
    move: seen(diag.move, now), poll: seen(diag.poll, now),
    pet: { x: Math.round(c.x), y: Math.round(c.y) },
    types: [...diag.types], skipped: diag.skipped,
  }));
  diag.lastAt = now;
  diag.skipped = 0;
  diag.types.clear();
}

// Only the visible card and shortcut rail participate in native hit testing.
const UI_SELECTOR = [
  '.pet-space', '.pet-phone-chat:not([hidden])', '.bubble:not(.status):not(.fading):not([hidden])',
  '.menu:not([hidden]) > *', '.tools:not([hidden])', '.wheel:not([hidden])',
  '.landscape-chat:not([hidden]) .landscape-chat-dock > :not([hidden])',
].join(', ');
const overUi = (e) => e.target.closest && e.target.closest(UI_SELECTOR);

/**
 * In a Wayland session the window takes the mouse only over the rects reported here (host/input-shape.cjs),
 * sent from the frames when they change and at least every MOUSE_RENEW_MS: the body's hit circles inside its
 * box (body-host.js onBody), one strip per SHAPE_GRID row, and what UI_SELECTOR names, the hover buttons with
 * TOOLS_MARGIN around them. Every rect is rounded out to SHAPE_GRID, so a body breathing in place leaves the
 * shape as it is on most frames.
 */
let inputShape = false, shapeSent = '', shapeAt = -Infinity;
host?.onInputShape?.((on) => { inputShape = on; shapeSent = ''; });
const SHAPE_GRID = 8;
const gridDown = (v) => Math.floor(v / SHAPE_GRID) * SHAPE_GRID, gridUp = (v) => Math.ceil(v / SHAPE_GRID) * SHAPE_GRID;
function inputRects() {
  if (frameDrag || pressing && ['room','wallpaper'].includes(system.mode)) return [{ x: 0, y: 0, width: innerWidth, height: innerHeight }];
  const out = [];
  const add = (x0, y0, x1, y1) => {
    if (x1 > x0 && y1 > y0) out.push({ x: gridDown(x0), y: gridDown(y0), width: gridUp(x1) - gridDown(x0), height: gridUp(y1) - gridDown(y0) });
  };
  const l = at();
  for (const c of l?.hit ?? []) {
    const b = l.box, top = Math.max(b.y, c.y - c.r), bottom = Math.min(b.y + b.h, c.y + c.r);
    for (let y0 = gridDown(top); y0 < bottom; y0 += SHAPE_GRID) {
      // as wide as the circle's widest chord in the row: on the centre line when the row holds it, else at its edge nearer to it
      const y1 = y0 + SHAPE_GRID, dy = Math.max(0, y0 - c.y, c.y - y1), half = Math.sqrt(c.r * c.r - dy * dy);
      add(Math.max(b.x, c.x - half), Math.max(top, y0), Math.min(b.x + b.w, c.x + half), Math.min(bottom, y1));
    }
  }
  for (const el of document.querySelectorAll(UI_SELECTOR)) {
    const r = el.getBoundingClientRect(), m = el === tools ? TOOLS_MARGIN : 0;
    add(r.left - m, r.top - m, r.right + m, r.bottom + m);
  }
  return out;
}
function stepInputShape() {
  if (!inputShape) return;
  const rects = inputRects(), key = JSON.stringify(rects), now = performance.now();
  if (key === shapeSent && now - shapeAt < MOUSE_RENEW_MS) return;
  shapeSent = key;
  shapeAt = now;
  host.setInputRects(rects);
}
document.addEventListener('pointermove', (e) => {
  pointerSeen = true;
  lastPointer.x = e.clientX; lastPointer.y = e.clientY;
  const p = { x: e.clientX, y: e.clientY };
  cursor.at = p;
  if (frameDrag) {
    if (frameDrag.pointer === e.pointerId) {
      if (e.pointerType !== 'touch' && e.buttons === 0) endFrameDrag();
      else {
        frameDrag.next = p;
        setInteractive(rendering(), 'move');
      }
    }
    return;
  }
  // a move carries the buttons that are really down: a press whose release was missed ends here
  if (pressedPointer === e.pointerId && e.pointerType !== 'touch' && e.buttons === 0) cancelPointer('button-released');
  const point = { ...p, t: e.timeStamp };
  if (system.mode === 'phone' && pressing) {
    if (pressedPointer === e.pointerId && phoneGesture.move(point)) shakePhoneBody();
  } else if (!displayDrag.shifting && (pressing || !e.target.closest?.('.control-phone, .phone-chat-header, .phone-chat-log, .phone-chat-dock, .landscape-chat-dock'))) {
    // A cross-display drag can receive coordinates from either display.
    system.input.pointer('move', { ...point, lookOnly: system.mode === 'phone' || !hitBody(p) });
  }
  const hit = !!hitBody(p), ui = !!overUi(e);
  diag.move = { at: performance.now(), type: e.pointerType, x: Math.round(p.x), y: Math.round(p.y), hit, ui };
  diag.types.add(e.pointerType);
  if (e.pointerType !== diag.type) {
    const first = !diag.type;
    diag.type = e.pointerType;
    if (!first) logPointer('type', 'move');
  }
  setInteractive(rendering() && (pressing || hit || ui), 'move');
  if (system.mode === 'desktop' && !system.switching) displayDrag.follow(p);
});
/**
 * The pet window also reports where the cursor is on its own, several times a second: a click-through
 * window may miss the move that takes the cursor off the pet (onto the taskbar, another screen),
 * and the hover buttons would then stay. While the window passes the mouse through, the reports
 * are also the body's pointer moves: on Windows such a window gets no moves at all.
 */
let polled = null;
host?.onCursor?.((p) => {
  // in a Wayland session the reports keep the spot where the cursor left the last X11 window; there the page's own pointer events place it
  if (!inputShape || !p) cursor.at = p;
  if (!p) {
    diag.poll = { at: performance.now(), off: true };
    if (!pressing && !frameDrag) setInteractive(false, 'poll');
    if (polled && !pressing && !frameDrag) system.input.pointer('leave', {});
    polled = null;
    return;
  }
  if (!interactive && !pressing && !frameDrag && (p.x !== polled?.x || p.y !== polled?.y)) {
    pointerSeen = true;
    lastPointer.x = p.x; lastPointer.y = p.y;
    system.input.pointer('move', { ...p, t: performance.now(), lookOnly: system.mode === 'phone' || !hitBody(p) });
  }
  polled = p;
  const el = document.elementFromPoint(p.x, p.y);
  const hit = !!hitBody(p), ui = !!el?.closest?.(UI_SELECTOR) || !!system.presentation.hit?.(p);
  diag.poll = { at: performance.now(), x: p.x, y: p.y, hit, ui };
  setInteractive(rendering() && (!!frameDrag || pressing || hit || ui), 'poll');
});
/** A press that began on the body and has not been let go of: the window keeps the mouse meanwhile. */
let pressing = false, pressedPointer = null, frameDrag = null;
const phoneGesture = createPhoneGesture();
let pendingSceneDrop = null, sceneDropId = 0;
const hitBody = point => (system.mode === 'desktop' || system.presentation.hit?.(point))
  && !system.presentation.occludes?.(point) && system.input.hit(point);
function shakePhoneBody() {
  if (!system.switching) system.input.pointer('shake', {});
}
const displayDrag = createDisplayDrag({
  scene: system.scene, currentBody: () => system.body,
  followCursor: host?.followCursor ? () => host.followCursor() : undefined,
  refresh: () => system.presentation.refresh(),
  now: () => performance.now(), frame: () => new Promise(resolve => setTimeout(resolve, 16)),
});

function frameGrip(e) {
  return e.target.closest?.('[data-scene-grip]');
}
function frameOrigin() {
  return { frame: system.scene.rect(), body: system.body, character: at(), moved: false };
}
function applySceneFrame(change, origin) {
  if (!system.transformSceneFrame(change, origin)) return;
  syncPhoneChat();
  if (!menu.hidden && system.mode === 'phone') placeMenu(at());
}
function positionSceneFrame(point, origin) {
  const dx = point.x - origin.startX, dy = point.y - origin.startY;
  const { x, y, w, h } = origin.frame;
  if (origin.kind === 'resize') {
    const scale = 1 + (dx * w + dy * h) / (w * w + h * h);
    applySceneFrame({ kind: 'resize', width: w * scale }, origin);
  } else applySceneFrame({ kind: 'move', x: x + dx, y: y + dy }, origin);
}
function endFrameDrag() {
  if (!frameDrag) return;
  const { grip, pointer } = frameDrag;
  frameDrag = null;
  delete document.body.dataset.frameDragging;
  if (grip.hasPointerCapture(pointer)) grip.releasePointerCapture(pointer);
}
document.addEventListener('pointerdown', e => {
  const grip = frameGrip(e);
  if (!grip || e.button !== 0 || frameDrag || pressing || system.switching || clicksPass()) return;
  const origin = frameOrigin();
  if (!origin.frame) return;
  const kind = grip.dataset.sceneGrip;
  frameDrag = { ...origin, kind, grip, pointer: e.pointerId, startX: e.clientX, startY: e.clientY };
  document.body.dataset.frameDragging = kind;
  setInteractive(rendering(), 'move');
  if (e.isTrusted) grip.setPointerCapture(e.pointerId);
  e.preventDefault();
});
document.addEventListener('pointerup', e => {
  if (frameDrag?.pointer !== e.pointerId) return;
  positionSceneFrame({ x: e.clientX, y: e.clientY }, frameDrag);
  endFrameDrag();
}, { capture: true });
for (const event of ['pointercancel', 'lostpointercapture']) {
  document.addEventListener(event, e => { if (frameDrag?.pointer === e.pointerId) endFrameDrag(); });
}
document.addEventListener('keydown', e => {
  const grip = frameGrip(e);
  if (!grip || frameDrag || pressing || system.switching || clicksPass()) return;
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!direction) return;
  const origin = frameOrigin();
  const distance = e.shiftKey ? 1 : 12;
  const [dx, dy] = direction;
  if (grip.dataset.sceneGrip === 'resize') {
    applySceneFrame({ kind: 'resize', width: origin.frame.w + (dx + dy) * distance }, origin);
  } else applySceneFrame({ kind: 'move', x: origin.frame.x + dx * distance, y: origin.frame.y + dy * distance }, origin);
  e.preventDefault();
});

function cancelPointer(reason) {
  endFrameDrag();
  phoneGesture.cancel();
  pendingSceneDrop = null;
  displayDrag.cancel();
  const pointer = pressedPointer;
  pressing = false; pressedPointer = null;
  if (pointer !== null && stage.hasPointerCapture(pointer)) stage.releasePointerCapture(pointer);
  stage.style.cursor = '';
  system.input.clear(reason);
}

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || frameGrip(e) || e.target.closest?.('[data-scene-exit], .landscape-chat-dock') || frameDrag || pressedPointer !== null || system.switching || clicksPass()) return;
  pendingSceneDrop = null;
  closeMenu();
  const p = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  if (!hitBody(p) && system.mode === 'room' && system.presentation.hit?.(p) && (!overUi(e) || e.target.closest('.pet-space'))) {
    const target = system.scene.targetAt?.(p);
    startSceneOrder({ id: crypto.randomUUID(), target: target ?? system.scene.drop?.(p).point ?? p, interact: !!target });
    return;
  }
  const onBody = hitBody(p);
  if (!onBody && system.mode === 'wallpaper') return;
  if (system.mode === 'phone') {
    if (!onBody) return;
    phoneGesture.start(p);
  } else {
    system.input.pointer('down', p);
  }
  if (onBody) {
    pressing = true; pressedPointer = e.pointerId;
    if (e.isTrusted) stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});

stage.addEventListener('pointerup', (event) => {
  if (frameGrip(event) || event.target.closest?.('[data-scene-exit]') || frameDrag || pressedPointer !== null && pressedPointer !== event.pointerId) return;
  const captured = pressedPointer === event.pointerId;
  pressing = false; pressedPointer = null;
  stage.style.cursor = '';
  const point = { x: event.clientX, y: event.clientY, t: event.timeStamp };
  const up = (position = { ...lastPointer, t: performance.now() }) => system.input.pointer('up', position);
  if (system.mode === 'phone') {
    if (!captured) return;
    const gesture = phoneGesture.release(point);
    if (gesture?.type === 'shake') shakePhoneBody();
    if (gesture?.type === 'tap') {
      const tap = { ...gesture.point, tapOnly: true };
      system.input.pointer('down', tap);
      up({ ...tap, t: point.t });
    }
    return;
  }
  if (system.mode === 'wallpaper') { up(point); return; }
  if (system.mode === 'room') {
    if (captured) {
      const id = ++sceneDropId;
      pendingSceneDrop = { id, mode: system.mode, point };
      up({ ...point, sceneDrop: id });
    } else up(point);
    return;
  }
  void displayDrag.release(point, up, async drop => {
    document.body.style.visibility = 'hidden';
    try { await drop(); }
    finally { document.body.style.visibility = ''; }
  }).catch(() => cancelPointer('display-transition-failed'));
});
stage.addEventListener('pointercancel', () => cancelPointer('pointer-cancelled'));
stage.addEventListener('lostpointercapture', event => {
  if (pressedPointer === event.pointerId) cancelPointer('capture-lost');
});
window.addEventListener('blur', () => cancelPointer('window-blurred'));
document.addEventListener('pointerleave', () => { cursor.at = null; if (!frameDrag) system.input.pointer('leave', {}); });
stage.addEventListener('dblclick', (e) => { if (prefs.doubleClickChat && !e.target.closest?.('[data-scene-exit]') && hitBody({ x: e.clientX, y: e.clientY })) openInput(); });
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const point = { x: e.clientX, y: e.clientY };
  if (!clicksPass() && !pressing && !frameDrag && !at()?.pressing && !(system.mode === 'phone' && e.pointerType === 'touch') && !e.target.closest('input, textarea, select') && !menu.contains(e.target) &&
    (hitBody(point) || overTools(point) || system.mode !== 'desktop' && system.presentation.hit?.(point))) openMenu();
});
document.addEventListener('pointerdown', (e) => { if (e.button === 0 && !e.target.closest('.control-phone, [aria-controls=menu], .phone-chat-tag, .wheel, [data-scene-grip], [data-scene-exit]')) closeMenu(); }, { capture: true });
// clicks off the figure pass through the window to what is underneath; the window losing focus is how they show here
window.addEventListener('blur', resetDesktopControls);
document.addEventListener('focusin', (e) => {
  if (e.target.matches?.('input, textarea')) host?.focus?.();
});
document.addEventListener('keydown', (e) => {
  // Escape and number keys belong to the input method while choosing a candidate.
  if (e.isComposing || e.keyCode === 229) return;
  if (menu.hidden && (tools.contains(document.activeElement) || phoneChat.frame.contains(document.activeElement)) && (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    openMenu(document.activeElement);
    return;
  }
  if (!menu.hidden && e.key === 'Escape') {
    e.preventDefault();
    closeMenu(true);
    return;
  }
  if (!menu.hidden && menu.contains(document.activeElement)) {
    const items = [...menu.querySelectorAll('button:not(:disabled):not([hidden]), input, select')].filter(element => element.getClientRects().length);
    const index = items.indexOf(document.activeElement);

    if (e.key === 'Tab' && (index === (e.shiftKey ? 0 : items.length - 1) || index < 0)) {
      e.preventDefault();
      items[e.shiftKey ? items.length - 1 : 0]?.focus();
    }
    return;
  }
  if (e.key === 'Escape') {
    if (item && item.kind === 'ask') dismissAsk();
    else if (item && item.kind === 'input') closeBubble();
    return;
  }
  const typing = e.target.closest && e.target.closest('input, textarea');
  // the digit row or the number pad, whether or not Num Lock is on
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code) || /^([1-9])$/.exec(e.key);
  if (item && item.kind === 'ask' && item.optsShown && !item.answered && !typing && digit && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    const b = bubble.querySelectorAll('.b-opt')[+digit[1] - 1];
    if (b) b.click();
  }
});

/* ---------- layout ---------- */
/**
 * Bubbles up to TAIL_CENTER wide (empty, or a word or two) point their tail from their middle; wider ones
 * move it over to Coo by TAIL_FOLLOW wide. Between the two it slides, so a bubble growing as the line
 * types out carries its tail along with it.
 */
const TAIL_CENTER = 70, TAIL_FOLLOW = 130;
/** Where the tail's tip sits along a bubble `bw` wide whose left edge is `x` left of Coo. */
function tailAt(bw, x) {
  const k = clamp((bw - TAIL_CENTER) / (TAIL_FOLLOW - TAIL_CENTER), 0, 1);
  return bw / 2 + (clamp(x, 22, bw - 22) - bw / 2) * k;
}
/** Coo's bubble above its head, moved over to the side it faces. */
function place(el, a, extraUp) {
  const bw = el.offsetWidth, bh = el.offsetHeight;
  const left = clamp(a.x - bw / 2 + (at()?.facing ?? 1) * 26, 10, Math.max(10, innerWidth - bw - 10));
  const top = Math.max(8, a.y - bh - extraUp);
  el.style.left = f(left) + 'px';
  el.style.top = f(top) + 'px';
  el.style.setProperty('--tail', f(tailAt(bw, a.x - left)) + 'px');
  return { left, top, bw, bh };
}
function placeTalk(it, a) {
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  // picked up, or still falling when the bubble opened, Coo takes the bubble along until it has landed, and it
  // stays where Coo came down; the hops and strolls of stepTalkMotion's demo (talk.motion) are Coo's own and leave it be
  const mode = at()?.mode;
  if (mode === 'drag' || (FLYING.has(mode) && !talk.motion)) it.carried = true;
  if (it.carried) { it.pinX = a.x; it.pinY = a.y; if (!FLYING.has(mode)) it.carried = false; }
  const left = clamp(it.pinX - bw / 2, 10, Math.max(10, innerWidth - bw - 10));
  const top = Math.max(8, it.pinY - bh - 18 * prefs.bubbleSize);
  bubble.style.left = f(left) + 'px';
  bubble.style.top = f(top) + 'px';
  bubble.style.setProperty('--tail', f(tailAt(bw, a.x - left)) + 'px');
  return { left, top, bw, bh };
}

/** Beside the body, on the right unless that runs off the screen. */
function activeSceneComposer() {
  return document.querySelector('.landscape-chat:not([hidden]) .landscape-chat-form:not([hidden])');
}
function placeTools(l) {
  const viewport = {width:innerWidth, height:innerHeight};
  const p = cursor.at;
  const keep = toolAnchor && p && (overTools(p) || inApproach(p, l.box, tools.getBoundingClientRect()));
  if (!toolAnchor || (!keep && !tools.querySelector('.tool:focus-visible')) || toolAnchor.width !== innerWidth || toolAnchor.height !== innerHeight) {
    const size = {width:tools.offsetWidth, height:tools.offsetHeight};
    const composer = activeSceneComposer();
    const avoid = [...(bubble.hidden ? [] : [bubble.getBoundingClientRect()]), ...(composer ? [composer.getBoundingClientRect()] : [])];
    // The draw box can shift with breath and a mirrored pose; use the body's stable side envelope.
    const reach = l.side.reach;
    const box = {...l.box, x:l.x - reach, w:2 * reach};
    toolAnchor = {...viewport, ...nextToBody(box, l.side.y, size, viewport, avoid)};
  }
  tools.style.left = toolAnchor.left + 'px';
  tools.style.top = toolAnchor.top + 'px';
  refreshToolNote(l.x);
}
function layout(dt = 0) {
  const l = at();
  if (!l) return;
  if (document.documentElement.dataset.scene !== system.mode) document.documentElement.dataset.scene = system.mode;
  stage.style.cursor = system.mode === 'phone' ? (cursor.at && hitBody(cursor.at) ? 'pointer' : '') : l.cursor;
  // the sounds come from where Coo is on its display: screenX and availLeft (the left of the work area the pet window
  // covers) count from the same origin across all displays
  sfx.setPan(((screenX - screen.availLeft + l.x) / (screen.availWidth || innerWidth)) * 2 - 1);
  if (!tools.hidden) placeTools(l);
  if (!menu.hidden) placeMenu(l);
  if (system.mode === 'phone') {
    for (const line of lines) {
      if (line.el.parentElement === document.body && !line.el.hidden) line.el.hidden = true;
    }
    return;
  }
  if (!wheel.hidden) placeWheel(l);
  if (system.mode !== 'desktop') return;
  for (const line of lines) if (line.el.hidden) line.el.hidden = false;
  const a = l.bubble;
  let sayBox = null;
  // choice cards and a World's confirmation keep their bubble where it was; its tail follows Coo along the bottom edge
  if (!bubble.hidden && item?.pinX !== undefined) sayBox = placeTalk(item, a);
  else if (!bubble.hidden) sayBox = place(bubble, a, 18 * prefs.bubbleSize);
  placeLines(a, sayBox, dt);
}

/** From Coo's head to the newest line's bottom edge, and between lines, in pixels at bubble size 1. */
const LINES_UP = 46, LINES_GAP = 8;
/**
 * The person's lines above Coo: newest at the bottom, older ones above it, centred over Coo's own bubble (`box`)
 * while it is up and over Coo's head otherwise. Each line eases to its place over `dt`, so a new line pushes the
 * others up and a closed one is closed over; a fading line stays where it was.
 */
function placeLines(a, box, dt) {
  if (!lines.length) return;
  const W = innerWidth, size = prefs.bubbleSize, gap = LINES_GAP * size;
  const cx = box ? box.left + box.bw / 2 : a.x;
  let bottom = box ? box.top - gap : a.y - LINES_UP * size;
  const k = dt > 0 ? Math.min(1, dt * 12) : 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i], el = line.el;
    el.classList.toggle('older', i !== lines.length - 1);
    if (line.fadeAt === null || line.ox === null) {
      const bw = el.offsetWidth, bh = el.offsetHeight;
      const left = clamp(cx - bw / 2, 10, Math.max(10, W - bw - 10));
      const top = Math.max(8, bottom - bh);
      if (line.ox === null) { line.ox = left - a.x; line.oy = top - a.y; }
      else { line.ox += (left - a.x - line.ox) * k; line.oy += (top - a.y - line.oy) * k; }
      bottom = top - gap;
    }
    el.style.left = f(a.x + line.ox) + 'px';
    el.style.top = f(a.y + line.oy) + 'px';
  }
}

/* ---------- backdrop: a light gray halo when the body melts into what is behind it ---------- */
/** Seconds between looks at the screen around the body. */
const BACKDROP_EVERY = .8;
/** OKLab distance under which a backdrop pixel counts as the body's color. */
const SAME_COLOR = .15;
/** Share of such pixels around the body that turns the halo on (most of them), and the share it turns off below. */
const HALO_ON = .6, HALO_OFF = .45;
/** The halo's opacity when fully on. */
const HALO_STRENGTH = .5;
// a window host too old to sample the screen keeps the halo on; a browser tab draws its own wall
const backdrop = { on: !!host && !host.sampleBackdrop, fixed: !!host && !host.sampleBackdrop, k: 0, busy: false, next: 0 };

const lin = (c) => (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
function oklab(r, g, b) {
  r = lin(r / 255); g = lin(g / 255); b = lin(b / 255);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
}
/** The theme's body outline color as [r, g, b]. */
function inkRgb() {
  let h = getComputedStyle(document.documentElement).getPropertyValue('--skin-ink').trim().replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return /^[0-9a-f]{6}$/i.test(h) ? [n >> 16, (n >> 8) & 255, n & 255] : null;
}
const inflate = (r, d) => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });
const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
/** A bubble's rect with its shadow (0 8px 22px) and its tail below it, none of which is the screen behind. */
const shadowed = (r) => ({ x: r.x - 14, y: r.y - 14, width: r.width + 28, height: r.height + 14 + 36 });
/** Modes in which the body flies or is carried: a screen copy taken now would be of where it was a moment ago. */
const FLYING = new Set(['air', 'drag', 'land']);

/** Samples a ring around the body (past the halo's reach, minus the page's own bubbles) and flips the halo. */
async function probeBackdrop() {
  const l = at(), ink = inkRgb(), b = l?.box;
  if (!ink || !b || FLYING.has(l.mode)) return;
  const S = bounds().S;
  // the ring starts past the halo, so a wide one (prefs.glow) is not taken for the screen behind
  const near = inflate({ x: b.x, y: b.y, width: b.w, height: b.h }, Math.max(4 + 34 * S, 4 + 2 * prefs.glow)), far = inflate(near, 8 + 40 * S);
  const x = Math.max(0, far.x), y = Math.max(0, far.y);
  const rect = { x, y, width: Math.min(innerWidth, far.x + far.width) - x, height: Math.min(innerHeight, far.y + far.height) - y };
  const covers = [bubble, ...(menu.hidden ? [] : menu.children), tools, wheel, ...lines.map((l) => l.el)].filter((el) => !el.hidden).map((el) => shadowed(rectOf(el)));
  const px = await host.sampleBackdrop(rect, [near, ...covers]);
  // this platform cannot read the screen cheaply: the halo just stays
  if (px === null) { backdrop.on = true; backdrop.fixed = true; return; }
  const n = px.length / 3;
  if (n < 24) return;
  const [L, A, B] = oklab(...ink);
  let same = 0;
  for (let i = 0; i < px.length; i += 3) {
    const [l, a, b] = oklab(px[i], px[i + 1], px[i + 2]);
    if (Math.hypot(l - L, a - A, b - B) < SAME_COLOR) same++;
  }
  const share = same / n;
  // while the page's own bubbles cover part of the ring the halo may come on, but does not go off
  if (backdrop.on && covers.length) return;
  backdrop.on = backdrop.on ? share >= HALO_OFF : share > HALO_ON;
}
function stepBackdrop(dt) {
  const now = performance.now() / 1000;
  if (host?.sampleBackdrop && prefs.glow > 0 && !backdrop.fixed && !backdrop.busy && now >= backdrop.next && document.visibilityState === 'visible') {
    backdrop.busy = true;
    probeBackdrop().catch(() => {}).finally(() => { backdrop.busy = false; backdrop.next = performance.now() / 1000 + BACKDROP_EVERY; });
  }
  const k = backdrop.k + ((backdrop.on ? 1 : 0) - backdrop.k) * Math.min(1, dt * 6);
  backdrop.k = k < .005 ? 0 : k;
  // the body is in its own frame: it takes the halo as a CSS filter
  system.body?.setHalo(backdrop.k * HALO_STRENGTH, prefs.glow);
}

/* ---------- loop ---------- */
/**
 * Frames per second: `prefs.frameRate` while the body moves (its layout's `moving`) and always while `lockFrameRate` is on,
 * RESTING_FPS otherwise; a frame rate of 0, or one above the display's, draws on every display refresh. Each frame
 * redraws what changed in the figure, so the window's CPU and GPU time grows with this rate.
 *
 * While the pet window is hidden, frames come at HIDDEN_FPS: the clock, the orders, the bubbles' text and the body's
 * motion go on, so a walk still arrives and a line still runs out, but the body is not drawn, nothing on the stage is
 * placed, the screen behind is not sampled and the streaming layer gets no frames.
 *
 * Each frame advances the clock by the time since the frame before, in steps (frame-loop.js); the page's orders and
 * the body take every step, and only the last one is drawn.
 */
const RESTING_FPS = 30;
/** Frames a second while the window is hidden: the World hears of an arrival within a tenth of a second. */
const HIDDEN_FPS = 10;
/** The last error the frame loop logged, so one that keeps recurring is reported once, not per frame. */
let frameErr = null;
/**
 * Frames whose timestamp was not past the one before (no time to step), and when that was last logged (ms):
 * where these timestamps come from is not known yet. Logged at most once a minute, with the count so far. The first frame is
 * left out: the loop starts its count at the page's clock, which may be ahead of the first frame's timestamp.
 */
let stalls = 0, stallLoggedAt = -Infinity, framed = false;
function frame(steps, now, last) {
  const drawn = windowShown;
  if (framed && now <= last) {
    stalls++;
    if (performance.now() - stallLoggedAt > 60_000) {
      stallLoggedAt = performance.now();
      console.warn(`[pet] 帧时间戳没有前进(累计 ${stalls} 次):now=${now} 上一帧=${last} 页面=${document.visibilityState} 焦点=${document.hasFocus()} 模式=${at()?.mode ?? '-'}`);
    }
  }
  framed = true;
  try {
    speech.tick();
    steps.forEach((dt, i) => {
      T += dt;
      system.actions.tick(dt);
      stepDialog(dt);
      stepTalkRead(dt);
      stepTalkMotion();
      stepLines();
      stepStatus();
      setBody({ dialogOpen: !!item || !!listen.phase, still: !menu.hidden });
      system.tick(dt, drawn && i === steps.length - 1);
    });
    if (T - lastFrameworkReport >= 2) reportFramework();
    if (drawn) {
      const touchLayout = prefs.touchRegionsVisible && !system.switching ? at() : null;
      touchOverlay.render(touchLayout, !language().startsWith('zh'), touchLayout && system.mode !== 'desktop' ? system.scene.rect() : null);
      const dt = steps.reduce((a, b) => a + b, 0);
      stepBackdrop(dt);
      syncPhoneChat();
      if (!menu.hidden && menu.dataset.app === 'actions') controlPhone.actionResult(system.actions.snapshot().recent);
      stepTools();
      stepWheel();
      layout(dt);
      holdingBubble = !bubble.hidden && bubbleHover.sample(pointedAt(), cursor.at);
      stepInputShape();
      // the frame's own time, so the layer shows frames as far apart as they were drawn
      if (overlayOn) host.overlayFrame(overlayRect(), performance.timeOrigin + now);
    }
  } catch (err) {
    // a throwing step must not take the loop with it: the next frame is only asked for after this returns, and
    // without it the pet freezes for good (a broken figure throws again on every frame it draws)
    const msg = err?.message ?? String(err);
    if (msg !== frameErr) { frameErr = msg; console.error(err); }
  }
  const full = drawn && (!!frameDrag || pressing && system.mode === 'room' || prefs.lockFrameRate || !!at()?.moving);
  // a moving rate of 0 draws on every display refresh
  return { fps: full ? prefs.frameRate : drawn ? RESTING_FPS : HIDDEN_FPS, refresh: full };
}
addEventListener('pagehide', reportPosition);
addEventListener('pagehide', event => { if (!event.persisted) system.dispose(); });
// drawn frames stop while the window is hidden or occluded, which `rendering()` reads
runFrames(frame, { refreshed() {
  if (!windowShown) return;
  lastFrameAt = performance.now();
  if (!frameDrag?.next) return;
  const point = frameDrag.next;
  frameDrag.next = null;
  positionSceneFrame(point, frameDrag);
} });
