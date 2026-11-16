import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { readManifest } from '../packs.ts';
// @ts-expect-error Figure's bounded model discovery is shared with the converter.
import { findModels } from '../../live2d-runtime/tools/native-catalog.mjs';
import {
  filesFromBundle, filesFromZip, MODEL_ARCHIVE_LIMIT, MODEL_BUNDLE_LIMIT, writeImportFiles,
} from './import-files.ts';

interface Candidate {
  id: string;
  kind: 'live2d' | 'figure';
  title: string;
  dir: string;
  file: string;
}
interface Discovery {
  models: Candidate[];
  problems: Array<{ file: string; reason: string }>;
  truncated: boolean;
}

/** Archives retain a stable, owned source path so edited models can be rebuilt. */
export function createModelIntake(directory: string) {
  const root = resolve(directory);
  const known = new Map<string, Candidate>();
  let active: AbortController | null = null;

  function remember(result: Discovery): Discovery {
    for (const model of result.models) known.set(model.id, model);
    while (known.size > 200) known.delete(known.keys().next().value!);
    return result;
  }

  async function discover(input: string, signal: AbortSignal): Promise<Discovery> {
    const result = await findModels(input, { signal, includeFigurePacks: true }) as Discovery;
    result.models = result.models.filter(candidate => {
      if (candidate.kind !== 'figure') return true;
      try {
        const manifest = readManifest(candidate.dir);
        if (typeof manifest !== 'string') return true;
        result.problems.push({ file: join(candidate.dir, candidate.file), reason: '形象包：' + manifest });
      } catch (error) {
        result.problems.push({ file: join(candidate.dir, candidate.file), reason: '形象包：' + (error as Error).message });
      }
      return false;
    });
    return result;
  }

  async function unpack(kind: 'zip' | 'bundle', bytes: Uint8Array, signal: AbortSignal) {
    const limit = kind === 'zip' ? MODEL_ARCHIVE_LIMIT : MODEL_BUNDLE_LIMIT;
    if (!bytes.byteLength || bytes.byteLength > limit) throw Error('Import exceeds the size limit');
    const id = createHash('sha256').update(kind).update(bytes).digest('hex');
    const target = join(root, id);
    const existing = await lstat(target).catch(() => null);
    if (existing?.isDirectory() && !existing.isSymbolicLink()) return target;
    if (existing) throw Error('Import source is occupied');
    const files = kind === 'zip' ? filesFromZip(bytes, undefined, limit) : filesFromBundle(bytes);
    if (typeof files === 'string') throw Error(files);
    if (!files.length) throw Error('Import contains no files');
    await mkdir(root, { recursive: true });
    const temp = await mkdtemp(join(root, '.import-'));
    try {
      await writeImportFiles(temp, files, signal);
      const discovered = await discover(temp, signal);
      if (!discovered.models.length) throw Error(discovered.problems[0]?.reason ?? 'No supported Live2D model or Coo figure package was found');
      signal.throwIfAborted();
      await rename(temp, target);
      return target;
    } finally {
      if (resolve(temp).startsWith(root + sep)) await rm(temp, { recursive: true, force: true });
    }
  }

  async function run<T>(work: (signal: AbortSignal) => Promise<T>) {
    if (active) throw Error('A model import is already running');
    const controller = new AbortController();
    active = controller;
    try { return await work(controller.signal); }
    finally { active = null; }
  }

  return {
    importPaths(raw: unknown) {
      if (!Array.isArray(raw) || !raw.length || raw.length > 8 || raw.some(p => typeof p !== 'string' || !isAbsolute(p))) {
        throw Error('Choose one to eight local model files, folders or ZIP archives');
      }
      const paths = [...new Set(raw as string[])];
      return run(async signal => {
        const found = new Map<string, Candidate>();
        const problems: Discovery['problems'] = [];
        let truncated = false;
        for (const path of paths) {
          signal.throwIfAborted();
          try {
            const info = await lstat(path);
            if (info.isSymbolicLink()) throw Error('Choose the original file or folder');
            let input = path;
            if (info.isFile() && /\.zip$/i.test(path)) {
              if (info.size > MODEL_ARCHIVE_LIMIT) throw Error('ZIP exceeds the import size limit');
              input = await unpack('zip', await readFile(path, { signal }), signal);
            }
            const result = await discover(input, signal);
            for (const item of result.models) found.set(item.id, item);
            problems.push(...result.problems);
            truncated ||= result.truncated;
            if (!result.models.length && !result.problems.length) problems.push({ file: path, reason: 'No supported model was found' });
          } catch (error) {
            signal.throwIfAborted();
            problems.push({ file: path, reason: error instanceof Error ? error.message : String(error) });
          }
        }
        return remember({ models: [...found.values()], problems, truncated });
      });
    },
    importUpload(kind: 'zip' | 'bundle', bytes: Uint8Array) {
      return run(async signal => {
        const input = await unpack(kind, bytes, signal);
        return remember(await discover(input, signal));
      });
    },
    candidate(id: unknown): Candidate {
      const model = typeof id === 'string' ? known.get(id) : undefined;
      if (!model) throw Error('The imported model is unavailable. Import the source again');
      return model;
    },
    list: () => [...known.values()],
    cancel() { if (!active) return false; active.abort(); return true; },
  };
}
