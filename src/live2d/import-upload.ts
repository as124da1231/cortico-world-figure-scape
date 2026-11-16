import { randomUUID } from 'node:crypto';
import { MODEL_ARCHIVE_LIMIT, MODEL_BUNDLE_LIMIT } from './import-files.ts';

export function createImportUpload<T>(intake: {
  cancel(): boolean;
  importUpload(kind: 'zip' | 'bundle', bytes: Uint8Array): Promise<T>;
}, domain = 'resources') {
  type Upload = { id: string; kind: 'zip' | 'bundle'; total: number; bytes: Buffer[]; done: number; touched: number; finishing?: boolean };
  let current: Upload | undefined;

  function find(id: unknown) {
    if (!current || current.id !== id) throw Error('导入已过期，请重新选择文件');
    return current;
  }

  return async (method: string, args: unknown[]) => {
    const [id, value, content] = args;
    if (method === domain + '.beginUpload') {
      if (current && (current.finishing || Date.now() - current.touched < 180_000)) throw Error('已有文件正在导入');
      if (id !== 'zip' && id !== 'bundle') throw Error('文件导入类型无效');
      const limit = id === 'zip' ? MODEL_ARCHIVE_LIMIT : MODEL_BUNDLE_LIMIT;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > limit) throw Error('文件超出导入大小限制');
      current = { id: randomUUID(), kind: id, total: value, done: 0, bytes: [], touched: Date.now() };
      return { id: current.id };
    }
    if (method === domain + '.cancelUpload') {
      if (!current || current.id !== id) return { cancelled: false };
      if (current.finishing) return { cancelled: intake.cancel() };
      current = undefined;
      return { cancelled: true };
    }
    const upload = find(id);
    if (upload.finishing) throw Error('文件已经上传，正在检查模型');
    if (method === domain + '.appendUpload') {
      if (typeof content !== 'string' || !content.length || content.length > 1_400_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw Error('文件分块无效');
      const bytes = Buffer.from(content, 'base64');
      if (value !== upload.done || !bytes.length || upload.done + bytes.length > upload.total) throw Error('文件分块不完整，请重新导入');
      upload.done += bytes.length;
      upload.bytes.push(bytes);
      upload.touched = Date.now();
      return { done: upload.done, total: upload.total };
    }
    if (method === domain + '.finishUpload') {
      if (upload.done !== upload.total) throw Error('文件尚未上传完整');
      upload.finishing = true;
      try { return await intake.importUpload(upload.kind, Buffer.concat(upload.bytes, upload.done)); }
      finally { if (current === upload) current = undefined; }
    }
    throw Error('未知文件导入操作');
  };
}
