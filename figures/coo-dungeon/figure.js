const SVG = 'http://www.w3.org/2000/svg';
const SLASH = 'heavy-slash';
const STATE_EYES = {
  content: 'smile', bowing: 'shut', dragged: 'flustered', squeeze: 'shut', waking: 'half',
};
// Keep the host's movement and expression timing. This outfit shows the
// expression in the visor only, apart from the blade's authored slash arc.
const DISABLE_NATIVE_PARTICLES = 'svg.kit > g:last-child{display:none}';

function sampleAt(clip, time) {
  for (const sample of clip) {
    if (time < sample[1]) return sample;
    time -= sample[1];
  }
  return clip.at(-1);
}

function makeLayer(doc, kind, layout, scale) {
  const viewport = doc.createElementNS(SVG, 'svg');
  viewport.dataset.layer = kind;
  viewport.setAttribute('overflow', 'hidden');
  const image = doc.createElementNS(SVG, 'image');
  image.setAttribute('crossorigin', 'anonymous');
  image.setAttribute('width', layout.size[0]);
  image.setAttribute('height', layout.size[1]);
  viewport.append(image);
  let previous, shown;
  return {
    viewport,
    source(url) { if (image.getAttribute('href') !== url) image.setAttribute('href', url); },
    frame(id, twin = false) {
      const visible = Boolean(id);
      if (visible !== shown) { viewport.style.display = visible ? '' : 'none'; shown = visible; }
      if (!id || previous === id) return;
      previous = id;
      const { rect, offset } = layout.frames[id];
      const [,, w, h] = rect;
      const [x, y] = offset;
      const sx = twin ? .7 : 1, sy = twin ? .58 : 1;
      viewport.dataset.frame = id;
      viewport.setAttribute('viewBox', rect.join(' '));
      viewport.setAttribute('preserveAspectRatio', 'none');
      viewport.setAttribute('width', (w * scale * sx).toFixed(3));
      viewport.setAttribute('height', (h * scale * sy).toFixed(3));
      viewport.setAttribute('x', (128 + (x + w * (1 - sx) * .5) * scale).toFixed(3));
      viewport.setAttribute('y', (256 + (y - (twin ? 55 : 0)) * scale).toFixed(3));
    },
  };
}

const SLASH_STYLES = ['mint', 'red', 'blue', 'steel', 'rune', 'sunleaf'];
const SLASH_CELL = { width: 96, height: 114, gap: 2, x: 177, y: 36, pixel: 2 };

function slashPhase(ms, reducedMotion) {
  if (reducedMotion) return ms >= 0 && ms < 80 ? 1 : -1;
  if (ms < -54 || ms >= 223) return -1;
  if (ms < 0) return 0;
  if (ms < 56) return 1;
  return ms < 130 ? 2 : 3;
}

function makeSlashLayer(doc, url) {
  const { width, height, gap, x, y, pixel } = SLASH_CELL;
  const viewport = doc.createElementNS(SVG, 'svg');
  viewport.dataset.layer = 'slash-effect';
  viewport.setAttribute('aria-hidden', 'true');
  viewport.setAttribute('overflow', 'hidden');
  viewport.setAttribute('x', x);
  viewport.setAttribute('y', y);
  viewport.setAttribute('width', width * pixel);
  viewport.setAttribute('height', height * pixel);
  viewport.style.display = 'none';
  viewport.style.pointerEvents = 'none';
  const image = doc.createElementNS(SVG, 'image');
  image.setAttribute('crossorigin', 'anonymous');
  image.setAttribute('width', (width + gap) * SLASH_STYLES.length);
  image.setAttribute('height', (height + gap) * 4);
  image.setAttribute('href', url);
  image.style.imageRendering = 'pixelated';
  viewport.append(image);

  let previousStyle, previousPhase = -1;
  return {
    viewport,
    get visible() { return previousPhase >= 0; },
    draw(style, phase) {
      if (previousStyle === style && previousPhase === phase) return;
      previousStyle = style;
      previousPhase = phase;
      viewport.style.display = phase < 0 ? 'none' : '';
      viewport.dataset.phase = phase;
      viewport.dataset.style = style;
      if (phase < 0) return;
      const column = Math.max(0, SLASH_STYLES.indexOf(style));
      viewport.setAttribute('viewBox', [column * (width + gap), phase * (height + gap), width, height].join(' '));
    },
  };
}

function makeBodyPaint(doc, layouts, scale) {
  const viewport = doc.createElementNS(SVG, 'svg');
  viewport.dataset.layer = 'body';
  viewport.setAttribute('overflow', 'hidden');
  const slot = doc.createElementNS(SVG, 'foreignObject');
  const canvas = doc.createElement('canvas');
  canvas.style.display = 'block';
  const painter = canvas.getContext('2d');
  slot.append(canvas);
  viewport.append(slot);
  let bodyImage, bladeImage, lastBody, lastBlade, lastEye, lastX, lastY;
  return {
    viewport,
    source(body, blade, palette, variant) {
      bodyImage = body;
      bladeImage = blade;
      viewport.dataset.palette = palette;
      viewport.dataset.blade = variant;
      lastBody = null;
    },
    frame(id, bladeId, eyeId, gazeX, gazeY) {
      if (lastBody === id && lastBlade === bladeId && lastEye === eyeId && lastX === gazeX && lastY === gazeY) return;
      const changed = lastBody !== id;
      lastBody = id;
      lastBlade = bladeId;
      lastEye = eyeId;
      lastX = gazeX;
      lastY = gazeY;
      const body = layouts.body.frames[id];
      const [,, w, h] = body.rect;
      const [x, y] = body.offset;
      if (changed) {
        viewport.dataset.frame = id;
        viewport.setAttribute('viewBox', `0 0 ${w} ${h}`);
        viewport.setAttribute('width', (w * scale).toFixed(3));
        viewport.setAttribute('height', (h * scale).toFixed(3));
        viewport.setAttribute('x', (128 + x * scale).toFixed(3));
        viewport.setAttribute('y', (256 + y * scale).toFixed(3));
        slot.setAttribute('width', w);
        slot.setAttribute('height', h);
      }
      viewport.dataset.eyes = eyeId ?? '';
      viewport.dataset.gaze = `${gazeX},${gazeY}`;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      } else {
        painter.clearRect(0, 0, w, h);
      }
      // Join the two pieces at their source resolution before any screen
      // scaling. This keeps a blade recolour from introducing alpha seams.
      painter.drawImage(bodyImage, ...body.rect, 0, 0, w, h);
      const blade = layouts.blade.frames[bladeId];
      const [bx, by] = blade.offset;
      const [,, bw, bh] = blade.rect;
      painter.drawImage(bladeImage, ...blade.rect, bx - x, by - y, bw, bh);
      if (eyeId) {
        const eye = layouts.body.frames[eyeId];
        const [ex, ey] = eye.offset;
        const [,, ew, eh] = eye.rect;
        painter.drawImage(bodyImage, ...eye.rect, ex - x + gazeX, ey - y + gazeY, ew, eh);
      }
    },
  };
}

export async function createHeavyBlade(_base, { model, scheme, host, kit, asset, loadImage }) {
  const doc = host.root.ownerDocument;
  const reducedMotion = doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)');
  const { layouts, clips, colors, scale, guardMs, moods } = model;
  const art = doc.createElementNS(SVG, 'g');
  art.dataset.phase = 'normal';
  const bodyArt = makeBodyPaint(doc, layouts, scale);
  const halo = makeLayer(doc, 'halo', layouts.halo, scale);
  const upperHalo = makeLayer(doc, 'upper-halo', layouts.halo, scale);
  const slashAtlasUrl = asset('art/slash-effects.png').href;
  const slash = makeSlashLayer(doc, slashAtlasUrl);
  const textures = new Map();
  let activeHalo = 'single', color = colors.mint, request = 0, currentFrame = 'attack4';
  let activeBlade = 'mint', elapsed = null, faceName = null, faceSince = 0;

  function facePose(frame) {
    if (faceName !== frame.face) {
      faceName = frame.face;
      faceSince = frame.t;
    }
    const mood = moods[faceName];
    const staged = mood && faceName !== 'neutral';
    if (frame.mode === 'sleep') return ['sleep', 0, 0];
    // The native eye-shape swap would overwrite the poses drawn for the start
    // and finish of each expression. The ordinary idle blink remains native.
    const closure = staged ? 0 : Math.max(frame.blink, frame.eyeClose);
    if (closure >= .76) return ['shut', 0, 0];
    if (closure >= .29) return ['half', 0, 0];
    if (staged) {
      if (reducedMotion.matches) return [mood.hero, 0, 0];
      const [pose,, x, y] = sampleAt(mood.stages, (frame.t - faceSince) * 1000);
      return [pose, x, y];
    }
    const track = !reducedMotion.matches;
    return [STATE_EYES[faceName] ?? 'open',
      track ? Math.round(Math.round(frame.look[0] / 1.5) * 1.5 / scale) : 0,
      track ? Math.round(Math.round(frame.look[1] / 2) * 1.5 / scale) : 0];
  }

  async function texture(kind, tint) {
    const url = asset(`art/${kind}-${tint}.png`).href;
    if (!textures.has(url)) {
      textures.set(url, loadImage(url).then(image => ({ image, url }), error => { textures.delete(url); throw error; }));
    }
    return textures.get(url);
  }

  async function applyScheme(id) {
    const [bodyTint, bladeTint, haloStyle, haloTint] = String(id ?? '').split('-');
    const chosenBody = Object.hasOwn(colors, bodyTint) ? bodyTint : 'mint';
    const chosenBlade = Object.hasOwn(colors, bladeTint) || ['steel', 'rune'].includes(bladeTint) ? bladeTint : 'mint';
    const chosenHalo = ['twin', 'none'].includes(haloStyle) ? haloStyle : 'single';
    const chosenHaloTint = Object.hasOwn(colors, haloTint) ? haloTint : 'mint';
    const ticket = ++request;
    const [body, blade, ring] = await Promise.all([
      texture('body', chosenBody), texture('blade', chosenBlade),
      chosenHalo === 'none' ? null : texture('halo', chosenHaloTint),
    ]);
    if (request !== ticket) return;
    bodyArt.source(body.image, blade.image, chosenBody, chosenBlade);
    if (ring) { halo.source(ring.url); upperHalo.source(ring.url); }
    activeHalo = chosenHalo;
    activeBlade = chosenBlade;
    color = colors[chosenBody];
  }

  const slashMs = clips.attack.reduce((sum, [, ms]) => sum + ms, guardMs);
  const impactAt = guardMs + clips.attack[0][1] + clips.attack[1][1];
  const walkMs = clips.walk.reduce((sum, [, ms]) => sum + ms, 0);
  const poseExtent = id => {
    const { offset: [x, y], rect: [,, w, h] } = layouts.body.frames[id];
    return [128 + x * scale, 256 + y * scale - (activeHalo === 'twin' ? 23 : 0),
      128 + (x + w) * scale, 256 + (y + h) * scale];
  };

  const figure = {
    anchors: { gaze: [139, 160], tears: [[120, 175], [153, 175]], tear: [153, 175], z: [167, 71],
      hearts: [90, 172, 51], bubble: [107, 24] },
    hits: [[98, 155, 62], [124, 202, 49], [166, 217, 32]],
    get extent() {
      const bounds = poseExtent(currentFrame);
      if (slash.visible) {
        const { width, height, x, y, pixel } = SLASH_CELL;
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x + width * pixel);
        bounds[3] = Math.max(bounds[3], y + height * pixel);
      }
      return bounds;
    },
    get colors() { return { z: color }; },
    groupTilt(mode, tilt, lean) {
      return mode === 'walk' || mode === 'run' ? tilt + lean * .15 : tilt + lean;
    },
    gestures: [SLASH],
    setScheme: applyScheme,
    draw(group, _face, frame) {
      if (!art.parentNode) {
        art.append(upperHalo.viewport, bodyArt.viewport, slash.viewport, halo.viewport);
        group.append(art);
      }
      const attack = elapsed !== null && frame.gesture?.kind === SLASH && frame.mode === 'idle';
      const attackTime = attack ? frame.gesture.k * slashMs : 0;
      const bracing = attack && attackTime < guardMs;
      const phase = bracing ? 'brace' : attack ? 'slash' : 'normal';
      if (art.dataset.phase !== phase) {
        art.dataset.phase = phase;
        art.setAttribute('transform', bracing && !reducedMotion.matches ? 'translate(0 6) scale(1 .97656)' : '');
      }
      const moving = frame.mode === 'walk' || frame.mode === 'run';
      const index = frame.modeT * (frame.mode === 'run' ? 1350 : 1000);
      currentFrame = attack && !bracing ? sampleAt(clips.attack, attackTime - guardMs)[0]
        : moving ? sampleAt(clips.walk, index % walkMs)[0] : 'attack4';
      const expressive = (!attack || bracing) && !moving;
      const bodyFrame = expressive ? 'idle' : currentFrame;
      const [eyes, dx, dy] = bracing ? ['determined', 0, 0] : expressive ? facePose(frame) : [null, 0, 0];
      bodyArt.frame(bodyFrame, currentFrame, eyes, dx, dy);
      slash.draw(activeBlade, attack ? slashPhase(attackTime - impactAt, reducedMotion.matches) : -1);
      halo.frame(activeHalo === 'single' || activeHalo === 'twin' ? currentFrame : null);
      upperHalo.frame(activeHalo === 'twin' ? currentFrame : null, true);
    },
  };

  await Promise.all([applyScheme(scheme ?? host.start?.skin?.scheme), loadImage(slashAtlasUrl)]);
  const words = Object.fromEntries(Object.entries(moods).map(([name, mood]) =>
    [name, { expression: { like: name, seconds: mood.seconds } }]));
  words[SLASH] = { motion: { seconds: slashMs / 1000 } };
  const body = kit.createBody(host, { figure, css: DISABLE_NATIVE_PARTICLES, words });
  body.words = [...new Set(body.words)];
  const { step, do: doWord } = body;
  body.do = word => {
    if (word !== SLASH) {
      const accepted = doWord(word);
      if (accepted && Object.hasOwn(moods, word)) faceName = null;
      return accepted;
    }
    const mode = body.layout().mode;
    if (elapsed !== null || ['drag', 'air', 'crouch', 'sleep', 'sit'].includes(mode)) return false;
    if (!doWord(word)) return false;
    body.set({ hold: slashMs / 1000 + .16 });
    elapsed = 0;
    return true;
  };
  body.step = (dt, draw = true) => {
    step(dt, draw);
    if (elapsed === null) return;
    const previous = elapsed;
    elapsed += dt * 1000;
    const mode = body.layout().mode;
    if (mode !== 'idle') { elapsed = null; return; }
    if (draw && previous < impactAt && elapsed >= impactAt) host.sound('heavyimpact', 'move');
    if (elapsed >= slashMs) { elapsed = null; host.emit('done', { word: SLASH }); }
  };
  return body;
}
