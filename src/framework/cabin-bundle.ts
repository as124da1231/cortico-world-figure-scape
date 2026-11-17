import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * 小屋世界的 Windows 导出是 210MB,压缩后仍超过 npm 单包 200MB 的发布上限。
 * 发布时按 `scripts/split-cabin-runtime.mjs` 拆成资源包,首次使用时在这里拼回原文件,
 * 玩家仍然只装一次,不需要另外下载游戏。
 *
 * 摘要与 `scripts/check-cabin-runtime.mjs` 盯的是同一个导出。
 */
export const CABIN_EXE_SHA256 = 'c395a1ed69983b299743406c33decdd8948239a318f6a0bfc254f6a27b458cee';

/** 资源包的固定顺序;每个包只带一段字节,拼起来正好是 CabinWorld.exe。 */
export const CABIN_PART_PACKAGES = [
  'figure-scape-cabin-1of3',
  'figure-scape-cabin-2of3',
  'figure-scape-cabin-3of3',
] as const;

const markerName = '.figure-scape-bundle.json';

type PartManifest = { index:number; total:number; offset:number; length:number; sha256:string; exeSha256:string };
export type CabinBundle = {
  /** 小屋世界安装目录;资源包还没拼好时,这个目录会在首次进入前出现。 */
  root:string;
  /** 把资源包拼成可运行的安装目录;已经就绪时立即返回。 */
  prepare:() => Promise<void>;
};
export type CabinBundleOptions = {
  /** 扩展包根目录:开发版里面直接带着 `cabin-runtime/`。 */
  packageRoot:string;
  /** 资源包拼好的位置,由扩展的数据目录提供。 */
  targetRoot:string;
  /** 写进标记文件的版本;换了拆包方式时才需要变。 */
  version:string;
  /** 测试用:替换固定的导出摘要。 */
  expectedSha256?:string;
  /** 测试用:替换资源包清单。 */
  parts?:readonly string[];
  /** 测试用:把包名解析成包目录。 */
  resolvePart?:(name:string) => string;
};

async function fileSha256(file:string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function fileSize(file:string) {
  return (await stat(file).catch(() => null))?.size ?? -1;
}

function record(value:unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * 优先用包内自带的完整运行时(开发版和本机安装),否则读资源包并在数据目录拼回。
 * `prepare` 只做一次,同一个实例上的并发调用共用同一份工作。
 */
export function createCabinBundle(options: CabinBundleOptions): CabinBundle {
  const expected = options.expectedSha256 ?? CABIN_EXE_SHA256;
  const bundled = join(options.packageRoot, 'cabin-runtime');
  const inline = existsSync(join(bundled, 'CabinWorld.exe'));
  const root = inline ? bundled : options.targetRoot;
  const resolvePart = options.resolvePart ?? (name => dirname(createRequire(import.meta.url).resolve(name + '/package.json')));
  let pending: Promise<void> | undefined;

  async function parts() {
    const names = options.parts ?? CABIN_PART_PACKAGES;
    const rows: { dir:string; manifest:PartManifest }[] = [];
    for (const name of names) {
      let dir: string;
      try { dir = resolvePart(name); }
      catch { throw Error(`内置小屋世界缺少资源包 ${name},请重新安装扩展。`); }
      const raw = record(JSON.parse(await readFile(join(dir, 'cabin-part.json'), 'utf8').catch(() => 'null')));
      const manifest = raw as PartManifest | null;
      if (!manifest || typeof manifest.offset !== 'number' || typeof manifest.length !== 'number' || typeof manifest.index !== 'number') {
        throw Error(`内置小屋世界的资源包 ${name} 不完整,请重新安装扩展。`);
      }
      if (manifest.total !== names.length) throw Error(`内置小屋世界的资源包版本不一致,请重新安装扩展。`);
      if (manifest.exeSha256 !== expected) throw Error(`内置小屋世界的资源包与扩展版本不匹配,请重新安装扩展。`);
      rows.push({ dir, manifest });
    }
    rows.sort((a, b) => a.manifest.offset - b.manifest.offset);
    let offset = 0;
    for (const { manifest } of rows) {
      if (manifest.offset !== offset) throw Error(`内置小屋世界的资源包顺序不完整,请重新安装扩展。`);
      offset += manifest.length;
    }
    return { rows, bytes:offset };
  }

  async function assemble() {
    const { rows, bytes } = await parts();
    const tree = rows.find(row => row.manifest.index === 1);
    if (!tree || !existsSync(join(tree.dir, 'cabin-runtime'))) {
      throw Error('内置小屋世界的资源包缺少游戏文件,请重新安装扩展。');
    }
    const staging = `${options.targetRoot}.tmp-${process.pid}-${Date.now()}`;
    await rm(staging, { recursive:true, force:true });
    await mkdir(staging, { recursive:true });
    try {
      await cp(join(tree.dir, 'cabin-runtime'), staging, { recursive:true });
      const exe = join(staging, 'CabinWorld.exe');
      const handle = await open(exe, 'w');
      try {
        for (const { dir, manifest } of rows) {
          const chunk = join(dir, 'chunks', 'exe.bin');
          if (await fileSize(chunk) !== manifest.length) throw Error('内置小屋世界的资源包已损坏,请重新安装扩展。');
          for await (const block of createReadStream(chunk)) await handle.write(block as Buffer);
        }
      } finally { await handle.close(); }
      if (await fileSha256(exe) !== expected) throw Error('内置小屋世界校验失败,请重新安装扩展。');
      await writeFile(join(staging, markerName), JSON.stringify({ version:options.version, exeSha256:expected, exeBytes:bytes }));
      try {
        await rm(options.targetRoot, { recursive:true, force:true });
        await rename(staging, options.targetRoot);
      } catch { throw Error('内置小屋世界正在被占用,请先关闭小屋世界窗口再重试。'); }
    } catch (error) {
      await rm(staging, { recursive:true, force:true }).catch(() => {});
      throw error;
    }
  }

  async function ready() {
    if (inline) return;
    const marker = record(JSON.parse(await readFile(join(root, markerName), 'utf8').catch(() => 'null')));
    if (marker?.version === options.version && marker.exeSha256 === expected
      && await fileSize(join(root, 'CabinWorld.exe')) === marker.exeBytes) return;
    await assemble();
  }

  return {
    root,
    prepare() {
      pending ??= ready().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
