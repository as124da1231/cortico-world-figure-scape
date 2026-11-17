import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把 `cabin-runtime/` 拆成能单独发到 npm 的资源包。
 *
 * npm 注册表对单个发布请求有未公开的 200MB 上限,而 CabinWorld.exe 压缩后仍有约
 * 140MB,连同资源一起打成一个包会被 413 拒收。这里按字节切成三段,主包声明它们为
 * 依赖;扩展首次进入小屋世界时由 `src/framework/cabin-bundle.ts` 拼回原文件并校验
 * 与 `manifest.json` 相同的摘要。玩家侧仍然只装一次,不需要另外下载游戏。
 *
 * 用法: node scripts/split-cabin-runtime.mjs [输出目录]
 * 默认输出到 `build/cabin-parts/<包名>/`,再用 `npm pack` 逐个打包。
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'cabin-runtime');
const exe = join(source, 'CabinWorld.exe');
const destination = resolve(process.argv[2] ?? join(root, 'build', 'cabin-parts'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));

const expected = manifest.gameSha256;
if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
  throw new Error('cabin-runtime/manifest.json 缺少 gameSha256,先用 scripts/prepare-cabin-runtime.py 准备好。');
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const size = (await stat(exe).catch(() => null))?.size ?? 0;
if (!size) throw new Error('缺少 cabin-runtime/CabinWorld.exe,先运行 scripts/prepare-cabin-runtime.py。');
if (await sha256(exe) !== expected) throw new Error('CabinWorld.exe 与 manifest.json 的摘要不一致,重新准备运行时。');

// 前三段在 gzip 后差别很大(前半段压缩比高),按 25%/75% 切能把三个包都压在 100MB 以内。
const cuts = [0, Math.round(size * 0.25), Math.round(size * 0.75), size];
const names = cuts.slice(1).map((_, index) => `${pkg.name}-cabin-${index + 1}of${cuts.length - 1}`);
const parts = [];

await rm(destination, { recursive: true, force: true });
for (const [index, name] of names.entries()) {
  const from = cuts[index], to = cuts[index + 1];
  const dir = join(destination, name);
  await mkdir(join(dir, 'chunks'), { recursive: true });
  if (index === 0) {
    await cp(source, join(dir, 'cabin-runtime'), { recursive: true, filter: path => path !== exe });
  }
  const file = join(dir, 'chunks', 'exe.bin');
  const hash = createHash('sha256');
  const output = await open(file, 'w');
  try {
    for await (const block of createReadStream(exe, { start: from, end: to - 1 })) {
      hash.update(block);
      await output.write(block);
    }
  } finally { await output.close(); }
  const row = { index: index + 1, total: names.length, offset: from, length: to - from, sha256: hash.digest('hex'), exeSha256: expected };
  await writeFile(join(dir, 'cabin-part.json'), JSON.stringify(row, null, 2) + '\n');
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name,
    version: pkg.version,
    description: `Figure Scape · 梦境的内置小屋世界资源（${index + 1}/${names.length}）。`,
    license: pkg.license,
    repository: pkg.repository,
    author: pkg.author,
    os: ['win32'],
    cpu: ['x64'],
    files: ['cabin-runtime', 'chunks', 'cabin-part.json'],
    engines: pkg.engines,
  }, null, 2) + '\n');
  parts.push({ name, dir, ...row, bytes: row.length });
}

console.log(JSON.stringify({ destination, exeBytes: size, exeSha256: expected, parts }, null, 2));
