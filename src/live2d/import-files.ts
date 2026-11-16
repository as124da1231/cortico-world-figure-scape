import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { petText, type PetText } from '../i18n/index.ts';

export const BUNDLE_TYPE = 'application/x-live2d-model-files';
export const MODEL_ARCHIVE_LIMIT = 32 * 1024 * 1024;
export const MODEL_BUNDLE_LIMIT = 512 * 1024 * 1024;
export interface ImportFile { path: string; bytes: Uint8Array }

/** A path inside what was sent: its segments, or null when it is empty, absolute, or climbs out. */
function segments(path: string): string[] | null {
  const parts = path.split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  if (!parts.length || /^[a-z]:/i.test(path) || path.startsWith('/') || path.startsWith('\\')) return null;
  return parts.some((p) => p === '..' || /[<>:"|?*\u0000-\u001f]/.test(p)
    || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)) ? null : parts;
}

/** The files of a zip, its directories left out; a string says why it cannot be read. */
export function filesFromZip(bytes: Uint8Array, t: PetText['importing'] = petText().importing, limit = MODEL_BUNDLE_LIMIT): ImportFile[] | string {
  let entries: Record<string, Uint8Array>;
  let expanded = 0, count = 0;
  const seen = new Set<string>();
  try {
    entries = unzipSync(bytes, { filter: file => {
      if (file.name.endsWith('/')) return false;
      const parts = segments(file.name);
      if (!parts) throw Error(t.badPath(file.name));
      const key = parts.join('/').toLowerCase();
      if (seen.has(key)) throw Error(`Duplicate archive path: ${file.name}`);
      seen.add(key);
      expanded += file.originalSize;
      if (expanded > limit || ++count > 10_000) throw Error('Archive expands beyond the import limit');
      return true;
    } });
  } catch (err) {
    return t.badZip((err as Error).message);
  }
  return Object.entries(entries).map(([path, data]) => ({ path, bytes: data }));
}

/**
 * The files the page framed (`BUNDLE_TYPE`): for each, the byte length of its path as uint32 little-endian, the
 * path in UTF-8, the byte length of its contents as uint32, the contents.
 */
export function filesFromBundle(bytes: Uint8Array, t: PetText['importing'] = petText().importing): ImportFile[] | string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  const files: ImportFile[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) return t.truncated;
    const pathLen = view.getUint32(at, true); at += 4;
    if (at + pathLen + 4 > bytes.length) return t.truncated;
    const path = text.decode(bytes.subarray(at, at + pathLen)); at += pathLen;
    const size = view.getUint32(at, true); at += 4;
    if (at + size > bytes.length) return t.truncated;
    files.push({ path, bytes: bytes.subarray(at, at + size) });
    at += size;
  }
  return files;
}

/** Writes an archive or folder bundle inside an empty staging directory. */
export async function writeImportFiles(root: string, files: readonly ImportFile[], signal?: AbortSignal) {
  if (files.length > 10_000) throw Error('Too many import files');
  const seen = new Set<string>();
  for (const file of files) {
    signal?.throwIfAborted();
    const parts = segments(file.path);
    if (!parts) throw Error(petText().importing.badPath(file.path));
    const key = parts.join('/').toLowerCase();
    if (seen.has(key)) throw Error(`Duplicate import path: ${file.path}`);
    seen.add(key);
    await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...parts), file.bytes, { flag: 'wx', signal });
  }
}

