type Entry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file(success: (file: File) => void, fail: (error: DOMException) => void): void;
  createReader(): { readEntries(success: (entries: Entry[]) => void, fail: (error: DOMException) => void): void };
};
type InputFile = { file: File; path: string };
const maxFiles = 10_000;
const maxBundle = 512 * 1024 * 1024;

export function localClipboardPaths(text: string) {
  const files = text.replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, 8).flatMap(value => {
    const path = value.trim().replace(/^["']|["']$/g, '');
    return /^[a-z]:[\\/]/i.test(path) && !/[\u0000-\u001f]/.test(path) ? [path] : [];
  });
  return [...new Set(files)];
}

export function selectedFiles(files: ArrayLike<File>) {
  return Array.from(files, file => ({ file, path: file.webkitRelativePath || file.name }));
}

export function readTransferredFiles(transfer: DataTransfer) {
  const entries = Array.from(transfer.items ?? []).flatMap(item => {
    const entry = (item as unknown as {webkitGetAsEntry?: () => Entry | null}).webkitGetAsEntry?.();
    return entry ? [entry] : [];
  });
  const output: InputFile[] = [];
  async function visit(entry: Entry, parent: string) {
    if (output.length >= maxFiles) throw Error('导入文件数超过限制');
    const path = parent + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((ok, fail) => entry.file(ok, fail));
      output.push({ file, path });
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (!batch.length) return;
      for (const child of batch) await visit(child, path + '/');
    }
  }
  return entries.length
    ? (async () => { for (const entry of entries) await visit(entry, ''); return output; })()
    : Promise.resolve(selectedFiles(transfer.files));
}

export function filePayload(files: InputFile[]) {
  if (!files.length) throw Error('没有可导入的文件');
  if (files.length === 1 && !files[0].path.includes('/') && /\.zip$/i.test(files[0].file.name)) return { kind: 'zip' as const, blob: files[0].file };
  if (files.some(({file,path}) => !path.includes('/') && /\.zip$/i.test(file.name))) throw Error('请分别导入 ZIP 和模型文件夹');
  const parts: BlobPart[] = [];
  const encoder = new TextEncoder();
  let size = 0;
  // Directory iteration order can differ between the system chooser and drag-and-drop.
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const { file, path } of sorted) {
    const name = encoder.encode(path);
    size += file.size + name.length + 8;
    if (size > maxBundle || files.length > maxFiles) throw Error('导入文件超出大小或数量限制');
    const header = new Uint8Array(name.length + 8), view = new DataView(header.buffer);
    view.setUint32(0, name.length, true);
    header.set(name, 4);
    view.setUint32(name.length + 4, file.size, true);
    parts.push(header, file);
  }
  return { kind: 'bundle' as const, blob: new Blob(parts) };
}

export async function encodeChunk(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 16_384) parts.push(String.fromCharCode(...bytes.subarray(index, index + 16_384)));
  return btoa(parts.join(''));
}
