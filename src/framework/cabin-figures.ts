import { createHash } from 'node:crypto';
import { open, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { PNG } from 'pngjs';
import { MANIFEST_VERSION, FIGURE_API } from '../packs.ts';

type Row = Record<string, unknown>;
type Rect = [number, number, number, number];
type Point = [number, number];
type Clip = {
  file: string; rects: Rect[]; anchors: Point[]; frames: number; rows: number;
  scale: number; seconds: number; loop: boolean; holdFrame?: number; holdSeconds?: number;
};

const ASSETS = 'game/assets';
const RENDERER = new URL('../../web/cabin-sprite-body.js', import.meta.url);
const MOTIONS = [
  ['walk8', null], ['walk_tired', null], ['turn', null], ['sit_down', null], ['stand_up', null],
  ['lie_down', 'cabin-lie'], ['get_up', 'cabin-rise'], ['pick_up', 'cabin-pick'],
  ['idle_stretch', 'cabin-stretch'], ['idle_yawn', 'cabin-yawn'],
  ['idle_look', null], ['idle_phone', 'cabin-phone'],
  ['mood_happy', 'happy'], ['mood_sad', 'sad'], ['mood_tired', 'sleepy'],
  ['chat', null], ['sit_chat', null], ['high_five', 'cabin-high-five'], ['thinking', 'thinking'],
] as const;
const LABELS: Record<string, [string, string]> = {
  stand: ['站好', 'Stand'], walk: ['走路', 'Walk'], run: ['跑步', 'Run'], sit: ['坐下', 'Sit'],
  happy: ['开心', 'Happy'], sad: ['难过', 'Sad'], sleepy: ['犯困', 'Sleepy'], thinking: ['思考', 'Thinking'],
  'cabin-stretch': ['伸懒腰', 'Stretch'], 'cabin-yawn': ['打哈欠', 'Yawn'],
  'cabin-pick': ['捡东西', 'Pick up'], 'cabin-high-five': ['击掌', 'High five'],
  'cabin-lie': ['躺下', 'Lie down'], 'cabin-rise': ['从床上起来', 'Get up'], 'cabin-phone': ['看手机', 'Look at phone'],
};

function row(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function formatError() { return Error('无法读取小屋世界的角色素材。请选择带 game/assets 的 Cabin World 1.1 安装。'); }
function boundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && value >= min && value <= max;
}
function values(value: unknown, count: number, max: number, integer = false): number[] {
  if (!Array.isArray(value) || value.length !== count || value.some(x => !boundedNumber(x, 0, max) || integer && !Number.isInteger(x))) {
    throw formatError();
  }
  return value;
}

async function boundedFile(file: string | URL, limit: number) {
  const fd = await open(file, 'r');
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > limit) throw formatError();
    const bytes = Buffer.alloc(info.size);
    const {bytesRead} = await fd.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) throw formatError();
    return bytes;
  } finally { await fd.close(); }
}

async function sourceFile(base: string, name: string) {
  const file = await realpath(join(base, name));
  const path = relative(base, file);
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) throw formatError();
  return file;
}
async function readJson(base: string, name: string, optional = false) {
  try {
    return row(JSON.parse((await boundedFile(await sourceFile(base, name), 8 * 1024 * 1024)).toString('utf8').replace(/^\uFEFF/, '')));
  } catch (e) {
    if (optional && (e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) throw formatError();
    throw e;
  }
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(id);

async function cabinCatalog(root: string | undefined) {
  if (!root) throw Error('请先连接小屋世界的安装目录。');
  const realRoot = await realpath(root);
  const dir = await sourceFile(realRoot, ASSETS).catch(error => {
    if (error.code === 'ENOENT') throw formatError();
    throw error;
  });
  const [world, catalog] = await Promise.all([readJson(dir, 'world.json'), readJson(dir, 'residents.json')]);
  const actors = row(world.actors);
  if (!Array.isArray(catalog.residents)) throw formatError();
  const residents = catalog.residents.flatMap(value => {
    const {key, name, art} = row(value);
    if (!validId(key) || !validId(art) || typeof name !== 'string' || !name.trim() || !Object.hasOwn(actors, art) || !row(actors[art]).walk) return [];
    return [{key, name: name.trim().slice(0, 64), art}];
  });
  return {dir, residents, actors};
}

export async function cabinFigureSources(root: string | undefined) {
  const {residents} = await cabinCatalog(root);
  return residents.map(({key, name}) => ({key, name}));
}

function readPngSize(bytes: Buffer) {
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw formatError();
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  if (!w || !h || w > 4096 || h > 4096 || w*h > 12_000_000) throw formatError();
  return {w, h};
}

function cropCover(bytes: Buffer, [x, y, w, h]: Rect) {
  const image = PNG.sync.read(bytes);
  let left = w, right = 0, top = h, bottom = 0;
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
    if (image.data[((y + dy)*image.width + x + dx)*4 + 3] < 40) continue;
    left = Math.min(left, dx);
    right = Math.max(right, dx + 1);
    top = Math.min(top, dy);
    bottom = Math.max(bottom, dy + 1);
  }
  if (right <= left || bottom <= top) throw formatError();
  const cover = new PNG({width:right-left,height:bottom-top});
  PNG.bitblt(image, cover, x + left, y + top, cover.width, cover.height, 0, 0);
  return {png: PNG.sync.write(cover), bounds: [left,top,right,bottom] as Rect};
}

function validateClip(clip: Clip, image: ReturnType<typeof readPngSize>) {
  if (clip.rects.length !== clip.frames * clip.rows || clip.rects.length !== clip.anchors.length) throw formatError();
  clip.rects.forEach(([x,y,w,h], index) => {
    const [ax, ay] = clip.anchors[index]!;
    if (!w || !h || x + w > image.w || y + h > image.h || ax > w || ay > h) throw formatError();
  });
}

function originalClip(input: Row, file: string, frames: number, rows: number, scale: number, seconds: number): Clip {
  if (!Array.isArray(input.anchors)) throw formatError();
  const anchors = input.anchors.map(value => values(value, 2, 2048) as Point);
  const rects = Array.isArray(input.rects) ? input.rects.map(value => values(value, 4, 4096, true) as Rect)
    : anchors.map((_, i) => gridRect(input.cell, frames, i));
  return {file, rects, anchors, frames, rows, scale, seconds, loop:true};
}
function gridRect(cell: unknown, frames: number, i: number): Rect {
  if (!boundedNumber(cell, 1, 1024) || !Number.isInteger(cell)) throw formatError();
  return [i % frames * cell, Math.floor(i / frames) * cell, cell, cell];
}

/** Import the named resident's authored atlas. The loader is generated locally from trusted code. */
export async function writeCabinFigure(root: string | undefined, residentId: unknown, output: string, signal: AbortSignal) {
  const {dir, residents, actors} = await cabinCatalog(root);
  const resident = residents.find(item => item.key === residentId);
  if (!resident) throw Error('这位住户没有可导入的原版外观。');
  const art = row(actors[resident.art]);
  const baseScale = row(art.walk).scale;
  if (!boundedNumber(baseScale,.001,16)) throw formatError();

  const clips: Record<string, Clip> = {};
  const atlases = new Map<string, Buffer>();
  async function add(key: string, clip: Clip, source: unknown, optional = false) {
    signal.throwIfAborted();
    if (typeof source !== 'string' || !/^[a-zA-Z0-9_.-]+\.png$/.test(basename(source))) throw formatError();
    try {
      const image = await boundedFile(await sourceFile(dir, source), 24 * 1024 * 1024);
      validateClip(clip, readPngSize(image));
      atlases.set(clip.file, image);
      clips[key] = clip;
    } catch (e) {
      if (!optional || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  function sourceName(spec: Row) {
    const file = spec.file;
    if (typeof file !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.png$/.test(file)) throw formatError();
    return 'actors/' + file;
  }

  const walk = row(art.walk), walkClip = originalClip(walk,'walk.png',4,4,1,1/7);
  await add('walk', walkClip, sourceName(walk));
  if (art.yukata) {
    const spec = row(art.yukata), scale = spec.scale;
    if (!boundedNumber(scale,.001,16)) throw formatError();
    if (!Array.isArray(spec.anchors) || ![16,24].includes(spec.anchors.length)) throw formatError();
    await add('robe', originalClip(spec,'robe.png',4,spec.anchors.length/4,scale/baseScale,1/7), sourceName(spec));
  }
  if (art.actions) {
    const spec = row(art.actions), scale = spec.scale;
    if (!boundedNumber(scale,.001,16)) throw formatError();
    const clip = originalClip(spec,'actions.png',4,4,scale/baseScale,1/3);
    await add('actions', clip, sourceName(spec));
    clips.sit = {...clip, rows:1, rects:clip.rects.slice(0,4), anchors:clip.anchors.slice(0,4)};
  }
  const motion = await readJson(dir, 'actors/body-language.json', true);
  const specs = row(motion.sheets);
  for (const [key] of MOTIONS) {
    if (!Object.hasOwn(specs,key)) continue;
    const {frames, rows, seconds, loop, holdFrame, holdSeconds} = row(specs[key]);
    if (!boundedNumber(frames,1,32) || !Number.isInteger(frames) || !boundedNumber(rows,1,8) || !Number.isInteger(rows) ||
      !boundedNumber(seconds,.015,4) || typeof loop !== 'boolean') throw formatError();
    const anchor = values(motion.anchor,2,1024) as Point;
    const file = key + '.png';
    const clip: Clip = {file,frames,rows,seconds,loop,scale:1,
      rects:Array.from({length:frames*rows},(_,i)=>gridRect(motion.cell,frames,i)),
      anchors:Array.from({length:frames*rows},()=>anchor)};
    if (boundedNumber(holdFrame,0,frames-1) && Number.isInteger(holdFrame) && boundedNumber(holdSeconds,0,5)) {
      clip.holdFrame = holdFrame; clip.holdSeconds = holdSeconds;
    }
    await add(key,clip,'actors/motion/' + resident.art + '/' + file,true);
  }

  const {png, bounds} = cropCover(atlases.get('walk.png')!, walkClip.rects[0]!);
  const [ax, ay] = walkClip.anchors[0]!;
  const scale = Math.min(216 / Math.max(1,ay-bounds[1]), 210 / (bounds[2]-bounds[0]));
  const extent = bounds.map((edge,i)=> i % 2 === 0 ? 128+(edge-ax)*scale : 256+(edge-ay)*scale);
  const pose = (word: string, kind: 'motion'|'expression', seconds: number) => {
    const [zh,en] = LABELS[word]!;
    return {id:word,kind,seconds,names:{zh:[zh],en:[en.replace(/ /g,'')]},about:{zh,en}};
  };
  const vocab = [pose('stand','motion',.35),pose('walk','motion',2.5),pose('run','motion',1.8)];
  if (clips.sit) vocab.push(pose('sit','motion',1.5));
  for (const [key, word] of MOTIONS) {
    const clip = clips[key];
    if (word && clip) vocab.push(pose(word,'expression',clip.frames*clip.seconds+(clip.holdSeconds??0)));
  }
  const outfits = [{id:'classic',name:{zh:'原版',en:'Original'}}];
  if (clips.robe) outfits.push({id:'yukata',name:{zh:'浴衣',en:'Yukata'}});
  const manifest = {
    manifest:MANIFEST_VERSION, api:FIGURE_API, id:'cabin-' + createHash('sha256').update(resident.key).digest('hex').slice(0,16),
    source:'cabin-world', name:{zh:resident.name,en:resident.key==='xiaojingyu'?'Little Whale':resident.name},
    about:{zh:'小屋世界的原版像素角色。Cabin World by VADS。',en:'Original Cabin World pixel character. Cabin World by VADS.'},
    author:'VADS', license:'CC-BY-4.0', version:'1.0.0',
    entry:'figure.js', export:'createCabinSpriteBody', model:'sprites.json', thumb:'cover.png',
    can:{walk:true}, vocab,
    axes:outfits.length>1?[{id:'outfit',name:{zh:'衣服',en:'Outfit'},options:outfits}]:[],
    presets:outfits.length>1?outfits.map(outfit=>({...outfit,pick:{outfit:outfit.id}})):[],
  };
  signal.throwIfAborted();
  for (const [name, bytes] of atlases) await writeFile(join(output,name), bytes, {signal});
  await writeFile(join(output,'figure.js'),await boundedFile(RENDERER, 64 * 1024),{signal});
  await writeFile(join(output,'cover.png'),png,{signal});
  await writeFile(join(output,'figure.json'),JSON.stringify(manifest),{signal});
  await writeFile(join(output,'sprites.json'),JSON.stringify({clips, scale, extent,
    turnSeconds:boundedNumber(motion.turnSeconds,0,1)?motion.turnSeconds:.09}),{signal});
  await writeFile(join(output,'CREDITS.txt'),
    'Cabin World art and atlas metadata by VADS, CC BY 4.0. https://github.com/BabyBus2022/cabin-world\n' +
    'https://creativecommons.org/licenses/by/4.0/\nFigure Scape adapts the animation rules and crops the original cover.\n',{signal});
}
