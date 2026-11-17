import { mkdtemp, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, expect, it, vi } from 'vitest';
import { createImportUpload } from '../src/live2d/import-upload.ts';
import { createModelIntake } from '../src/live2d/model-intake.ts';
import { filesFromBundle, filesFromZip } from '../src/live2d/import-files.ts';

vi.mock('node:fs/promises', async load => {
  const fs = await load<typeof import('node:fs/promises')>();
  return { ...fs, statfs: vi.fn(fs.statfs), writeFile: vi.fn(fs.writeFile) };
});

function bundle(files: Record<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [path, bytes] of Object.entries(files)) {
    const name = new TextEncoder().encode(path);
    const head = new DataView(new ArrayBuffer(4));
    head.setUint32(0, name.length, true);
    const size = new DataView(new ArrayBuffer(4));
    size.setUint32(0, bytes.length, true);
    parts.push(new Uint8Array(head.buffer), name, new Uint8Array(size.buffer), bytes);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}


const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'live2d-import-'));
  roots.push(root);
  const imports = join(root, 'imported');
  return { imports, intake: createModelIntake(imports) };
}
const original = { 'source/model.model3.json': strToU8(JSON.stringify({ FileReferences: { Moc: 'model.moc3' } })), 'source/model.moc3': strToU8('MOC3') };

it('discovers original model entries in ZIPs and folder bundles', async () => {
  const { intake } = await fixture();
  for (const [kind, bytes] of [['zip', zipSync(original)], ['bundle', bundle(original)]] as const) {
    const result = await intake.importUpload(kind, bytes);
    expect(result.models).toEqual([expect.objectContaining({ kind: 'live2d', file: 'model.model3.json' })]);
    const model = intake.candidate(result.models[0].id);
    expect(await readFile(join(model.dir, 'model.moc3'), 'utf8')).toBe('MOC3');
    expect((await intake.importPaths([model.dir, join(model.dir, model.file)])).models).toEqual([model]);
  }
});

it('rejects a figure pack even when it includes nested Cubism assets', async () => {
  const { intake, imports } = await fixture();
  const pack = { 'figure.json': strToU8('{}'), ...original };
  await expect(intake.importUpload('zip', zipSync(pack))).rejects.toThrow('形象包');
  expect(await readdir(imports)).toEqual([]);
  const mixed = { ...original, 'installed/figure.json': strToU8('{}'), 'installed/nested/model.model3.json': original['source/model.model3.json'] };
  const result = await intake.importUpload('zip', zipSync(mixed));
  expect(result.models).toHaveLength(1);
  expect(result.problems[0].reason).toContain('形象包');
});

it('rejects unsafe archive paths and corrupt folder bundles', async () => {
  const { intake } = await fixture();
  expect(typeof filesFromZip(zipSync({ '../outside': strToU8('a') }))).toBe('string');
  const upload = bundle(original);
  expect(typeof filesFromBundle(upload.slice(0, -1))).toBe('string');
  await expect(intake.importUpload('bundle', bundle({ ...original, '../outside': strToU8('a') }))).rejects.toThrow();
});

it('reports disk space, removes partial writes, and accepts a new upload after failure', async () => {
  const { intake, imports } = await fixture();
  const bytes = Buffer.from(bundle(original));
  const upload = createImportUpload(intake);
  async function transfer() {
    const response = await upload('resources.beginUpload', ['bundle', bytes.length]) as { id: string };
    await upload('resources.appendUpload', [response.id, 0, bytes.toString('base64')]);
    return upload('resources.finishUpload', [response.id]);
  }
  vi.mocked(writeFile).mockClear();
  vi.mocked(statfs).mockResolvedValueOnce({ type: 0, bsize: 4096, blocks: 10, bfree: 1, bavail: 1, files: 10, ffree: 9 });
  await expect(transfer()).rejects.toThrow(/空间不足.*当前可用/);
  expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  expect(await readdir(imports)).toEqual([]);

  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockImplementationOnce(async (path, data, options) => {
    await fs.writeFile(path, data, options);
    throw Object.assign(Error('write failed'), { code: 'ENOSPC' });
  });
  await expect(transfer()).rejects.toThrow(/空间不足.*重新导入/);
  expect(await readdir(imports)).toEqual([]);
  expect(intake.list()).toEqual([]);
  await expect(transfer()).resolves.toMatchObject({ models: [expect.objectContaining({ kind: 'live2d' })] });
});
