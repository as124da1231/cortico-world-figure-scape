import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SHA256 } from './cubism-core.ts';
import { CUBISM_FRAMEWORK_DIGESTS } from './cubism-runtime.ts';

const RUNTIME = fileURLToPath(new URL('../../live2d-runtime/', import.meta.url));
const SDK_FILES = ['live2dcubismcore.min.js', 'framework.js', 'shaders.js'] as const;

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function validSdk(bytes: Buffer[]): boolean {
  return bytes.length === 3 && hash(bytes[0]) === CORE_SHA256 && CUBISM_FRAMEWORK_DIGESTS.some(pair =>
    pair.every((expected, index) => hash(bytes[index + 1].toString('utf8').replace(/\r\n/g, '\n')) === expected));
}
async function sdkBytes(dir: string): Promise<Buffer[] | null> {
  try {
    const files = SDK_FILES.map(name => join(dir, name));
    if ((await Promise.all(files.map(file => stat(file)))).some(info => !info.isFile() || info.size > 1024 * 1024)) return null;
    const bytes = await Promise.all(files.map(file => readFile(file)));
    return validSdk(bytes) ? bytes : null;
  } catch { return null; }
}
/** Reuse verified local files only. Never downloads or implicitly accepts license terms. */
export async function prepareLocalSdk(target: string, candidates: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (await sdkBytes(target)) return target;
  if (await stat(target).catch(() => null)) throw new Error('本 World 的 Live2D 缓存不完整或校验失败，请先修复缓存；未覆盖现有文件');
  for (const source of candidates) {
    const bytes = await sdkBytes(source);
    if (!bytes) continue;
    signal.throwIfAborted();
    await mkdir(dirname(target), { recursive: true });
    const staging = await mkdtemp(join(dirname(target), '.sdk-import-'));
    try {
      for (const [index, name] of SDK_FILES.entries()) await writeFile(join(staging, name), bytes[index], { flag: 'wx' });
      for (const name of ['LICENSE-live2d-core.txt', 'LICENSE-live2d-components.txt']) {
        await writeFile(join(staging, name), await readFile(join(RUNTIME, 'pack/sdk', name)), { flag: 'wx' });
      }
      signal.throwIfAborted();
      await rename(staging, target);
      return target;
    } finally {
      if (resolve(staging).startsWith(resolve(dirname(target)) + sep)) await rm(staging, { recursive: true, force: true });
    }
  }
  throw new Error('缺少已校验的本地 Live2D SDK 缓存；本节点不自动下载或接受新许可');
}
