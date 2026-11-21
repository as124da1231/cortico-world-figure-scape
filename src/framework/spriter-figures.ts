import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { PNG } from 'pngjs';
import { SaxesParser } from 'saxes';
import { FIGURE_API, MANIFEST_VERSION } from '../packs.ts';
import { INLINE_TAG_MAX } from '../script.ts';
import { spriterPose, type SpriterClip, type SpriterKey, type SpriterModel, type SpriterRef } from '../../web/spriter-body.js';

type Xml = { tag: string; attrs: Record<string, string>; children: Xml[] };
type Layer = ReturnType<typeof spriterPose>[number];
const MiB = 1024 * 1024;
const RENDERER = new URL('../../web/spriter-body.js', import.meta.url);
const RADIANS = Math.PI / 180;
const invalid = (detail: string) => Error('Spriter：' + detail);
const children = (node: Xml, tag: string) => node.children.filter(child => child.tag === tag);

function one(node: Xml, tag: string) {
  const list = children(node, tag);
  if (list.length !== 1) throw invalid('缺少或重复的 ' + tag);
  return list[0];
}

function parseXml(value: string) {
  const root: Xml = { tag: '', attrs: {}, children: [] };
  const stack = [root];
  let elements = 0;
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw invalid('不支持 DTD'); });
  parser.on('error', error => { throw invalid(error.message); });
  parser.on('opentag', ({ name, attributes }) => {
    if (stack.length > 16 || ++elements > 60_000) throw invalid('工程结构超过上限');
    const node = { tag: name, attrs: attributes, children: [] };
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on('closetag', () => { stack.pop(); });
  parser.write(value).close();
  return one(root, 'spriter_data');
}

function number(node: Xml, field: string, fallback: number | undefined, min: number, max: number) {
  const text = node.attrs[field];
  const value = text === undefined ? fallback : text.trim() ? Number(text) : NaN;
  if (value === undefined || !Number.isFinite(value) || value < min || value > max) throw invalid(node.tag + ' 的 ' + field + ' 无效');
  return value;
}

function integer(node: Xml, field: string, fallback?: number, min = 0, max = 1_000_000) {
  const value = number(node, field, fallback, min, max);
  if (!Number.isInteger(value)) throw invalid(node.tag + ' 的 ' + field + ' 需要整数');
  return value;
}

function indexed(nodes: Xml[]) {
  const byId = new Map<number, Xml>();
  for (const node of nodes) {
    const id = integer(node, 'id');
    if (byId.has(id)) throw invalid(node.tag + ' 的编号重复');
    byId.set(id, node);
  }
  return byId;
}

async function boundedFile(path: string, limit: number, signal: AbortSignal) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || !info.size || info.size > limit) throw invalid('文件大小超过上限：' + basename(path));
    const data = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < data.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(data, offset, Math.min(MiB, data.length - offset), offset);
      if (!bytesRead) throw invalid('读取时文件发生变化：' + basename(path));
      offset += bytesRead;
    }
    return data;
  } finally { await handle.close(); }
}

async function imagePath(root: string, name: string) {
  const parts = name.split(/[/\\]/);
  if (parts.length > 16 || parts.some(part => !part || part === '.' || part === '..' ||
    /[<>:"|?*\u0000-\u001f]|[. ]$/.test(part)) || !/\.png$/i.test(name)) {
    throw invalid('图片需要是工程目录内的 PNG：' + name);
  }
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw invalid('图片路径含文件链接：' + name);
  }
  const resolved = await realpath(path).catch(() => { throw invalid('找不到图片：' + name); });
  const subpath = relative(root, resolved);
  if (!subpath || isAbsolute(subpath) || subpath.startsWith('..' + sep)) throw invalid('图片超出工程目录：' + name);
  return resolved;
}

const curveControls = { linear: 0, quadratic: 1, cubic: 2, quartic: 3, quintic: 4 } as const;
function timelineKey(node: Xml, length: number, sprite: (node: Xml) => number): SpriterKey {
  const target = node.children.find(part => part.tag === 'bone' || part.tag === 'object');
  if (!target) throw invalid('时间线缺少骨骼或贴图');
  const kind = node.attrs.curve_type ?? 'linear';
  if (kind !== 'instant' && !Object.hasOwn(curveControls, kind)) throw invalid('暂不支持的缓动曲线：' + kind);
  const curve = kind === 'instant' ? kind : Array.from({length: curveControls[kind as keyof typeof curveControls]},
    (_, i) => number(node, 'c' + (i + 1), 0, -2, 3));
  const angle = number(target, 'angle', 0, -360_000, 360_000);
  const key: SpriterKey = {
    time: integer(node, 'time', 0, 0, length), spin: integer(node, 'spin', 1, -1, 1), curve,
    x: number(target, 'x', 0, -100_000, 100_000), y: number(target, 'y', 0, -100_000, 100_000),
    angle: ((angle % 360) + 360) % 360,
    sx: number(target, 'scale_x', 1, -128, 128), sy: number(target, 'scale_y', 1, -128, 128),
    alpha: number(target, 'a', 1, 0, 1),
  };
  if (target.tag === 'bone') return key;
  return { ...key, sprite: sprite(target),
    ...(target.attrs.pivot_x === undefined ? {} : { px: number(target, 'pivot_x', undefined, -8, 8) }),
    ...(target.attrs.pivot_y === undefined ? {} : { py: number(target, 'pivot_y', undefined, -8, 8) }),
  };
}

function parseClip(animation: Xml, sprite: (node: Xml) => number): SpriterClip {
  const length = integer(animation, 'length', undefined, 1, 120_000);
  const tracks: SpriterKey[][] = [];
  const indices = new Map<number, { track: number; keys: Map<number, number> }>();
  const auxiliary = new Set<number>();
  for (const [id, timeline] of indexed(children(animation, 'timeline'))) {
    const type = timeline.attrs.object_type ?? timeline.attrs.type ?? 'sprite';
    if (type !== 'sprite' && type !== 'bone') { auxiliary.add(id); continue; }
    const keys = [...indexed(children(timeline, 'key'))].map(([id, node]) => ({ id, key: timelineKey(node, length, sprite) }));
    keys.sort((a, b) => a.key.time - b.key.time);
    if (!keys.length || keys.some(({key}, i) => i > 0 && key.time === keys[i - 1].key.time) ||
        keys.some(({key}) => (key.sprite === undefined) !== (keys[0].key.sprite === undefined))) {
      throw invalid('时间线的关键帧重复或层类型发生变化');
    }
    indices.set(id, { track: tracks.length, keys: new Map(keys.map(({id}, i) => [id, i])) });
    tracks.push(keys.map(({key}) => key));
  }
  const main = [...indexed(children(one(animation, 'mainline'), 'key')).values()].map(node => {
    const bones: SpriterRef[] = [];
    const bonesById = indexed(children(node, 'bone_ref'));
    const resolved = new Map<number, number>();
    const visiting = new Set<number>();
    function parent(ref: Xml, depth: number): number {
      const id = integer(ref, 'parent', -1, -1);
      if (id === -1) return -1;
      if (depth > 32 || visiting.has(id) || !bonesById.has(id)) throw invalid('骨骼层级无效');
      if (!resolved.has(id)) addBone(id, bonesById.get(id)!, depth + 1);
      return resolved.get(id)!;
    }
    function reference(ref: Xml, parentIndex: number, bone: boolean): SpriterRef | null {
      const timeline = integer(ref, 'timeline');
      const source = indices.get(timeline);
      if (!bone && auxiliary.has(timeline)) return null;
      const key = source?.keys.get(integer(ref, 'key'));
      if (!source || key === undefined || (tracks[source.track][key].sprite === undefined) !== bone) {
        throw invalid('关键帧引用无效');
      }
      return { track: source.track, key, parent: parentIndex };
    }
    function addBone(id: number, ref: Xml, depth: number) {
      visiting.add(id);
      const bone = reference(ref, parent(ref, depth), true)!;
      resolved.set(id, bones.length);
      bones.push(bone);
      visiting.delete(id);
    }
    for (const [id, ref] of bonesById) if (!resolved.has(id)) addBone(id, ref, 0);
    const parts = [...indexed(children(node, 'object_ref')).values()]
      .map(ref => ({ ref, z: integer(ref, 'z_index', 0, -1_000_000) })).sort((a,b) => a.z - b.z)
      .map(({ref}) => reference(ref, parent(ref, 0), false)).filter(part => part !== null);
    if (bones.length > 128 || parts.length > 128) throw invalid('单帧层数超过上限');
    return { time: integer(node, 'time', 0, 0, length), bones, parts };
  }).sort((a, b) => a.time - b.time);
  if (main[0]?.time !== 0 || !main.some(key => key.parts.length) || main.some((key, i) => i > 0 && key.time === main[i-1].time)) {
    throw invalid('动作需要从 0 开始，并包含可用的贴图层');
  }
  return { length, loop: animation.attrs.looping !== 'false', tracks, main };
}

function layerBox(part: Layer, art: PNG) {
  const c = Math.cos(part.angle * RADIANS), s = Math.sin(part.angle * RADIANS);
  const xs: number[] = [], ys: number[] = [];
  for (const x of [part.left, part.left + art.width]) for (const y of [part.top, part.top + art.height]) {
    xs.push(part.x + c * x * part.sx + s * y * part.sy);
    ys.push(part.y + s * x * part.sx - c * y * part.sy);
  }
  return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys), c, s };
}

/** Compose a small thumbnail from the same pose and drawing order as the body. */
function coverAndFraming(layers: Layer[], art: PNG[]) {
  const visible = layers.filter(part => part.alpha > 0 && part.sx && part.sy)
    .map(part => ({ part, art: art[part.sprite], box: layerBox(part, art[part.sprite]) }));
  const left = Math.min(...visible.map(layer => layer.box.left));
  const right = Math.max(...visible.map(layer => layer.box.right));
  const bottom = Math.min(...visible.map(layer => layer.box.bottom));
  const top = Math.max(...visible.map(layer => layer.box.top));
  const width = right - left, height = top - bottom;
  if (!(width > 0 && height > 0) || Math.max(width, height) > 100_000) throw invalid('待机首帧没有可用的角色范围');
  const thumbnailScale = 212 / Math.max(width, height);
  const cover = new PNG({width: 224, height: 224});
  const x0 = (224 - width * thumbnailScale) / 2, y0 = (224 - height * thumbnailScale) / 2;
  for (const { part, art, box } of visible) {
    const startX = Math.max(0, Math.floor(x0 + (box.left - left) * thumbnailScale));
    const endX = Math.min(224, Math.ceil(x0 + (box.right - left) * thumbnailScale));
    const startY = Math.max(0, Math.floor(y0 + (top - box.top) * thumbnailScale));
    const endY = Math.min(224, Math.ceil(y0 + (top - box.bottom) * thumbnailScale));
    for (let y = startY; y < endY; y++) for (let x = startX; x < endX; x++) {
      const dx = left + (x + .5 - x0) / thumbnailScale - part.x;
      const dy = top - (y + .5 - y0) / thumbnailScale - part.y;
      const ix = Math.floor((box.c * dx + box.s * dy) / part.sx - part.left);
      const iy = Math.floor((box.s * dx - box.c * dy) / part.sy - part.top);
      if (ix < 0 || ix >= art.width || iy < 0 || iy >= art.height) continue;
      const source = (iy * art.width + ix) * 4, target = (y * cover.width + x) * 4;
      const alpha = art.data[source + 3] / 255 * part.alpha;
      const below = cover.data[target + 3] / 255 * (1 - alpha), composite = alpha + below;
      if (!alpha) continue;
      for (let c = 0; c < 3; c++) cover.data[target + c] = Math.round((art.data[source + c] * alpha + cover.data[target + c] * below) / composite);
      cover.data[target + 3] = Math.round(composite * 255);
    }
  }
  if (!cover.data.some((alpha, i) => i % 4 === 3 && alpha > 0)) throw invalid('待机图像完全透明');
  const scale = Math.min(210 / height, 204 / width);
  return { cover: PNG.sync.write(cover),
    framing: {scale, x: 128 - (left + right) / 2 * scale, y: 256 + bottom * scale,
      extent: [128 - width * scale / 2, 256 - height * scale, 128 + width * scale / 2, 256]},
  };
}

export async function writeSpriterFigure(file: string, output: string, signal: AbortSignal) {
  if ((await lstat(file)).isSymbolicLink()) throw invalid('请选择原始工程文件');
  const source = await realpath(file);
  const xml = await boundedFile(source, 4 * MiB, signal);
  const root = parseXml(xml.toString('utf8'));
  const entities = children(root, 'entity');
  if (entities.length !== 1) throw invalid('请选择只包含一个角色的 SCML 工程');
  const entity = entities[0];
  const name = entity.attrs.name?.trim().slice(0, 80) || basename(source, '.scml');
  const model: SpriterModel = { sprites: [], maps: {}, clips: {}, modes: {} };
  const lookup = new Map<string, number>();
  const spriteIndex = (node: Xml, folder = 'folder', file = 'file') => {
    const id = lookup.get(integer(node, folder) + ':' + integer(node, file));
    if (id === undefined) throw invalid('动作或装扮引用了不存在的图片');
    return id;
  };
  const art: PNG[] = [];
  let pixels = 0, bytes = 0;
  for (const [folder, node] of indexed(children(root, 'folder'))) {
    for (const [id, item] of indexed(children(node, 'file'))) {
      const path = item.attrs.name ?? '';
      if ((item.attrs.type === 'sound' || /\.(?:ogg|wav|mp3)$/i.test(path))) continue;
      if (art.length >= 256) throw invalid('贴图数量超过上限');
      const image = await boundedFile(await imagePath(dirname(source), path), 16 * MiB, signal);
      bytes += image.length;
      if (bytes > 64 * MiB || image.length < 33 || image.readBigUInt64BE() !== 0x89504e470d0a1a0an ||
          image.toString('ascii', 12, 16) !== 'IHDR') throw invalid('贴图大小超限或 PNG 损坏：' + path);
      const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
      pixels += width * height;
      if (!width || !height || width > 2048 || height > 2048 || pixels > 12_000_000) throw invalid('贴图像素超过上限：' + path);
      let decoded: PNG;
      try { decoded = PNG.sync.read(image); } catch { throw invalid('PNG 损坏：' + path); }
      const file = 'sprite-' + art.length + '.png';
      lookup.set(folder + ':' + id, art.length);
      art.push(decoded);
      model.sprites.push({file, width, height, px: number(item, 'pivot_x', 0, -8, 8), py: number(item, 'pivot_y', 1, -8, 8)});
      await writeFile(join(output, file), image, {signal});
    }
  }
  const outfits = [{id:'original', name:{zh:'原版', en:'Original'}}];
  const maps = indexed(children(entity, 'character_map'));
  if (maps.size > 48) throw invalid('装扮数量超过上限');
  for (const [id, outfit] of maps) {
    const key = 'map' + id, label = outfit.attrs.name?.trim().slice(0,80) || String(id);
    const mapping: Record<number, number> = {};
    for (const map of children(outfit, 'map')) {
      const sourceIndex = spriteIndex(map);
      const target = integer(map, 'target_folder', -1, -1);
      mapping[sourceIndex] = target === -1 ? -1 : spriteIndex(map, 'target_folder', 'target_file');
    }
    model.maps[key] = mapping;
    outfits.push({id:key, name:{zh:label, en:label}});
  }
  const vocabulary = [];
  const animations = indexed(children(entity, 'animation'));
  if (!animations.size || animations.size > 120) throw invalid('动作数量超出范围');
  const names = new Set(['stand','walk','run','sit','站立','走路','跑步','坐下','Stand','Walk','Run','Sit',
    ...[...animations.keys()].map(id => 'spriter-' + id)]);
  for (const [id, animation] of animations) {
    signal.throwIfAborted();
    const word = 'spriter-' + id, label = animation.attrs.name?.trim().slice(0,80) || 'Animation ' + id;
    const clip = parseClip(animation, spriteIndex);
    model.clips[word] = clip;
    const alias = label.replace(/[\s,，、【】<>＜＞]+/g, '');
    const useAlias = alias && alias.length <= INLINE_TAG_MAX && !names.has(alias);
    const locale = /[\u3400-\u9fff]/.test(alias) ? 'zh' : 'en';
    if (useAlias) names.add(alias);
    vocabulary.push({id:word, kind:'expression', seconds:clip.length / 1000,
      about:{zh:label, en:label}, ...(useAlias ? {names:{[locale]:[alias]}} : {}),
    });
    const stem = label.toLowerCase().replace(/[-_ ]loop$/, '');
    if (['idle','stand','walk','run','sit','talk'].includes(stem)) model.modes[stem === 'stand' ? 'idle' : stem] ??= word;
  }
  model.modes.idle ??= Object.keys(model.clips)[0];
  const idle = model.clips[model.modes.idle];
  const pose = idle.main.map(key => key.time).find(time => spriterPose(model, idle, time).some(part => part.alpha > 0 && part.sx && part.sy));
  if (pose === undefined) throw invalid('待机动作没有可见贴图');
  const { cover, framing } = coverAndFraming(spriterPose(model, idle, pose), art);
  const walk = !!(model.modes.walk || model.modes.run);
  const motion = (id: string, zh: string, en: string, seconds: number) => ({
    id, kind:'motion', seconds, names:{zh:[zh],en:[en]}, about:{zh,en},
  });
  const vocab = [
    motion('stand','站立','Stand',.35),
    ...(walk ? [motion('walk','走路','Walk',2.5),motion('run','跑步','Run',1.8)] : []),
    ...(model.modes.sit ? [motion('sit','坐下','Sit',1.5)] : []), ...vocabulary,
  ];
  const manifest = { manifest:MANIFEST_VERSION, api:FIGURE_API, source:'spriter',
    id:'spriter-' + createHash('sha256').update(xml).digest('hex').slice(0,16),
    name:{zh:name, en:name}, about:{zh:'从 Spriter SCML 工程导入的分层角色。', en:'A layered character imported from a Spriter SCML project.'},
    entry:'figure.js', export:'createSpriterBody', model:'spriter.json', thumb:'cover.png', can:{walk}, vocab,
    axes:outfits.length > 1 ? [{id:'outfit', name:{zh:'装扮',en:'Outfit'}, options:outfits}] : [],
    presets:outfits.length > 1 ? outfits.map(outfit => ({...outfit,pick:{outfit:outfit.id}})) : [],
  };
  await writeFile(join(output,'figure.js'), await readFile(RENDERER, {signal}), {signal});
  await writeFile(join(output,'cover.png'), cover, {signal});
  await writeFile(join(output,'spriter.json'), JSON.stringify({...model,framing}), {signal});
  await writeFile(join(output,'figure.json'), JSON.stringify(manifest), {signal});
}
