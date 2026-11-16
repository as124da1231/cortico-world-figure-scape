import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { wallpaperPlacement, sameWallpaperPlacement, type WallpaperPlacement } from '../../web/framework/wallpaper-placement.js';
import { filesFromBundle, filesFromZip, MODEL_BUNDLE_LIMIT, writeImportFiles } from '../live2d/import-files.ts';

type Kind = 'image' | 'video' | 'scene' | 'web';
type Entry = { id: string; title: string; kind: Kind; path: string; file: string; project: boolean; cover?: string; video?: string };
export type WallpaperComposition = { placement: WallpaperPlacement; revision: number };
export type WallpaperOptions = { fit: 'cover' | 'contain'; volume: number; paused: boolean; interactive: boolean; scale: number };
const defaults: WallpaperOptions = { fit:'cover', volume:0, paused:false, interactive:false, scale:1 };
const image = /\.(png|jpe?g|webp|avif|gif)$/i, video = /\.(mp4|webm)$/i;
const acceptedAssets = /\.(png|jpe?g|webp|avif|gif|svg|mp4|webm|ogg|mp3|wav|m4a|aac|json|pkg|tex|dds|ktx2?|js|mjs|css|html?|woff2?|ttf|otf|glsl|hlsl|vert|frag|mdl|model|puppet|bin|txt|vmt|vsh|fsh|material|wmv|mkv)$/i;
const idPattern = /^[a-f0-9]{24}$/;
const maxItems = 512;
const runFile = promisify(execFile);

async function steamRoots() {
  if (process.platform !== 'win32') return [];
  const {stdout} = await runFile('reg.exe', ['query','HKCU\\Software\\Valve\\Steam','/v','SteamPath'],
    {windowsHide:true, timeout:2500}).catch(() => ({stdout:''}));
  const registered = /^\s*SteamPath\s+REG_SZ\s+(.+)$/im.exec(stdout)?.[1].trim();
  const programFiles = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles;
  return [...new Set([registered, programFiles && join(programFiles,'Steam')].filter((root): root is string => !!root && isAbsolute(root)))];
}
const inside = (root: string, file: string) => {
  const rel = relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};
const safeName = (name: unknown): name is string => typeof name === 'string' && name.length <= 320
  && !/[\\:%?\x00-\x1f]/.test(name)
  && name.split('/').every(segment => segment && segment !== '.' && segment !== '..' && !segment.startsWith('.'));
const assetPath = (id: string, name: string) => '/api/wallpaper-assets/' + id + '/' + name.split('/').map(encodeURIComponent).join('/');
const entryId = (file: string) => createHash('sha256').update(process.platform === 'win32' ? file.toLowerCase() : file).digest('hex').slice(0, 24);

async function projectJson(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 512 * 1024) throw Error('Invalid wallpaper project');
  const value: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid wallpaper project');
  return value as Record<string, unknown>;
}

async function fileIn(root: string, name: unknown) {
  if (!safeName(name) || !acceptedAssets.test(name)) return null;
  const file = await realpath(join(root, name)).catch(() => null);
  if (!file || !inside(root, file)) return null;
  const info = await stat(file).catch(() => null);
  return info?.isFile() ? { file, size: info.size, extension: extname(file).toLowerCase() } : null;
}

async function inspect(input: string): Promise<Entry> {
  const target = await realpath(input);
  const info = await stat(target);
  const directory = info.isDirectory();
  const project = directory || basename(target).toLowerCase() === 'project.json';
  const root = directory ? target : dirname(target);
  if (!project) {
    const file = basename(target);
    if (!safeName(file)) throw Error('Invalid wallpaper filename');
    const kind = image.test(file) ? 'image' : video.test(file) ? 'video' : /\.pkg$/i.test(file) ? 'scene' : null;
    if (!kind || !info.isFile()) throw Error('Choose an image, MP4/WebM, Scene package or Wallpaper Engine project folder');
    return { id: entryId(target), path:root, title:basename(file, extname(file)), kind, file, project:false, ...(kind==='image'?{cover:file}:{}) };
  }
  const manifestPath = await fileIn(root, 'project.json');
  if (!manifestPath) throw Error('The folder does not contain project.json');
  const manifest = await projectJson(manifestPath.file);
  const kind = manifest.type === 'picture' ? 'image' : manifest.type;
  if (kind !== 'image' && kind !== 'video' && kind !== 'scene' && kind !== 'web') throw Error('This Wallpaper Engine project type is unsupported');
  let file = typeof manifest.file === 'string' ? manifest.file.replaceAll('\\', '/') : '';
  const supported = kind === 'scene' ? /\.(pkg|json)$/i : kind === 'web' ? /\.html?$/i : kind === 'video' ? video : image;
  if (!supported.test(file) || !await fileIn(root, file)) {
    const alt = kind === 'scene' ? 'scene.pkg' : kind === 'web' ? 'index.html' : '';
    file = alt && await fileIn(root, alt) ? alt : '';
  }
  if (!file) throw Error('The wallpaper project is missing its entry file');
  let cover: string | undefined;
  for (const candidate of [manifest.preview, 'preview.jpg', 'preview.png', 'preview.webp', kind === 'image' ? file : null]) {
    if (typeof candidate === 'string' && image.test(candidate) && await fileIn(root, candidate)) { cover = candidate; break; }
  }
  let backupVideo: string | undefined;
  if (kind === 'scene' || kind === 'web') {
    for (const candidate of ['scene.mp4', 'wallpaper.mp4', 'video.mp4']) {
      if (await fileIn(root, candidate)) { backupVideo = candidate; break; }
    }
  }
  const title = typeof manifest.title === 'string' && manifest.title.trim() ? manifest.title.trim().slice(0, 200) : basename(root);
  return { id:entryId(root), path:root, title, kind, file, project:true, cover, video:backupVideo };
}

export function wallpaperOptions(input: unknown, previous: WallpaperOptions = defaults): WallpaperOptions {
  const value = input && typeof input === 'object' ? input as Partial<WallpaperOptions> : {};
  const bounded = (n: unknown, min: number, max: number, fallback: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  return {
    fit: value.fit === 'cover' || value.fit === 'contain' ? value.fit : previous.fit,
    volume: bounded(value.volume, 0, 1, previous.volume),
    paused: typeof value.paused === 'boolean' ? value.paused : previous.paused,
    interactive: typeof value.interactive === 'boolean' ? value.interactive : previous.interactive,
    scale: bounded(value.scale, .5, 2, previous.scale),
  };
}

export function createWallpaperLibrary(directory: () => string) {
  type Store = { entries: Entry[]; selected: string | null; options: WallpaperOptions; compositions: Record<string, WallpaperComposition> };
  let current: Store | undefined;
  let queue = Promise.resolve<unknown>(undefined);
  let reading: Promise<Store> | undefined;
  function load(): Promise<Store> {
    if (current) return Promise.resolve(current);
    return reading ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(join(directory(), 'catalog.json'), 'utf8')) as Partial<Store>;
        const entries = (Array.isArray(raw.entries) ? raw.entries : []).filter(item =>
          item && idPattern.test(item.id) && isAbsolute(item.path) && safeName(item.file)
          && ['image','video','scene','web'].includes(item.kind) && typeof item.title === 'string').slice(0, maxItems);
        const compositions = Object.fromEntries(entries.flatMap(item => {
          const record = raw.compositions?.[item.id];
          return record && Number.isSafeInteger(record.revision) && record.revision > 0
            ? [[item.id, { placement:wallpaperPlacement(record.placement), revision:record.revision }]] : [];
        }));
        return current = { entries, selected: entries.some(item => item.id === raw.selected) ? raw.selected! : null,
          options: wallpaperOptions(raw.options), compositions };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return current = { entries:[], selected:null, options:{...defaults}, compositions:{} };
      }
    })().finally(() => { reading = undefined; });
  }
  function update(change: (value: Store) => void) {
    const work = queue.catch(() => {}).then(async () => {
      const next = structuredClone(await load());
      change(next);
      const dir = directory(), temporary = join(dir, 'catalog-' + randomUUID() + '.tmp');
      await mkdir(dir, {recursive:true});
      try {
        await writeFile(temporary, JSON.stringify(next), {flag:'wx'});
        await rename(temporary, join(dir, 'catalog.json'));
        current = next;
      } finally { await rm(temporary, {force:true}); }
    });
    queue = work;
    return work;
  }
  const composition = (value: Store, id: string): WallpaperComposition =>
    value.compositions[id] ?? { placement:wallpaperPlacement(), revision:0 };
  const summary = ({id, title, kind, cover}: Entry, value: Store) =>
    ({id, title, kind, cover:Boolean(cover), composition:composition(value,id)});
  const descriptor = (entry: Entry, value: Store) => ({
    id:entry.id, title:entry.title, kind:entry.kind, options:value.options, composition:composition(value,entry.id),
    media:assetPath(entry.id, entry.file), base:'/api/wallpaper-assets/' + entry.id + '/',
    ...(entry.cover ? { poster:assetPath(entry.id, entry.cover) } : {}),
    ...(entry.video ? { video:assetPath(entry.id, entry.video) } : {}),
  });
  function find(value: Store, id: unknown) { return typeof id === 'string' && idPattern.test(id) ? value.entries.find(item => item.id === id) : undefined; }
  async function importPath(path: unknown) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw Error('Choose a local wallpaper file or folder');
    const item = await inspect(path);
    await update(value => {
      if (value.entries.length >= maxItems && !find(value, item.id)) throw Error('The wallpaper library is full');
      value.entries = [item, ...value.entries.filter(previous => previous.id !== item.id)];
    });
    return summary(item, await load());
  }
  async function importUpload(kind: 'zip' | 'bundle', bytes: Uint8Array) {
    const files = kind === 'zip' ? filesFromZip(bytes, undefined, MODEL_BUNDLE_LIMIT) : filesFromBundle(bytes);
    if (typeof files === 'string') throw Error(files);
    const manifests = files.filter(file => /(?:^|[/\\])project\.json$/i.test(file.path));
    const entry = manifests.length === 1 ? manifests[0] : files.length === 1 ? files[0] : null;
    if (!entry) throw Error('Choose one Wallpaper Engine project or one media file');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cache = join(directory(), 'imports');
    const saved = join(cache, hash);
    const staging = join(cache, randomUUID());
    if (!await stat(saved).then(info => info.isDirectory(), () => false)) {
      await mkdir(staging, {recursive:true});
      try {
        await writeImportFiles(staging, files);
        await inspect(join(staging, entry.path));
        try { await rename(staging, saved); } catch (error) {
          if (!await stat(saved).then(info => info.isDirectory(), () => false)) throw error;
        }
      } finally { await rm(staging, {recursive:true, force:true}); }
    }
    return importPath(join(saved, entry.path));
  }
  async function scan(input: unknown) {
    if (input !== undefined && (typeof input !== 'string' || !isAbsolute(input))) throw Error('Choose your Steam library folder');
    const roots = typeof input === 'string' ? [await realpath(input)] : await steamRoots();
    for (const root of [...roots]) {
      const config = await readFile(join(root, 'steamapps/libraryfolders.vdf'), 'utf8').catch(() => '');
      for (const match of config.matchAll(/"path"\s+"([^"\r\n]+)"/g)) {
        const path = match[1].replaceAll('\\\\', '\\');
        if (isAbsolute(path) && !roots.includes(path) && roots.length < 32) roots.push(path);
      }
    }
    const known = new Set<string>();
    const projects = roots.flatMap(root => [root, join(root, 'steamapps/workshop/content/431960'), join(root, 'workshop/content/431960'),
      join(root, 'steamapps/common/wallpaper_engine/projects/defaultprojects'), join(root, 'steamapps/common/wallpaper_engine/projects/myprojects'),
      join(root, 'projects/defaultprojects'), join(root, 'projects/myprojects')]);
    const items: Entry[] = [];
    let skipped = 0;
    for (const path of projects) {
      const folder = await realpath(path).catch(() => null);
      if (!folder || known.has(folder)) continue;
      known.add(folder);
      const children = await readdir(folder, {withFileTypes:true}).catch(() => []);
      for (const child of children.slice(0, 2048)) {
        if (!child.isDirectory() || child.isSymbolicLink() || items.length >= maxItems) continue;
        const candidate = join(folder, child.name);
        if (!await stat(join(candidate, 'project.json')).then(info => info.isFile(), () => false)) continue;
        try { items.push(await inspect(candidate)); } catch { skipped++; }
      }
    }
    let added = 0;
    if (items.length) await update(value => {
      for (const item of items) if (!find(value, item.id) && value.entries.length < maxItems) {
        value.entries.push(item); added++;
      }
    });
    return { found: items.length, added, skipped };
  }
  return {
    async state() {
      const value = await load();
      return { items:value.entries.map(entry => summary(entry,value)), selected:value.selected, options:value.options };
    },
    async prepare(id?: unknown) {
      const value = await load();
      const entry = find(value, id === undefined ? value.selected : id);
      if (!entry || !await fileIn(entry.path, entry.file)) throw Error('wallpaper-source-unavailable');
      return descriptor(entry, value);
    },
    async settings() {
      const value = await load(), entry = find(value, value.selected);
      return entry ? descriptor(entry, value) : null;
    },
    importPath, importUpload, scan,
    select: (id: unknown) => update(value => {
      if (id !== null && !find(value, id)) throw Error('Wallpaper not found');
      value.selected = id as string | null;
    }),
    async setComposition(id: unknown, input: unknown, expected: unknown) {
      const patch = input as Partial<WallpaperPlacement> | null;
      if (!patch || typeof patch !== 'object' || !Number.isFinite(patch.x) || !Number.isFinite(patch.groundY)
        || typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) throw Error('wallpaper-invalid-placement');
      let result: WallpaperComposition | undefined;
      await update(value => {
        const entry = find(value,id);
        if (!entry) throw Error('wallpaper-source-unavailable');
        const previous = composition(value,entry.id);
        if (previous.revision !== expected) throw Error('wallpaper-placement-conflict');
        const placement = wallpaperPlacement(patch);
        result = sameWallpaperPlacement(placement,previous.placement) ? previous : {placement,revision:previous.revision+1};
        value.compositions[entry.id] = result;
      });
      return result!;
    },
    configure: (patch: unknown) => update(value => { value.options = wallpaperOptions(patch, value.options); }),
    remove: (id: unknown, clearSelection = false) => update(value => {
      if (!find(value, id)) throw Error('Wallpaper not found');
      if (id === value.selected) {
        if (!clearSelection) throw Error('Choose another wallpaper before removing the current one');
        value.selected = null;
      }
      delete value.compositions[id as string];
      value.entries = value.entries.filter(item => item.id !== id);
    }),
    async asset(id: unknown, name: string) {
      const entry = find(await load(), id);
      if (!entry) return null;
      if (name === 'project.json') {
        const original = entry.project ? await fileIn(entry.path, name) : null;
        const manifest = original ? await projectJson(original.file) : {};
        return { json: { ...manifest, type:entry.kind, file:entry.file } };
      }
      if (!entry.project && name !== entry.file) return null;
      return fileIn(entry.path, name);
    },
    async cover(id: unknown) {
      const entry = find(await load(), id);
      return entry?.cover ? fileIn(entry.path, entry.cover) : null;
    },
  };
}
