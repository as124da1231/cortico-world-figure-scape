import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';

const runtime = new URL('../cabin-runtime/', import.meta.url);
const missing = 'Prepare Cabin World 1.1.0 with scripts/prepare-cabin-runtime.py before packaging.';
const pinnedExport = 'c395a1ed69983b299743406c33decdd8948239a318f6a0bfc254f6a27b458cee';
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
assert.equal(hash.digest('hex'), pinnedExport, 'Unexpected Cabin World Windows export');
assert.equal(manifest.gameSha256, pinnedExport, 'Cabin World provenance mismatch');
