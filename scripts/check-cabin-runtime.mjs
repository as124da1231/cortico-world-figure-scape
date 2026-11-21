import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const runtime = new URL('../cabin-runtime/', import.meta.url);
const missing = 'Prepare Cabin World 1.1.0 with scripts/prepare-cabin-runtime.py before packaging.';
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;

export const cabinResources = JSON.parse(await readFile(new URL('../src/framework/cabin-resources.json', import.meta.url), 'utf8'));

function checkCabinResourcePins(dependencies) {
  assert(exactVersion.test(cabinResources.version), 'Cabin World resources must use an exact version.');
  assert(/^[a-f0-9]{64}$/.test(cabinResources.exportSha256), 'Missing Cabin World executable SHA-256.');
  const { version, url, bytes, sha256 } = cabinResources.archive;
  assert(exactVersion.test(version), 'The Cabin World release must use an exact version.');
  const attachment = 'figure-scape-cabin-world-' + version + '-win-x64.zip';
  assert.equal(url, 'https://github.com/as124da1231/cortico-world-figure-scape/releases/download/cabin-world-' + version + '/' + attachment);
  assert(Number.isSafeInteger(bytes) && bytes > 0, 'Invalid Cabin World release archive size.');
  assert(/^[a-f0-9]{64}$/.test(sha256), 'Missing Cabin World release archive SHA-256.');
  assert(cabinResources.packages.length === 3, 'Expected three Cabin World resource packages.');
  cabinResources.packages.forEach(({ name, bytes, sha512 }, index) => {
    assert.equal(name, `figure-scape-cabin-${index + 1}of3`);
    assert(Number.isSafeInteger(bytes) && bytes > 0, `Invalid archive size for ${name}.`);
    assert(/^[A-Za-z0-9+/]{86}==$/.test(sha512), `Missing archive SHA-512 for ${name}.`);
    assert(!Object.hasOwn(dependencies ?? {}, name), `${name} is downloaded on demand.`);
  });
}

export async function checkCabinRuntime() {
  const contents = await readdir(runtime, { recursive: true, withFileTypes: true }).catch(() => {
    throw new Error(missing);
  });
  for (const file of contents) {
    assert(!file.isSymbolicLink(), `Unexpected link in Cabin World: ${file.name}`);
    assert(!/^(data|saves|world|layouts|backups|bridge\.json|.*\.log|\.figure-scape-.*)$/i.test(file.name),
      `Cabin World runtime data would be packaged: ${file.name}`);
    assert(!/^(naiwa-games-|shop-cashier-)/i.test(file.name), `Excluded Cabin World art: ${file.name}`);
  }
  for (const path of ['bridge/bridge.mjs', 'bridge/openai-tools.json', 'bridge/bridge.config.json', 'LICENSE', 'third-party/godot/LICENSE.txt']) {
    await access(new URL(path, runtime)).catch(() => { throw new Error(`${missing} Missing ${path}.`); });
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(new URL('CabinWorld.exe', runtime))) hash.update(chunk);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', runtime), 'utf8'));
  assert.equal(hash.digest('hex'), cabinResources.exportSha256, 'Unexpected Cabin World Windows export');
  assert.equal(manifest.gameSha256, cabinResources.exportSha256, 'Cabin World provenance mismatch');
  return manifest;
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--pins') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    checkCabinResourcePins(pkg.dependencies);
    console.log(`Cabin World resources: ${cabinResources.archive.version} (GitHub Release, on demand)`);
  } else {
    await checkCabinRuntime();
  }
}
