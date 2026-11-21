import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_HOME, CORE_VERSION, LICENSE_FILES } from './cubism-core.ts';
import { cubismRuntimeState, ensureCubismRuntime } from './cubism-runtime.ts';
import { prepareLocalSdk } from './local-sdk.ts';

const LICENSES = fileURLToPath(new URL('../../live2d-runtime/pack/sdk/', import.meta.url));

interface SdkState {
  ok: boolean;
  local: boolean;
  reusable: boolean;
  version: string;
  bytes: number;
  consentAt: number | null;
  running: boolean;
  messages: string[];
  official: string;
}

/** Owns the shared, verified runtime cache used by Live2D direct loading. */
export function createSdkService(dataDir: string) {
  const root = resolve(dataDir, 'desktop-live2d-pet');
  const cache = join(root, 'sdk'), previous = join(dataDir, 'figure', 'sdk');
  const consent = join(root, 'sdk-consent.json');
  let current: Promise<SdkState> | null = null;
  let messages: string[] = [];
  let consentRequested = false;

  async function accepted() {
    const value = await readFile(consent, 'utf8').then(text => JSON.parse(text)).catch(() => null);
    return value?.version === CORE_VERSION && Number.isFinite(value.at) && value.at > 0 ? value.at as number : null;
  }
  async function state(): Promise<SdkState> {
    const [local, reusable, consentAt] = await Promise.all([
      cubismRuntimeState(cache), cubismRuntimeState(previous), accepted(),
    ]);
    return { ok: local.ok || reusable.ok, version: CORE_VERSION, bytes: local.ok ? local.bytes : reusable.bytes,
      local: local.ok, reusable: reusable.ok, consentAt, running: current !== null, messages: [...messages], official: CORE_HOME };
  }

  async function install() {
    if ((await cubismRuntimeState(cache)).ok) return;
    const reusable = (await cubismRuntimeState(previous)).ok;
    const consentAt = await accepted();
    if (!reusable && !consentAt && !consentRequested) throw Error('请在「引擎 → Live2D」里同意 Live2D 组件许可并完成安装');
    await mkdir(root, { recursive: true });
    const work = await mkdtemp(join(root, '.sdk-'));
    let keep = false;
    try {
      const next = join(work, 'runtime');
      if (reusable) {
        await prepareLocalSdk(next, [previous], new AbortController().signal);
        messages.push('复用已校验的本机 Live2D 运行组件');
      } else {
        if (!consentAt) {
          const file = join(work, 'consent.json');
          await writeFile(file, JSON.stringify({ version: CORE_VERSION, at: Date.now() }), { flag: 'wx' });
          await rename(file, consent);
        }
        await ensureCubismRuntime(next, [], line => messages.push(line));
        for (const name of Object.values(LICENSE_FILES)) await copyFile(join(LICENSES, name), join(next, name));
      }
      if (!(await cubismRuntimeState(next)).ok) throw Error('Live2D 运行组件未通过校验');
      if ((await cubismRuntimeState(cache)).ok) return;
      const old = join(work, 'previous-' + randomUUID());
      const hasOld = await lstat(cache).then(() => true).catch(error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (hasOld) await rename(cache, old);
      try { await rename(next, cache); }
      catch (error) {
        if (hasOld) {
          try { await rename(old, cache); }
          catch { keep = true; throw Error(`运行组件恢复失败，旧缓存位于 ${old}`, { cause: error }); }
        }
        throw error;
      }
    } finally {
      if (!keep && resolve(work).startsWith(root + sep)) await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  function ensure(accept: unknown) {
    if (accept === true) consentRequested = true;
    if (!current) {
      messages = [];
      current = install().finally(() => {
        current = null;
        consentRequested = false;
      }).then(state);
    }
    return current;
  }

  return {
    state, ensure,
    async prepare(signal?: AbortSignal) {
      signal?.throwIfAborted();
      const task = ensure(false);
      if (!signal) await task;
      else {
        let listener: ReturnType<typeof addAbortListener> | undefined;
        const cancelled = new Promise<never>((_resolve, reject) => {
          listener = addAbortListener(signal, () => reject(signal.reason));
        });
        try { await Promise.race([task, cancelled]); }
        finally { listener?.[Symbol.dispose](); }
      }
      return cache;
    },
    async verifiedCache() {
      return (await cubismRuntimeState(cache)).ok ? cache : null;
    },
    async license(which: unknown) {
      if (which !== 'core' && which !== 'sdk') throw Error('Choose a Live2D license');
      const file = LICENSE_FILES[which];
      return { file, text: await readFile(join(LICENSES, file), 'utf8') };
    },
  };
}
