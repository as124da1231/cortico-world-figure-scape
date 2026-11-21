import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { zipSync } from 'fflate';
import { CABIN_BOOT_FILES, createCabinBundle } from '../src/framework/cabin-bundle.ts';
import pins from '../src/framework/cabin-resources.json' with { type: 'json' };

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rename:vi.fn(fs.rename) };
});

const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const exeBytes = Buffer.concat([Buffer.alloc(64, 7), Buffer.alloc(96, 11), Buffer.alloc(40, 13)]);
const cuts = [0, 64, 160, exeBytes.length];

async function bootFiles(root: string) {
  await mkdir(join(root, 'bridge'), { recursive:true });
  await Promise.all([...CABIN_BOOT_FILES, 'bridge/cabin-host.mjs'].map(file =>
    writeFile(join(root, file), file.endsWith('.mjs') ? '// bridge\n' : '{}')));
}

/** 一段能通过校验的最小安装目录:树 + 拆成三包的可执行文件。 */
async function staged(overrides: { expected?: string; gap?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'figure-cabin-bundle-'));
  const parts: string[] = [];
  for (let index = 0; index < 3; index++) {
    const dir = join(root, 'parts', `part-${index + 1}`);
    await mkdir(join(dir, 'chunks'), { recursive: true });
    const chunk = exeBytes.subarray(cuts[index], cuts[index + 1]);
    await writeFile(join(dir, 'chunks', 'exe.bin'), chunk);
    if (index === 0) {
      await bootFiles(join(dir, 'cabin-runtime'));
      await writeFile(join(dir, 'cabin-runtime', 'manifest.json'), JSON.stringify({ gameSha256: sha256(exeBytes) }));
    }
    await writeFile(join(dir, 'cabin-part.json'), JSON.stringify({
      index: index + 1, total: 3, offset: cuts[index] + (index > 0 ? overrides.gap ?? 0 : 0),
      length: chunk.length, sha256: sha256(chunk), exeSha256: sha256(exeBytes),
    }));
    parts.push(dir);
  }
  return {
    root, parts,
    bundle: createCabinBundle({
      packageRoot: join(root, 'package'),
      targetRoot: join(root, 'data', 'cabin-runtime'),
      version: 'win32-x64-1',
      expectedSha256: overrides.expected ?? sha256(exeBytes),
      parts: ['part-1', 'part-2', 'part-3'],
      resolvePart: (name) => {
        const dir = join(root, 'parts', name);
        if (!existsSync(dir)) throw Error(`missing ${name}`);
        return dir;
      },
    }),
  };
}

test('uses the runtime that ships inside the package without touching the data directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'figure-cabin-inline-'));
  const runtime = join(root, 'package', 'cabin-runtime');
  await bootFiles(runtime);
  const bundle = createCabinBundle({
    packageRoot: join(root, 'package'),
    targetRoot: join(root, 'data', 'cabin-runtime'),
    version: 'win32-x64-1',
    parts: [],
    resolvePart: () => { throw Error('no parts'); },
  });
  expect(bundle.root).toBe(runtime);
  await bundle.prepare();
  expect(existsSync(join(root, 'data', 'cabin-runtime'))).toBe(false);
});

test('joins the resource packages into one verified installation and reuses it afterwards', async () => {
  const { root, parts, bundle } = await staged();
  expect(bundle.root).toBe(join(root, 'data', 'cabin-runtime'));
  await bundle.prepare();
  const installed = join(root, 'data', 'cabin-runtime');
  expect((await readFile(join(installed, 'CabinWorld.exe'))).equals(exeBytes)).toBe(true);
  expect(await readFile(join(installed, 'bridge', 'bridge.mjs'), 'utf8')).toBe('// bridge\n');
  expect(existsSync(join(installed, '.figure-scape-bundle.json'))).toBe(true);
  const leftovers = (await readdir(join(root, 'data'))).filter(name => name.startsWith('cabin-runtime.tmp'));
  expect(leftovers).toEqual([]);

  // 资源包没了也能用已经拼好的目录:第二次进入不该再读包。
  for (const dir of parts) await rm(dir, { recursive: true, force: true });
  await Promise.all([bundle.prepare(), bundle.prepare()]);
  expect((await readFile(join(installed, 'CabinWorld.exe'))).equals(exeBytes)).toBe(true);
});

test('refuses a bundle that does not match the pinned export', async () => {
  const { root, bundle } = await staged({ expected: 'f'.repeat(64) });
  await expect(bundle.prepare()).rejects.toThrow('不匹配');
  expect(existsSync(join(root, 'data', 'cabin-runtime'))).toBe(false);
});

test('refuses resource packages with a hole in the executable', async () => {
  const { bundle } = await staged({ gap: 8 });
  await expect(bundle.prepare()).rejects.toThrow('顺序不完整');
});

function runtimeZip(extra: Record<string, Uint8Array> = {}) {
  const text = Buffer.from('{}');
  return zipSync({
    'cabin-runtime/CabinWorld.exe': exeBytes,
    'cabin-runtime/manifest.json': text,
    'cabin-runtime/bridge/bridge.mjs': text,
    'cabin-runtime/bridge/cabin-host.mjs': text,
    'cabin-runtime/bridge/bridge.config.json': text,
    'cabin-runtime/bridge/openai-tools.json': text,
    'cabin-runtime/LICENSE': text,
    'cabin-runtime/third-party/godot/LICENSE.txt': text,
    ...extra,
  });
}

async function releaseFixture(zip = runtimeZip(), checks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'figure-cabin-release-'));
  const targetRoot = join(root, 'data', 'cabin-runtime');
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Uint8Array(zip).buffer));
  const openBundle = () => createCabinBundle({
    packageRoot:join(root, 'package'), targetRoot, version:'win32-x64-1',
    expectedSha256:sha256(exeBytes), fetchImpl,
    resources:{...pins, archive:{...pins.archive, bytes:zip.length, sha256:sha256(zip), ...checks}},
  });
  return {root, targetRoot, fetchImpl, bundle:openBundle(), openBundle};
}

test('downloads one pinned ZIP, verifies it, and keeps the resident data and install on later use', async () => {
  const { root, targetRoot, fetchImpl, bundle } = await releaseFixture();
  const data = join(root, 'data', 'cabin-world');
  await mkdir(data, { recursive:true });
  await writeFile(join(data, 'resident.json'), 'my resident');
  try {
    expect(bundle.state()).toMatchObject({phase:'needed', version:pins.archive.version});
    const first = bundle.prepare();
    expect(bundle.prepare()).toBe(first);
    await first;
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([pins.archive.url]);
    expect(bundle.state().phase).toBe('ready');
    expect(await readFile(join(targetRoot, 'CabinWorld.exe'))).toEqual(exeBytes);
    expect(await readFile(join(data, 'resident.json'), 'utf8')).toBe('my resident');
    expect((await readdir(join(root, 'data'))).sort()).toEqual(['cabin-runtime','cabin-world']);
    await bundle.prepare();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally { await rm(root, { recursive:true, force:true }); }
});

test.each([
  ['checksum mismatch', runtimeZip(), { sha256:'f'.repeat(64) }],
  ['escaping archive entry', runtimeZip({'cabin-runtime/../escaped.txt':Buffer.from('unexpected')}), {}],
] as const)('rejects %s before replacing the existing directory', async (_case, zip, checks) => {
  const { root, targetRoot, bundle } = await releaseFixture(zip, checks);
  await mkdir(targetRoot, { recursive:true });
  await writeFile(join(targetRoot, 'keep.txt'), 'previous');
  try {
    await expect(bundle.prepare()).rejects.toMatchObject({code:'integrity'});
    expect(await readFile(join(targetRoot, 'keep.txt'), 'utf8')).toBe('previous');
    expect(await readdir(join(root, 'data'))).toEqual(['cabin-runtime']);
  } finally { await rm(root, { recursive:true, force:true }); }
});

test('classifies unavailable downloads and disk errors, and can retry after cancellation', async () => {
  const { root, bundle, fetchImpl } = await releaseFixture();
  try {
    fetchImpl.mockResolvedValueOnce(new Response(null, {status:404}));
    await expect(bundle.prepare()).rejects.toMatchObject({code:'unpublished'});
    fetchImpl.mockRejectedValueOnce(Error('Connection lost'));
    await expect(bundle.prepare()).rejects.toMatchObject({code:'network'});
    fetchImpl.mockRejectedValueOnce(Object.assign(Error('volume full'), {code:'ENOSPC'}));
    await expect(bundle.prepare()).rejects.toMatchObject({code:'disk-space'});
    const abort = new AbortController();
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    fetchImpl.mockImplementationOnce(async (_url, options) => {
      started();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {once:true});
      });
    });
    const prepare = bundle.prepare(abort.signal);
    await waiting;
    abort.abort();
    await expect(prepare).rejects.toMatchObject({name:'AbortError'});
    expect(await readdir(join(root, 'data'))).toEqual([]);
    await bundle.prepare();
    expect(bundle.state().phase).toBe('ready');
  } finally { await rm(root, { recursive:true, force:true }); }
});

test('keeps the old runtime when in use and rolls back a failed replacement', async () => {
  const { root, targetRoot, bundle } = await releaseFixture();
  await mkdir(targetRoot, { recursive:true });
  await writeFile(join(targetRoot, 'keep.txt'), 'previous runtime');
  const move = vi.mocked(rename);
  const original = move.getMockImplementation()!;
  try {
    move.mockRejectedValueOnce(Object.assign(Error('Directory in use'), {code:'EBUSY'}));
    await expect(bundle.prepare()).rejects.toMatchObject({code:'in-use'});
    expect(await readFile(join(targetRoot, 'keep.txt'), 'utf8')).toBe('previous runtime');

    move.mockImplementationOnce(original).mockRejectedValueOnce(Error('Replacement failed'));
    await expect(bundle.prepare()).rejects.toThrow('Replacement failed');
    expect(await readFile(join(targetRoot, 'keep.txt'), 'utf8')).toBe('previous runtime');
    expect(await readdir(join(root, 'data'))).toEqual(['cabin-runtime']);

    const abort = new AbortController();
    move.mockImplementationOnce(async (from, to) => { await original(from, to); abort.abort(); });
    await expect(bundle.prepare(abort.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(await readFile(join(targetRoot, 'keep.txt'), 'utf8')).toBe('previous runtime');
    expect(await readdir(join(root, 'data'))).toEqual(['cabin-runtime']);

    await bundle.prepare();
    expect(bundle.state().phase).toBe('ready');
  } finally { await rm(root, { recursive:true, force:true }); }
});

test('restores a compatible runtime moved aside by an interrupted install without downloading again', async () => {
  const {root, targetRoot, bundle, openBundle, fetchImpl} = await releaseFixture();
  try {
    await bundle.prepare();
    const backup = targetRoot + '.tmp-aBc123-previous';
    await rename(targetRoot, backup);
    const recovered = openBundle();
    expect(recovered.state()).toMatchObject({phase:'ready'});
    expect(existsSync(backup)).toBe(false);
    await recovered.verify();
    await recovered.prepare();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally { await rm(root, {recursive:true,force:true}); }
});

test('requires the managed bridge files and checks executable changes even when its size is unchanged', async () => {
  const {root, targetRoot, bundle, fetchImpl} = await releaseFixture();
  try {
    await bundle.prepare();
    const bridge = join(targetRoot,'bridge','bridge.config.json');
    await rm(bridge);
    expect(bundle.state()).toMatchObject({phase:'needed',repair:true});
    await expect(bundle.verify()).rejects.toMatchObject({code:'integrity'});
    await writeFile(bridge,'{}');
    await bundle.verify();

    const exe = join(targetRoot,'CabinWorld.exe');
    await writeFile(exe,Buffer.alloc(exeBytes.length,254));
    const changed = new Date(Date.now()+5_000);
    await utimes(exe,changed,changed);
    await expect(bundle.verify()).rejects.toMatchObject({code:'integrity'});
    expect(bundle.state()).toMatchObject({phase:'needed',repair:true});
    await bundle.prepare();
    await bundle.verify();
    expect(await readFile(exe)).toEqual(exeBytes);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally { await rm(root, {recursive:true,force:true}); }
});
