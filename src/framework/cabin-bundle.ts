import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { downloadFile } from '../runtime/download.ts';
import resources from './cabin-resources.json' with { type: 'json' };

const markerName = '.figure-scape-bundle.json';
const extract = promisify(execFile);
const tar = process.platform === 'win32' && process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
export const CABIN_BOOT_FILES = ['CabinWorld.exe', 'bridge/bridge.mjs', 'bridge/bridge.config.json', 'bridge/openai-tools.json'];
const managedBootFiles = [...CABIN_BOOT_FILES, 'bridge/cabin-host.mjs'];
const runtimeFiles = [...managedBootFiles, 'manifest.json', 'LICENSE', 'third-party/godot/LICENSE.txt'];

type PartManifest = { index:number; total:number; offset:number; length:number; sha256:string; exeSha256:string };
export type CabinInstallFailure = 'network' | 'unpublished' | 'integrity' | 'disk-space' | 'in-use' | 'install';

export class CabinInstallError extends Error {
  constructor(readonly code: CabinInstallFailure, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type CabinBundle = {
  root: string;
  prepare: (signal?: AbortSignal) => Promise<void>;
  verify: (signal?: AbortSignal) => Promise<void>;
  state: () => CabinResourceState;
};

export type CabinResourceState = {
  phase: 'needed' | 'local' | 'downloading' | 'verifying' | 'installing' | 'ready';
  version?: string;
  done: number;
  total: number;
  failure?: CabinInstallFailure;
  repair?: boolean;
};

export type CabinBundleOptions = {
  packageRoot: string;
  targetRoot: string;
  /** On-disk compatibility marker, independent of the download channel. */
  version: string;
  expectedSha256?: string;
  parts?: readonly string[];
  resolvePart?: (name: string) => string;
  fetchImpl?: typeof fetch;
  resources?: typeof resources;
};

async function fileHash(file: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

async function fileSize(file: string) {
  return (await stat(file).catch(() => null))?.size ?? -1;
}

function diskFull(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC'
    || error instanceof Error && /no space left|not enough (?:space|disk space)|disk full|磁盘空间不足/i.test(error.message);
}

function hasBootFiles(directory: string) {
  try { return managedBootFiles.every(file => statSync(join(directory, file), { throwIfNoEntry:false })?.isFile()); }
  catch { return false; }
}

/** Reuse compatible installations and complete local legacy parts before fetching the pinned ZIP. */
export function createCabinBundle(options: CabinBundleOptions): CabinBundle {
  const source = options.resources ?? resources;
  const expected = options.expectedSha256 ?? source.exportSha256;
  const names = options.parts ?? source.packages.map(part => part.name);
  const bundled = join(options.packageRoot, 'cabin-runtime');
  const inline = hasBootFiles(bundled);
  const root = inline ? bundled : options.targetRoot;
  const resolvePart = options.resolvePart ?? (name => dirname(createRequire(import.meta.url).resolve(name + '/package.json')));
  const findLocal = (name: string) => { try { return resolvePart(name); } catch { return undefined; } };
  const archive = source.archive;
  const total = archive.bytes;
  let progress: CabinResourceState | undefined;
  let pending: Promise<void> | undefined;
  let rejectedLocalParts = false;
  let verifiedRuntime: string | undefined;
  let rejectedRuntime: string | undefined;

  const state = (phase: CabinResourceState['phase'], done: number): CabinResourceState =>
    ({ phase, done, total, version:archive.version });

  function installStamp(directory: string) {
    try {
      const marker = JSON.parse(readFileSync(join(directory, markerName), 'utf8'));
      const exe = statSync(join(directory, 'CabinWorld.exe'));
      if (marker?.version !== options.version || marker.exeSha256 !== expected || exe.size !== marker.exeBytes || !hasBootFiles(directory)) return;
      return `${exe.size}:${exe.mtimeMs}:${exe.ctimeMs}`;
    } catch { return undefined; }
  }

  function installed() {
    if (inline) return hasBootFiles(root);
    const stamp = installStamp(root);
    return !!stamp && stamp !== rejectedRuntime;
  }

  function recoverPrevious() {
    if (inline || existsSync(root)) return;
    const parent = dirname(root), prefix = basename(root) + '.tmp-';
    try {
      const previous = readdirSync(parent, { withFileTypes:true }).flatMap(entry => {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix) || !/^[a-z\d]{6}-previous$/i.test(entry.name.slice(prefix.length))) return [];
        const path = join(parent, entry.name);
        return installStamp(path) ? [{ path, stamp:statSync(path).mtimeMs }] : [];
      }).sort((a, b) => b.stamp - a.stamp)[0];
      if (previous && !existsSync(root)) renameSync(previous.path, root);
    } catch { /* A concurrent operation or locked directory remains eligible on retry. */ }
  }
  recoverPrevious();

  async function verify(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const failure = () => new CabinInstallError('integrity', '小屋世界运行文件缺失或损坏，请在引擎页修复安装。');
    if (inline) { if (!hasBootFiles(root)) throw failure(); return; }
    const stamp = installStamp(root);
    if (!stamp || stamp === rejectedRuntime) throw failure();
    if (stamp === verifiedRuntime) return;
    const actual = await fileHash(join(root, 'CabinWorld.exe'), signal);
    signal?.throwIfAborted();
    if (stamp !== installStamp(root)) throw failure();
    if (actual !== expected) {
      rejectedRuntime = stamp;
      throw failure();
    }
    verifiedRuntime = stamp;
  }

  async function downloadRuntime(temporary: string, signal?: AbortSignal) {
    progress = state('downloading', 0);
    const zip = join(temporary, 'cabin-runtime.zip');
    try {
      await downloadFile(archive.url, zip, { fetchImpl: options.fetchImpl, signal, onProgress: done => {
        if (done > total) throw new CabinInstallError('integrity', '小屋世界下载大小与发布附件不符。');
        progress = state('downloading', done);
      } });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CabinInstallError || diskFull(error)) throw error;
      if (error instanceof Error && error.message === 'HTTP 404') {
        throw new CabinInstallError('unpublished', '小屋世界的发布附件暂不可用。', { cause:error });
      }
      throw new CabinInstallError('network', '小屋世界下载中断，请检查网络后重试。', { cause:error });
    }
    progress = state('verifying', total);
    if (await fileSize(zip) !== total || await fileHash(zip, signal) !== archive.sha256) {
      throw new CabinInstallError('integrity', '小屋世界下载校验失败，可以重试。');
    }
    // Only extract bytes that match the Release pin into a private staging directory.
    const { stdout } = await extract(tar, ['-tf', zip], { signal, windowsHide:true });
    const entries = stdout.trimEnd().split(/\r?\n/);
    if (entries.some(entry => !entry.startsWith('cabin-runtime/')
      || entry.replace(/\/$/, '').split('/').some(name => !name || name === '.' || name === '..' || /[:\\]/.test(name)))
      || runtimeFiles.some(file => !entries.includes('cabin-runtime/' + file))) {
      throw new CabinInstallError('integrity', '小屋世界附件包含异常路径或缺少运行文件。');
    }
    progress = state('installing', total);
    await extract(tar, ['-xf', zip, '-C', temporary], { signal, windowsHide:true });
    return join(temporary, 'cabin-runtime');
  }

  async function assembleLocal(temporary: string, signal?: AbortSignal) {
    progress = state('installing', 0);
    const rows: { dir:string; manifest:PartManifest }[] = [];
    let offset = 0;
    for (const name of names) {
      signal?.throwIfAborted();
      const dir = findLocal(name);
      if (!dir) throw new CabinInstallError('integrity', '本机缺少旧版资源包 ' + name + '。');
      const manifest = await readFile(join(dir, 'cabin-part.json'), 'utf8')
        .then(value => JSON.parse(value) as PartManifest).catch(() => null);
      if (!manifest || !Number.isSafeInteger(manifest.offset)
        || !Number.isSafeInteger(manifest.length) || manifest.length <= 0 || manifest.index !== rows.length + 1) {
        throw new CabinInstallError('integrity', '本机的小屋世界资源包 ' + name + ' 不完整。');
      }
      if (manifest.total !== names.length || manifest.exeSha256 !== expected) {
        throw new CabinInstallError('integrity', '本机的小屋世界资源包与扩展版本不匹配。');
      }
      if (manifest.offset !== offset) throw new CabinInstallError('integrity', '本机的小屋世界资源包顺序不完整。');
      rows.push({ dir, manifest });
      offset += manifest.length;
    }
    const tree = join(rows[0].dir, 'cabin-runtime');
    if (!existsSync(tree)) throw new CabinInstallError('integrity', '本机的小屋世界资源包缺少游戏文件。');
    const staging = join(temporary, 'runtime');
    await cp(tree, staging, { recursive:true });
    const handle = await open(join(staging, 'CabinWorld.exe'), 'w');
    try {
      for (const { dir, manifest } of rows) {
        const chunk = join(dir, 'chunks', 'exe.bin');
        if (await fileSize(chunk) !== manifest.length || await fileHash(chunk, signal) !== manifest.sha256) {
          throw new CabinInstallError('integrity', '本机的小屋世界资源包已损坏。');
        }
        for await (const block of createReadStream(chunk, { signal })) await handle.writeFile(block);
      }
    } finally { await handle.close(); }
    return staging;
  }

  async function commit(staging: string, temporary: string, signal?: AbortSignal) {
    const exe = join(staging, 'CabinWorld.exe');
    if (!hasBootFiles(staging) || await fileHash(exe, signal) !== expected) {
      throw new CabinInstallError('integrity', '小屋世界运行文件校验失败。');
    }
    const exeBytes = await fileSize(exe);
    await writeFile(join(staging, markerName), JSON.stringify({ version:options.version, exeSha256:expected, exeBytes }));
    signal?.throwIfAborted();
    const previous = temporary + '-previous';
    // The resident saves live separately. Keep the old runtime until the new one is in place.
    if (existsSync(options.targetRoot)) {
      try {
        await rename(options.targetRoot, previous);
      } catch (error) {
        if (diskFull(error)) throw error;
        throw new CabinInstallError('in-use', '小屋世界正在被占用，请关闭游戏窗口后重试。', { cause:error });
      }
    }
    try {
      signal?.throwIfAborted();
      await rename(staging, options.targetRoot);
    } catch (error) {
      if (existsSync(previous)) await rename(previous, options.targetRoot);
      throw error;
    }
    rejectedRuntime = undefined;
    verifiedRuntime = installStamp(root);
    await rm(previous, { recursive:true, force:true, maxRetries:3 }).catch(() => {});
  }

  const localAvailable = () => !rejectedLocalParts && names.length > 0 && names.every(findLocal);

  async function install(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (inline) { await verify(signal); return; }
    recoverPrevious();
    if (installed()) return;
    await mkdir(dirname(options.targetRoot), { recursive:true });
    const temporary = await mkdtemp(options.targetRoot + '.tmp-');
    const local = localAvailable();
    try {
      const staging = local ? await assembleLocal(temporary, signal) : await downloadRuntime(temporary, signal);
      await commit(staging, temporary, signal);
    } catch (error) {
      if (local && error instanceof CabinInstallError && error.code === 'integrity') rejectedLocalParts = true;
      throw error;
    } finally {
      await rm(temporary, { recursive:true, force:true, maxRetries:3 }).catch(() => {});
    }
  }

  return {
    root,
    verify,
    state() {
      if (progress) return { ...progress };
      if (installed()) return state('ready', total);
      const result = state(localAvailable() ? 'local' : 'needed', 0);
      return existsSync(join(root, markerName)) ? { ...result, repair:true } : result;
    },
    prepare(signal) {
      pending ??= install(signal).catch(error => {
        signal?.throwIfAborted();
        if (diskFull(error)) throw new CabinInstallError('disk-space', '磁盘空间不足，请释放空间后重试。', { cause:error });
        throw error;
      }).finally(() => { pending = undefined; progress = undefined; });
      return pending;
    },
  };
}
