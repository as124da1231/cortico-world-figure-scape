import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createCabinBundle } from '../src/framework/cabin-bundle.ts';

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const exeBytes = Buffer.concat([Buffer.alloc(64, 7), Buffer.alloc(96, 11), Buffer.alloc(40, 13)]);
const cuts = [0, 64, 160, exeBytes.length];

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
      await mkdir(join(dir, 'cabin-runtime', 'bridge'), { recursive: true });
      await writeFile(join(dir, 'cabin-runtime', 'bridge', 'bridge.mjs'), '// bridge\n');
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
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'CabinWorld.exe'), 'inline');
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

test('names the missing resource package when one is not installed', async () => {
  const { root, bundle } = await staged();
  await rm(join(root, 'parts', 'part-2'), { recursive: true, force: true });
  await expect(bundle.prepare()).rejects.toThrow('缺少资源包 part-2');
});
