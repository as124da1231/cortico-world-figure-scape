const SVG = 'http://www.w3.org/2000/svg';
const RADIANS = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;

function curveValue(curve, t) {
  if (curve === 'instant') return 0;
  if (!curve.length) return t;
  const points = [0, ...curve, 1];
  for (let n = points.length - 1; n > 0; n--) {
    for (let i = 0; i < n; i++) points[i] = lerp(points[i], points[i + 1], t);
  }
  return points[0];
}

function keyAt(keys, time) {
  let low = 0, high = keys.length;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (keys[mid].time <= time) low = mid;
    else high = mid;
  }
  return keys[low];
}

function localPose(ref, clip, time, sprites, map) {
  const keys = clip.tracks[ref.track], start = keys[ref.key];
  const end = keys[ref.key + 1] ?? (clip.loop && keys.length > 1 ? keys[0] : start);
  const endTime = end.time + (end.time < start.time ? clip.length : 0);
  const elapsed = time + (time < start.time && clip.loop && endTime > clip.length ? clip.length : 0);
  const t = endTime > start.time ? curveValue(start.curve, Math.max(0, Math.min(1, (elapsed - start.time) / (endTime - start.time)))) : 0;
  const delta = end.angle - start.angle;
  const turn = start.spin === 0 ? 0 : delta + (start.spin * delta < 0 ? 360 * start.spin : 0);
  const part = {
    x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t), angle: start.angle + turn * t,
    sx: lerp(start.sx, end.sx, t), sy: lerp(start.sy, end.sy, t), alpha: lerp(start.alpha, end.alpha, t),
  };
  if (start.sprite === undefined) return part;
  const sprite = map[start.sprite] ?? start.sprite;
  if (sprite < 0) return null;
  const art = sprites[sprite];
  const nextArt = sprites[map[end.sprite] ?? end.sprite] ?? art;
  return { ...part, sprite,
    left: -(start.px === undefined ? art.px : lerp(start.px, end.px ?? nextArt.px, t)) * art.width,
    top: ((start.py === undefined ? art.py : lerp(start.py, end.py ?? nextArt.py, t)) - 1) * art.height,
  };
}

function transform(part, parent) {
  if (!parent) return part;
  const c = Math.cos(parent.angle * RADIANS), s = Math.sin(parent.angle * RADIANS);
  const x = part.x * parent.sx, y = part.y * parent.sy;
  return { ...part,
    x: parent.x + x * c - y * s, y: parent.y + x * s + y * c,
    angle: parent.angle + (parent.sx * parent.sy < 0 ? -part.angle : part.angle),
    sx: parent.sx * part.sx, sy: parent.sy * part.sy, alpha: parent.alpha * part.alpha,
  };
}

/** Resolve a mainline key into ordered, world-space sprite layers. Time is in milliseconds. */
export function spriterPose(model, clip, elapsed, scheme = '') {
  const time = clip.loop ? Math.max(0, elapsed) % clip.length : Math.max(0, Math.min(clip.length, elapsed));
  const key = keyAt(clip.main, time), bones = [];
  const map = model.maps[scheme] ?? {};
  for (const ref of key.bones) bones.push(transform(localPose(ref, clip, time, model.sprites, map), bones[ref.parent]));
  return key.parts.flatMap(ref => {
    const pose = localPose(ref, clip, time, model.sprites, map);
    return pose ? [transform(pose, bones[ref.parent])] : [];
  });
}

export async function createSpriterBody(_base, {host, kit, model, scheme, asset, loadImage}) {
  const images = await Promise.all(model.sprites.map(sprite => loadImage(asset(sprite.file))));
  const doc = host.root.ownerDocument;
  const mount = doc.createElementNS(SVG, 'foreignObject');
  mount.setAttribute('x', '-64');
  mount.setAttribute('y', '-64');
  mount.setAttribute('width', '384');
  mount.setAttribute('height', '384');
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = 768;
  canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none';
  const paint = canvas.getContext('2d');
  if (!paint) throw Error('Canvas 2D is unavailable');
  mount.append(canvas);

  const { clips, modes, framing } = model;
  const words = Object.fromEntries(Object.entries(clips)
    .map(([id, clip]) => [id, {expression:{like:'neutral', seconds:clip.length / 1000}}]));
  const [left, top, right, bottom] = framing.extent;
  let lastClip, lastTime, lastScheme, startedAt = 0;
  return kit.createBody(host, {
    words,
    figure: {
      extent: framing.extent,
      hits: [.16,.38,.61,.83].map(y => [(left + right) / 2, lerp(top, bottom, y), Math.min((right - left) * .46, (bottom - top) * .2)]),
      setScheme(id) { scheme = id; },
      draw(group, _face, frame) {
        if (!mount.parentNode) group.append(mount);
        const mode = ({ walk: modes.walk ?? modes.run, run: modes.run ?? modes.walk, sit: modes.sit })[frame.mode];
        const speaking = frame.talk > .12 && modes.talk;
        const id = mode ?? (words[frame.face] ? frame.face : undefined) ?? (speaking || modes.idle);
        if (id !== lastClip) startedAt = frame.t;
        const clip = clips[id];
        const elapsed = Math.floor(Math.max(0, frame.t - startedAt) * 60) * (1000 / 60);
        const time = clip.loop ? elapsed % clip.length : Math.min(clip.length, elapsed);
        if (lastClip === id && lastTime === time && lastScheme === scheme) return;
        lastClip = id;
        lastTime = time;
        lastScheme = scheme;
        paint.setTransform(1, 0, 0, 1, 0, 0);
        paint.clearRect(0, 0, canvas.width, canvas.height);
        paint.setTransform(2 * framing.scale, 0, 0, -2 * framing.scale, 2 * (64 + framing.x), 2 * (64 + framing.y));
        for (const part of spriterPose(model, clip, time, scheme)) {
          if (part.alpha <= 0 || !part.sx || !part.sy) continue;
          paint.save();
          paint.translate(part.x, part.y);
          paint.rotate(part.angle * RADIANS);
          paint.scale(part.sx, -part.sy);
          paint.globalAlpha = part.alpha;
          paint.drawImage(images[part.sprite], part.left, part.top);
          paint.restore();
        }
        mount.dataset.clip = id;
      },
    },
  });
}
