import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readManifest, type FigureManifest, type FigurePack } from '../packs.ts';
import { MODEL_BUNDLE_LIMIT } from '../live2d/import-files.ts';
import { assertTouchAreaChange, readTouchProfile } from '../../web/framework/touch-geometry.js';
import type { FigureSettings, FigureSettingsPatch } from './model-contract.ts';
export type { FigureSettings } from './model-contract.ts';

const ID = /^figure-[a-f0-9]{24}$/;
function revisionOf(settings: FigureSettings): string {
  return createHash('sha256').update(JSON.stringify([settings.scheme || '', settings.touch ?? null])).digest('hex');
}

export function figureSchemes(manifest: FigureManifest) {
  return manifest.presets.map(preset => ({ id: preset.id, name: preset.name ?? { zh: preset.id, en: preset.id } }));
}

export function validateFigureScheme(manifest: FigureManifest, value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw Error('装扮选项无效');
  if (manifest.presets.some(preset => preset.id === value)) return value;
  const choices = value.split('-');
  if (choices.length !== manifest.axes.length || manifest.axes.some((axis, i) => !axis.options.some(option => option.id === choices[i]))) {
    throw Error('形象包没有这个装扮');
  }
  return value;
}

export function createFigureLibrary(directory: string, builtin?: { id: string; directory: string }) {
  const root = resolve(directory), snapshots = join(root, 'sources'), preferences = join(root, 'profiles');
  const snapshot = (id: string) => join(snapshots, id);
  const hidden = (id: string) => join(preferences, id + '.removed');
  const profile = (id: string) => join(preferences, id + '.json');
  const pending = new Map<string, Promise<unknown>>();

  const isBuiltin = (id: string) => id === builtin?.id;
  const figureDirectory = (id: string) => builtin?.id === id ? resolve(builtin.directory) : snapshot(id);

  function find(id: string, includeRemoved = false): FigurePack | null {
    if (!ID.test(id) || !isBuiltin(id) && !includeRemoved && existsSync(hidden(id))) return null;
    const dir = figureDirectory(id);
    try {
      const manifest = readManifest(dir);
      return typeof manifest === 'string' ? null : {
        id, dir, base: '/figure-assets/' + id + '/', manifest, ...(isBuiltin(id) ? { builtin:true } : {}),
      };
    } catch { return null; }
  }
  function list() {
    const packaged = builtin && find(builtin.id);
    try {
      const imported = readdirSync(snapshots, { withFileTypes: true }).flatMap(item => {
        if (!item.isDirectory() || item.isSymbolicLink() || item.name === packaged?.id) return [];
        const pack = find(item.name);
        return pack ? [pack] : [];
      });
      return packaged ? [packaged,...imported] : imported;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return packaged ? [packaged] : [];
      throw error;
    }
  }

  function asset(id: string, path: string): string | null {
    if (!ID.test(id) || !path || isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part))) return null;
    try {
      const source = figureDirectory(id), base = realpathSync(source);
      const file = realpathSync(join(source, path)), subpath = relative(base, file);
      if (source.toLocaleLowerCase() !== base.toLocaleLowerCase() || !subpath || isAbsolute(subpath) ||
        subpath === '..' || subpath.startsWith('..' + sep) || !lstatSync(file).isFile()) return null;
      return file;
    } catch { return null; }
  }

  function settings(id: string): FigureSettings {
    try { return JSON.parse(readFileSync(profile(id), 'utf8')) as FigureSettings; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }

  async function writeSettings(id: string, update: FigureSettingsPatch, expectedRevision?: string): Promise<FigureSettings> {
    const write = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!/^(figure-[a-f0-9]{24}|live2d-[a-f0-9]{16})$/.test(id)) throw Error('角色来源无效');
      const previous = settings(id);
      if (expectedRevision !== undefined && expectedRevision !== revisionOf(previous)) {
        throw Error('角色配置已更新，请重新打开编辑台。草稿已保留。');
      }
      const value = { ...previous };
      if ('scheme' in update) {
        if (update.scheme) value.scheme = update.scheme;
        else delete value.scheme;
      }
      if ('touch' in update) {
        if (update.touch == null) delete value.touch;
        else value.touch = update.touch;
      }
      if (value.touch !== undefined) {
        value.touch = readTouchProfile(value.touch);
        assertTouchAreaChange(value.touch.areas, previous.touch?.areas);
      }
      const temp = profile(id) + '.' + randomUUID();
      await mkdir(preferences, { recursive: true });
      try {
        await writeFile(temp, JSON.stringify(value), { flag: 'wx' });
        await rename(temp, profile(id));
      } finally { await rm(temp, { force: true }); }
      return value;
    });
    pending.set(id, write);
    try { return await write; }
    finally { if (pending.get(id) === write) pending.delete(id); }
  }

  async function prepare(file: string, signal: AbortSignal) {
    const entry = await realpath(file);
    if (basename(entry).toLowerCase() !== 'figure.json') throw Error('请选择形象包的 figure.json');
    const from = dirname(entry);
    const manifest = readManifest(from);
    if (typeof manifest === 'string') throw Error(manifest);
    await mkdir(snapshots, { recursive: true });
    const temp = await mkdtemp(join(snapshots, '.import-'));
    const hash = createHash('sha256');
    let count = 0, bytes = 0;
    async function copy(source: string, target: string, depth = 0) {
      signal.throwIfAborted();
      if (depth > 24) throw Error('形象包目录层级过深');
      const entries = await readdir(source);
      entries.sort();
      await mkdir(target, { recursive: true });
      for (const name of entries) {
        signal.throwIfAborted();
        if (++count > 10_000) throw Error('形象包文件数量超过上限');
        const file = join(source, name);
        const info = await lstat(file);
        if (info.isSymbolicLink()) throw Error('形象包内含文件链接');
        const output = join(target, name);
        if (info.isDirectory()) { await copy(file, output, depth + 1); continue; }
        if (!info.isFile()) throw Error('形象包内含特殊文件');
        bytes += info.size;
        if (bytes > MODEL_BUNDLE_LIMIT) throw Error('形象包超过 512 MB');
        await copyFile(file, output);
        hash.update(JSON.stringify([relative(temp, output).split(sep).join('/'), info.size]));
        for await (const chunk of createReadStream(output, { signal })) hash.update(chunk);
        hash.update('\0');
      }
    }
    try {
      await copy(from, temp);
      const copied = readManifest(temp);
      if (typeof copied === 'string') throw Error(copied);
      for (const path of [copied.entry, copied.model].filter((part): part is string => !!part)) {
        if (!(await lstat(join(temp, path)).catch(() => null))?.isFile()) throw Error('形象包缺少文件：' + path);
      }
      const id = 'figure-' + hash.digest('hex').slice(0, 24);
      signal.throwIfAborted();
      if (!find(id, true)) await rename(temp, snapshot(id));
      await rm(hidden(id), { force: true });
      return id;
    } finally { await rm(temp, { recursive: true, force: true }); }
  }

  async function importGenerated(generate: (directory: string, signal: AbortSignal) => Promise<void>) {
    const signal = new AbortController().signal;
    await mkdir(root, { recursive:true });
    const directory = await mkdtemp(join(root, '.generated-'));
    try {
      await generate(directory, signal);
      return await prepare(join(directory,'figure.json'), signal);
    } finally { await rm(directory, { recursive:true, force:true }); }
  }

  async function remove(id: string, protectedIds: readonly string[]) {
    if (!find(id)) throw Error('形象包已经移出角色库');
    if (isBuiltin(id)) throw Error('内置形象包无法移出角色库');
    if (protectedIds.includes(id)) throw Error('先切换到另一个角色，再移出当前角色');
    await mkdir(preferences, { recursive: true });
    await writeFile(hidden(id), '');
    return { id, removed: true };
  }

  function save(id: string, update: FigureSettingsPatch, expectedRevision?: string) {
    const pack = find(id);
    if (!pack) throw Error('形象包已移出角色库');
    const validated = 'scheme' in update ? { ...update, scheme: validateFigureScheme(pack.manifest, update.scheme ?? '') } : update;
    return writeSettings(id, validated, expectedRevision);
  }

  return { find, list, asset, settings, save, prepare, importGenerated, remove, revisionOf, rememberWardrobe: (id: string, scheme: string) => writeSettings(id, { scheme }) };
}
