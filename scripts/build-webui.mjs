/**
 * 面板产物按内容区分，构建时同步 package.json 的 WebUI 入口。
 *
 * 不给 `cortico/*` 配 alias 也不 external:浏览器侧只允许 `import type` 框架,
 * 那些 import 编译期就被擦掉。构建若报 "Could not resolve cortico/…",说明有一处
 * 运行时依赖漏网,去把它本地化,而不是在这里放行。
 */
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = `${root}dist`;
const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(manifest, 'utf8'));

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [
    { in: `${root}src/webui/client.ts`, out: 'webui' },
    { in: `${root}src/webui/editor.ts`, out: 'editor' },
    { in: `${root}src/webui/wallpaper-renderer.ts`, out: 'wallpaper' },
  ],
  outdir,
  entryNames: '[name]-[hash]',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  loader: {'.webp': 'dataurl'},
  minify: true,
  sourcemap: true,
  metafile: true,
  plugins: [{
    name: 'package-version',
    setup(build) {
      // The manifest also records the previous build's hashed asset names.
      build.onLoad({ filter: /package\.json$/ }, ({ path }) => {
        if (path === manifest) return { contents: JSON.stringify({ version: pkg.version }), loader: 'json' };
      });
    },
  }],
});

const require = createRequire(import.meta.url);
const wallpaperPackage = require.resolve('webwallgl/package.json');
const mediaEntry = createRequire(wallpaperPackage).resolve('mediabunny');
copyFileSync(join(dirname(wallpaperPackage), 'LICENSE'), join(outdir, 'webwallgl.LICENSE.txt'));
copyFileSync(join(dirname(mediaEntry), '..', '..', 'LICENSE'), join(outdir, 'mediabunny.LICENSE.txt'));

const outputs = Object.keys(result.metafile.outputs);
const entry = (name, extension) => {
  const file = outputs.find((path) => basename(path).startsWith(name + '-') && path.endsWith(extension));
  if (!file) throw new Error('Missing WebUI asset: ' + extension);
  return relative(root, file).replaceAll('\\', '/');
};
pkg.cortico.webUiClient = entry('webui', '.js');
pkg.cortico.webUiStyle = entry('webui', '.css');
pkg.live2dEditor = { script: entry('editor', '.js'), style: entry('editor', '.css') };
pkg.live2dWallpaper = entry('wallpaper', '.js');
writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');

for (const [path, info] of Object.entries(result.metafile.outputs)) {
  if (path.endsWith('.map')) continue;
  console.log(`${path.replace(/\\/g, '/')}  ${(info.bytes / 1024).toFixed(1)} KB`);
}
