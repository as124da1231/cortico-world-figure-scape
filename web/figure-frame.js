import { createFigureTouch } from './framework/figure-touch.js';
import { bodyFramingReport, applyBodyFraming } from './body-framing-contract.js';
import { applyDraftAction, draftActionReport } from './body-draft-action-contract.js';
import { visualSettings } from './body-visual-contract.js';
import { applyModelConfiguration } from './model-configuration-contract.js';
import { bodyInputReport, applyBodyInput } from './body-input-contract.js';
import { modelBehaviorReport } from './model-behavior-contract.js';
/**
 * Runs the direct model renderer in a sandboxed origin.
 * The host exchanges commands and rendering receipts through postMessage.
 *
 * The body factory is called as
 * `factory(base, { model, scheme, kit, loadImage, asset, host })`, that resolves to a body:
 *
 * - `host`: `root` (the element to draw in, filling the stage), `bounds()` ({ W, H, floorY, S } in stage
 *   pixels: the floor's height and the size the body is drawn at, 1 logo unit = S pixels, the body
 *   inside a 256-unit square), `emit(kind, detail)`, `sound(name, kind, ...args)` and `start`
 *   ({ x, y, facing, enter, skin }; `y` only where the body last reported one, see `layout`). For a pack whose manifest `needs` `windows`, `bounds()` also has `ledges` and
 *   `windows` while the window can read them (Windows, macOS, Linux on X11), both in stage pixels, read every 0.7 s
 *   and replaced only when something changed; absent elsewhere. `ledges`: the visible top edges of the other windows
 *   on the pet's display, `[{ x0, x1, y }]`, the parts hidden by a window in front left out, highest first.
 *   `windows`: those windows whole, front first, `[{ id, x0, y0, x1, y1, active }]` (left, top, right, bottom, parts
 *   off the stage or behind other windows included): every window that reaches onto the stage above the floor, at
 *   most 64. `id` is an opaque string that stays the window's while it is open and may go to another window after
 *   it closes; `active` is true for the foreground window and false for the others, and absent on macOS.
 * - `kit`: web/kit/body.js (createBody builds a whole body around a figure that only draws; createRig).
 * - the body: `step(dt, draw)` advances one frame and draws it, unless `draw` is false (the pet window is hidden;
 *   a body that draws anyway only spends the time); `layout()` says where it is ({ x, y, facing, mode,
 *   busy, moving, pressing, cursor, box, hit, bubble, side }, see the kit's `layout`; `y`, the stage y its feet stand on, only
 *   for a body that stands off the floor, which the World then keeps with its position and hands back as `start.y`); `resize()` takes new
 *   bounds (`set({ bounds })` from the page changes what `host.bounds()` returns, then calls it); `do(word)`, `walk(x, run, id)`,
 *   `move({ to, run, params }, id)` (one of the manifest's `moves`, its `params` by id as the World checked them),
 *   `stopWalk(id)` (a walk's or a move's), `pointer(type, p)`, `drop(p)`, `shift(dx, dy)`, `place(x, facing, y)`,
 *   `set(state)` (the kit's `set`, with `status`: the kind of work the page's status bubble shows, or null), `cue(kind)`, `talk()`, `setScheme(id, { fade })`, `z` (the colour of its sleep z's),
 *   `words` (every word `do` knows; the kit's bodies list theirs, and the manifest's words not in it are
 *   kept from the bot) and `dispose()`. Only `step`, `layout` and `do` are required.
 * - events (`emit`): `arrived` and `interrupted` ({ walkId, x, y?, by }) for `walk` and `move` (`by`: a short word on what
 *   stopped it, which the bot reads; `drag` when it was picked up), `done` ({ word }) for a word
 *   that ends on its own, `touch` ({ kind: poke | pet | grab | drop | throw | crash, ... }), `mode` ({ mode }).
 *
 * Messages in: `init { entry, export, base, model, scheme, start, theme, bounds, language }` (the app language,
 * for the frame's own error messages), then `tick { dt, draw }`
 * once a frame, `windows { ledges, windows }` (null when there are none to read) and the calls above by name. Out: `loaded`, `ready { z, words }`, `frame { layout, events: [{ kind,
 * detail }], sounds: [{ name, kind, args }], z }` after each tick, `scheme { seq, z }`, and `error { message }`
 * once, after which it stops.
 */
import { bodySpeechReport, applyBodySpeech } from './body-speech-contract.js';
import * as kit from './kit/body.js';
import { bodyEffectReport, applyBodyState } from './body-effects-contract.js';
import { t, useLanguage } from './i18n.js';

const root = document.getElementById('root');
let body = null, preview = false, dead = false, bounds = { W: 0, H: 0, floorY: 0, S: .42 }, desk = null;
/** The stage's size from the page, with the windows when there are any. */
const setBounds = (b) => { bounds = desk ? { ...b, ...desk } : { ...b }; };
let events = [], sounds = [], captureCover = false, extraTouch = null, previewWords = null;
const post = (m) => parent.postMessage(m, '*');
function fail(err) {
  if (dead) return;
  dead = true;
  post({ t: 'error', message: String(err?.message ?? err).slice(0, 300) });
}
addEventListener('error', (e) => fail(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => fail(e.reason));

function loadImage(url) {
  return new Promise((ok, bad) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => ok(im);
    im.onerror = () => bad(new Error(t('figure.imageFailed', { url })));
    im.src = String(url);
  });
}

const host = {
  root,
  bounds: () => bounds,
  emit: (kind, detail) => events.push({ kind, detail: extraTouch ? extraTouch.event(kind, detail) : detail }),
  sound: (name, kind, ...args) => sounds.push({ name, kind, args }),
};

addEventListener('message', async (e) => {
  if (e.source !== parent || dead) return;
  const m = e.data || {};
  try {
    if (m.t === 'windows') {
      desk = Array.isArray(m.ledges) && Array.isArray(m.windows) ? { ledges: m.ledges, windows: m.windows } : null;
      const { ledges: _l, windows: _w, ...b } = bounds;
      setBounds(b);
    } else if (m.t === 'init') {
      setBounds(m.bounds);
      document.documentElement.dataset.theme = m.theme;
      if (typeof m.language === 'string') await useLanguage(m.language);
      const base = new URL(m.base);
      const options = { model: m.model ?? undefined, scheme: m.scheme, kit, loadImage, asset: (p) => new URL(p, base), host: { ...host, start: m.start } };
      captureCover = m.cover === true;
      preview = captureCover || [1024, 2048, 'unlimited'].includes(m.previewSize);
      if (m.source?.kind === 'live2d-model') {
        const { createDirectModelBody } = await import('./direct-model-body.js');
        body = await createDirectModelBody(m.source, base, {
          ...options, ...(preview ? { preview: true, previewSize: m.previewSize, editorPreview: m.editorPreview === true } : {}),
        });
      } else {
        const entry = new URL(m.entry);
        const model = new URL(location.href).searchParams.get('model');
        if (!/^figure-[a-f0-9]{24}$/.test(model ?? '') || entry.origin !== location.origin ||
          !entry.pathname.startsWith('/figure-assets/' + model + '/')) throw Error('Invalid figure entry');
        const module = await import(entry.href);
        const factory = module[m.export];
        if (typeof factory !== 'function') throw Error('The figure entry does not export its body factory');
        body = await factory(base, options);
        extraTouch = createFigureTouch(m.figureSettings?.touch, Array.isArray(body?.words) ? body.words : m.figureWords ?? [], body);
        if (m.editorPreview === true) previewWords = new Set(m.figureWords ?? []);
      }
      for (const fn of ['step', 'layout', 'do']) if (typeof body?.[fn] !== 'function') throw new Error(t('figure.missingMethod', { name: fn }));
      post({ t: 'ready', draftAction: draftActionReport(body), framing: bodyFramingReport(body), input: bodyInputReport(body), modelBehavior: modelBehaviorReport(body.modelBehavior), speech: bodySpeechReport(body), bodyEffects: bodyEffectReport(body), z: body.z ?? null, words: Array.isArray(body.words) ? body.words.filter((w) => typeof w === 'string') : null });
    } else if (!body) {
      // calls that come before the body is ready have nothing to act on
    } else if (m.t === 'tick') {
      body.step(m.dt, m.draw);
      if (captureCover && globalThis.__l2dPreviewReady?.()) {
        captureCover = false;
        let png = null;
        try { png = globalThis.__l2dCover?.(256)?.png ?? null; }
        catch (error) { console.warn('Model cover capture failed', error); }
        post({ t: 'model-cover', png });
      }
      const renderQuality = preview ? globalThis.__l2dRenderQuality?.() : undefined;
      post({ t: 'frame', frameScope: m.frameScope, renderQuality, layout: extraTouch?.layout() ?? body.layout(), draftAction: draftActionReport(body), framing: bodyFramingReport(body), events, sounds, z: body.z ?? null });
      events = []; sounds = [];
    } else if (m.t === 'scheme') {
      // the fade starts at the body's next frame: the page's clock is not the body's
      await body.setScheme?.(m.id, { fade: m.fade });
      post({ t: 'scheme', seq: m.seq, modelBehavior: modelBehaviorReport(body.modelBehavior), z: body.z ?? null });
    } else if (m.t === 'editor-figure-word') {
      let ok = false, reason;
      try {
        if (previewWords?.has(m.word) && (!Array.isArray(body.words) || body.words.includes(m.word))) ok = await body.do(m.word) !== false;
      } catch (error) { reason = String(error?.message ?? error).slice(0, 240); }
      post({ t: 'editor-figure-word', id: m.id, ok, reason });
    } else if (m.t === 'do') body.do(m.word);
    else if (m.t === 'walk') { if (!body.walk?.(m.x, m.run, m.id, m.y)) events.push({ kind: 'interrupted', detail: { walkId: m.id, by: 'busy' } }); }
    else if (m.t === 'move') { if (!body.move?.(m.args, m.id)) events.push({ kind: 'interrupted', detail: { walkId: m.id, by: 'busy' } }); }
    else if (m.t === 'stop-walk') body.stopWalk?.(m.id);
    else if (m.t === 'pointer') {
      const dropped = extraTouch ? extraTouch.input(m.type, m.p, host.emit) : body.pointer?.(m.type, m.p);
      if (m.type === 'up' && Number.isSafeInteger(m.p?.sceneDrop)) post({ t: 'scene-drop', id: m.p.sceneDrop, dropped: dropped === true });
    }
    else if (m.t === 'drop') body.drop?.(m.p);
    else if (m.t === 'shift') body.shift?.(m.dx, m.dy);
    else if (m.t === 'place') body.place?.(m.x, m.facing, m.y, m.settle);
    else if (m.t === 'set') {
      if (m.state?.bounds) { setBounds(m.state.bounds); body.resize?.(); }
      const receipt = applyBodyState(body, m.state, m.effectSeq);
      if (receipt) post(receipt);
    }
    else if (m.t === 'cue') body.cue?.(m.kind);
    else if (m.t === 'talk') body.talk?.();
    else if (m.t === 'body-visual') {
      try {
        if (!body.previewVisual) throw Error('Model visual controls are unavailable');
        body.previewVisual(m.value === null ? null : visualSettings(m.value));
        post({ t: 'body-visual', request: m.request, ok: true, modelBehavior: modelBehaviorReport(body.modelBehavior) });
      } catch (error) { post({ t: 'body-visual', request: m.request, ok: false, reason: String(error?.message ?? error) }); }
    }
    else if (m.t === 'model-configuration') post({...applyModelConfiguration(body,m.configuration,m.seq),words:Array.isArray(body.words)?body.words:null,modelBehavior:modelBehaviorReport(body.modelBehavior),framing:bodyFramingReport(body)});
    else if (m.t === 'body-draft-action') post(applyDraftAction(body, m.command, m.requestId, m.seq));
    else if (m.t === 'body-draft-wardrobe') {
      const owner = m.command?.owner;
      try {
        if (!body.draftWardrobe) throw Error('Draft wardrobe preview is unavailable');
        body.draftWardrobe(m.command);
        post({ t: 'body-draft-wardrobe', owner, status: m.command.kind === 'restore' ? 'released' : 'applied' });
      } catch (error) { post({ t: 'body-draft-wardrobe', owner, status: 'failed', error: String(error?.message ?? error) }); }
    }
    else if (m.t === 'body-clear-draft-action' && (!m.owner || body.draftActionState?.owner === m.owner)) body.clearDraftAction?.();
    else if (m.t === 'body-framing') post(applyBodyFraming(body, m.command, m.seq));
    else if (m.t === 'body-input') post(applyBodyInput(body, m.input, m.seq));
    else if (m.t === 'body-speech') {
      if (m.mapping !== undefined) {
        try {
          if (!body.previewMouth) throw Error('Draft mouth preview is unavailable');
          body.previewMouth(m.mapping);
        } catch (error) {
          post({t:'body-speech', seq:m.seq, command:m.command, status:'failed', error:String(error)});
          return;
        }
      }
      post(applyBodySpeech(body, m.command, m.seq));
    }
    else if (m.t === 'body-speech-level') body.speechLevel?.(m.level);
    else if (m.t === 'body-speech-plan') body.speechPlan?.(m.command);
  } catch (err) {
    fail(err);
  }
});
post({ t: 'loaded' });
