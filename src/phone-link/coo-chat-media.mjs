import {createHmac, timingSafeEqual} from 'node:crypto';

const maxBytes = 8 * 1024 * 1024;
const imageTypes = {
  'image/png': {ext:'png', matches: bytes => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))},
  'image/jpeg': {ext:'jpg', matches: bytes => bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255},
  'image/gif': {ext:'gif', matches: bytes => /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))},
  'image/webp': {ext:'webp', matches: bytes => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'},
};

const failure = (status, message) => Object.assign(new Error(message), {status});

export function createChatMedia(origin, secret) {
  const sign = (deviceId, target, value) =>
    createHmac('sha256', secret).update(JSON.stringify(['chat-image-v1', deviceId, target, value])).digest();

  function packItem(item, deviceId, target) {
    if (!Array.isArray(item?.images)) return item;
    const {images, ...message} = item;
    if (!['say', 'user'].includes(item.kind)) return message;
    message.images = images.slice(0, 8).flatMap(image => {
      const {ref, mime, name} = image ?? {};
      if (typeof ref !== 'string' || ref.length === 0 || ref.length > 300
          || !ref.startsWith('log:') || !Object.hasOwn(imageTypes, mime)) return [];
      const payload = Buffer.from(JSON.stringify([ref, mime])).toString('base64url');
      return [{
        id: payload + '.' + sign(deviceId, target, payload).toString('base64url'),
        ext: imageTypes[mime].ext,
        ...(typeof name === 'string' && name ? {name: name.slice(0, 120)} : {}),
      }];
    });
    return message;
  }

  function frameForPhone(frame, deviceId, target) {
    if ((frame.t === 'init' || frame.t === 'older') && Array.isArray(frame.items)) {
      return {...frame, items: frame.items.map(item => packItem(item, deviceId, target))};
    }
    if (frame.t === 'item') return {...frame, item: packItem(frame.item, deviceId, target)};
    return frame;
  }

  async function readImage({deviceId, target, id, cookie}) {
    const missing = () => failure(404, '找不到这张聊天图片。');
    if (!/^[A-Za-z0-9_-]{1,1800}\.[A-Za-z0-9_-]{43}$/.test(id ?? '')) throw missing();
    const [payload, proof] = id.split('.');
    const signature = Buffer.from(proof, 'base64url');
    if (!timingSafeEqual(signature, sign(deviceId, target, payload))) throw missing();
    let ref, mime;
    try { [ref, mime] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { throw missing(); }
    if (typeof ref !== 'string' || !ref.startsWith('log:') || !Object.hasOwn(imageTypes, mime)) throw missing();
    const url = new URL('/api/blob', origin);
    url.searchParams.set('handle', ref);
    const response = await fetch(url, {
      headers: cookie ? {cookie} : {}, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== mime) {
      await response.body?.cancel();
      throw missing();
    }
    const tooLarge = () => failure(413, '聊天图片超过 8 MB。');
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > maxBytes) throw tooLarge();
      parts.push(part);
    }
    const bytes = Buffer.concat(parts, size);
    if (!imageTypes[mime].matches(bytes)) throw failure(422, '聊天图片格式无效。');
    return {mime, bytes};
  }

  return {frameForPhone, readImage};
}
