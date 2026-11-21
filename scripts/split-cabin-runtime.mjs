import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cabinResources, checkCabinRuntime } from './check-cabin-runtime.mjs';

/**
 * 把 `cabin-runtime/` 拆成能单独发到 npm 的资源包。
 *
 * 整包曾因发布请求过大被拒收。小屋运行时按字节拆成三段，由梦境按需下载固定版本。
 * 运行时拼回原文件并核验摘要。仅在小屋资源更新时生成这些包。
 *
 * 用法: node scripts/split-cabin-runtime.mjs [输出目录]
 * 默认输出到 `build/cabin-parts/<包名>/`,再用 `npm pack` 逐个打包。
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'cabin-runtime');
const exe = join(source, 'CabinWorld.exe');
const destination = resolve(process.argv[2] ?? join(root, 'build', 'cabin-parts'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = cabinResources.version;
const { gameSha256: expected } = await checkCabinRuntime();
const { size } = await stat(exe);

// 前三段在 gzip 后差别很大(前半段压缩比高),按 25%/75% 切能把三个包都压在 100MB 以内。
// 包名不能用 `cortico-world-` 开头:那是世界包的命名空间,市场认证会认为本扩展在依赖另一个世界。
const cuts = [0, Math.round(size * 0.25), Math.round(size * 0.75), size];
const names = cabinResources.packages.map(part => part.name);
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
    version,
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
