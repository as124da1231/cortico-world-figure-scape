import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer as httpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';
import QRCode from 'qrcode';
import WebSocket from 'ws';
import { CooSpeechTarget } from './coo-speech.mjs';
import { createChatMedia } from './coo-chat-media.mjs';
import {createCharacterService, cooTargets} from './coo-characters.mjs';

const localAddress = '127.0.0.1';
// Previously paired phones store this endpoint and pin the deployment certificate.
export const defaultRelayPort = 17832;
export const defaultConsolePort = 17788;
const maxText = 8000;
const nonce = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const nativeTarget='desktop-pet';
const socketPath=target=>'/ws/providers/'+encodeURIComponent('world:'+target)+'/panels/chat';
function targetOf(target){
  if(!target)return nativeTarget;
  if(!Object.hasOwn(cooTargets,target))throw new LinkError(400,'Coo 桌宠来源无效');
  return target;
}
const allowedFrames = new Set(['init','older','item','ask','draft','phase','paused','activity','settled','performance','withdrawn','notice']);
const privateIp = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

function read(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return fallback; }
}

function save(path, value) {
  writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

function certificate(path) {
  const existing = read(path, null);
  if (existing) return existing;
  const { privateKey, publicKey } = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = '01' + randomBytes(15).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 86400000);
  const subject = [{ name:'commonName', value:'Yume Pet LAN Link' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([{ name:'basicConstraints', cA:false }, { name:'extKeyUsage', serverAuth:true }]);
  cert.sign(privateKey, forge.md.sha256.create());
  const result = { key:forge.pki.privateKeyToPem(privateKey), cert:forge.pki.certificateToPem(cert) };
  save(path, result);
  return result;
}

class LinkError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function jsonBody(req, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new LinkError(413, '请求内容过长');
    chunks.push(part);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new LinkError(400, '请求内容无效'); }
}

function json(res, data, code = 200) {
  res.writeHead(code, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff' });
  res.end(JSON.stringify(data));
}

async function loginCoo(base, getPassword) {
  // The Core session cookie is used only by desktop-side HTTP and WebSocket requests.
  try {
    const res = await fetch(base + '/api/auth/status', { signal:AbortSignal.timeout(2500), redirect:'error' });
    if (res.ok && !(await res.json()).required) return '';
    const password = getPassword();
    if (!password) throw new LinkError(503, 'Coo 控制台需要登录，启动连接服务时请提供控制台密码。');
    const response = await fetch(base + '/api/auth/login', {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(2500),
      headers:{'content-type':'application/json',origin:base},
      body:JSON.stringify({password}),
    });
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    await response.body?.cancel();
    if (response.ok && cookie) return cookie;
    throw new LinkError(503, 'Coo 控制台登录失败，请核对密码。');
  } catch (error) {
    if (error instanceof LinkError) throw error;
    throw new LinkError(503, '请在电脑上打开 Coo。');
  }
}

class ChatLink {
  frames = [];
  pending = new Map();
  receipts = new Map();
  seq = 0;
  ready = false;
  closed = false;
  lastUsed = Date.now();
  constructor({cookie, target, cooOrigin, speechTarget, onClose}) {
    this.id = randomUUID();
    this.target = target;
    this.cookie = cookie;
    this.speechTarget = speechTarget;
    this.socket = new WebSocket(new URL(socketPath(target), cooOrigin.replace(/^http:/, 'ws:')), {
      headers:{...(cookie ? {cookie} : {}), 'accept-language':'zh-CN'},
      maxPayload:8 * 1024 * 1024, handshakeTimeout:4000,
    });
    this.socket.on('open', () => this.socket.send(JSON.stringify({t:'hello'})));
    this.socket.on('message', bytes => {
      let frame;
      try { frame = JSON.parse(String(bytes)); } catch { return; }
      if (frame.t === 'sent' || frame.t === 'rejected') {
        this.pending.get(frame.id)?.(frame);
        return;
      }
      if (!allowedFrames.has(frame.t)) return;
      if (frame.t === 'init') this.ready = true;
      this.frames.push({seq:++this.seq, frame});
      if (this.frames.length > 128) this.frames.shift();
    });
    this.socket.on('error', () => {});
    this.socket.on('close', () => {
      this.closed = true;
      for (const finish of this.pending.values()) finish(null);
      onClose(this);
    });
  }

  dispatch(payload) {
    if (!this.ready || this.socket.readyState !== WebSocket.OPEN) throw new LinkError(503, 'Coo 聊天还在连接。');
    if (payload.t === 'more') {
      if (!Number.isSafeInteger(payload.before) || payload.before < 1) throw new LinkError(400, '聊天记录位置无效');
      this.socket.send(JSON.stringify({t:'more',before:payload.before}));
      return {t:'queued'};
    }
    if (payload.t !== 'send' || typeof payload.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.id)
        || typeof payload.text !== 'string' || payload.text.length > maxText) {
      throw new LinkError(400, '聊天消息无效或过长。');
    }
    let images;
    if (payload.images !== undefined) {
      if (!Array.isArray(payload.images) || payload.images.length !== 1) throw new LinkError(400,'只可附上一张图片。');
      const image = payload.images[0];
      if (image?.mime !== 'image/jpeg' || typeof image.base64 !== 'string' ||
          image.base64.length > Math.ceil(400 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(image.base64))
        throw new LinkError(400,'图片无效或过大。');
      const bytes = Buffer.from(image.base64,'base64');
      if (bytes.length > 400 * 1024 || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 ||
          bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new LinkError(400,'图片不是可用的 JPEG。');
      images = [{mime:'image/jpeg',base64:image.base64,name:String(image.name??'图片.jpg').slice(0,120)}];
    }
    if (!payload.text.trim() && !images) throw new LinkError(400,'请输入消息或附上图片。');
    const fingerprint = digest(JSON.stringify([payload.text,images]));
    const previous = this.receipts.get(payload.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new LinkError(409, '该消息已用同一编号提交过。');
      return previous.result;
    }
    const send = async () => {
      try { if (this.target===nativeTarget) await this.speechTarget.ensure(this.cookie); }
      catch (error) { throw new LinkError(503, error.message); }
      if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new LinkError(503, 'Coo 聊天已断开，请连接后重发。');
      return new Promise(resolve => {
        const finish = frame => {
          clearTimeout(timer);
          this.pending.delete(payload.id);
          resolve(frame ?? {t:'unknown',reason:'没有收到 Coo 回执，请先查看聊天记录。'});
        };
        const timer = setTimeout(() => finish(null), 5000);
        this.pending.set(payload.id, finish);
        this.socket.send(JSON.stringify({t:'send',id:payload.id,text:payload.text,...(images?{images}:{})}), error => { if (error) finish(null); });
      });
    };
    const result = send().catch(error => {
      this.receipts.delete(payload.id);
      throw error;
    });
    this.receipts.set(payload.id, {fingerprint,result});
    if (this.receipts.size > 128) this.receipts.delete(this.receipts.keys().next().value);
    return result;
  }

  close() { this.socket.terminate(); }
}

function addresses() {
  return [...new Set(Object.entries(networkInterfaces()).filter(([name]) => !/tun|clash|virtual|loopback|vethernet/i.test(name))
    .flatMap(([,items]) => items.filter(item => item.family === 'IPv4' && !item.internal && privateIp.test(item.address)).map(item => item.address)))];
}

const apkMime = 'application/vnd.android.package-archive';
const packagedApk = fileURLToPath(new URL('./client/figure-pet-1.0.0.apk', import.meta.url));

export function apkInfo(path = packagedApk) {
  const file = statSync(path, {throwIfNoEntry:false});
  return file?.isFile() && file.size > 0 ? {size:file.size} : null;
}

export function androidApk(path = packagedApk) {
  if (!apkInfo(path)) throw new LinkError(404,'这台电脑还没有 Figure Pet 安装包。');
  const bytes = readFileSync(path);
  // Core validates the size and digest before returning the file to the workbench.
  return {$file:{mime:apkMime,path,bytes:bytes.length,sha256:digest(bytes)}};
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startLink({
  relayPort = defaultRelayPort,
  cooPort = defaultConsolePort,
  home,
  figureScapeOrigin,
  getPassword = () => '',
  onError = () => {},
}) {
  const cooOrigin = 'http://' + localAddress + ':' + cooPort;

  mkdirSync(home, {recursive:true,mode:0o700});
  const identity = certificate(join(home, 'identity.json'));
  const chatMedia = createChatMedia(cooOrigin, identity.key);
  const fingerprint = digest(new X509Certificate(identity.cert).raw);
  const deviceFile = join(home, 'devices.json');
  let devices = read(deviceFile, []);
  let ticket = null;
  const channels = new Map();
  const speechTarget = new CooSpeechTarget(cooOrigin);
  const connectionRequests = new Map();
  let stopped = false;
  let cleanupTimer;
  const cooCookie = () => loginCoo(cooOrigin, getPassword);
  const {activeCharacter, changeCharacterLook, characterAsset, characterCatalog, characterPackage, frameFile} =
    createCharacterService({cooOrigin, cooCookie, figureScapeOrigin});
  async function setupStatus() {
    const coo = await cooCookie().then(() => ({ready:true, coo:'Coo 已就绪'}), error => ({ready:false, coo:error.message}));
    return {...coo,addresses:addresses(),devices:devices.map(({id,name,added}) => ({id,name,added}))};
  }
  async function createPairCode(ip) {
    if (!addresses().includes(ip)) throw new LinkError(400,'请选择电脑的局域网地址。');
    const code = nonce();
    const url = new URL('yume-coo://pair');
    url.search = new URLSearchParams({endpoint:'https://' + ip + ':' + relayPort,fingerprint,code}).toString();
    const qr = await QRCode.toDataURL(url.toString(),{width:336,margin:3,errorCorrectionLevel:'M'});
    const expires = Date.now()+300000;
    // A generated code replaces the previous ticket. Keep only its digest.
    ticket = {hash:digest(code),expires};
    return {qr,expires};
  }
  async function channel(device,target) {
    const key=device.id+'/'+target;
    const existing = channels.get(key);
    if (existing && !existing.closed) return existing;
    // Polls from the same device and source can arrive together during reconnect.
    if (!connectionRequests.has(key)) {
      const task = cooCookie().then(cookie => {
        if (stopped) throw new LinkError(503, 'Figure Pet 连接已停用。');
        if (!devices.some(item => item.id === device.id)) throw new LinkError(401, '这台手机的连接已解除。');
        const link = new ChatLink({cookie,target,cooOrigin,speechTarget,onClose: closed => {
          if (channels.get(key) === closed) channels.delete(key);
          if (![...channels.values()].some(item=>item.target===nativeTarget)) speechTarget.release();
        }});
        channels.set(key, link);
        return link;
      }).finally(() => connectionRequests.delete(key));
      connectionRequests.set(key, task);
    }
    return connectionRequests.get(key);
  }

  function revoke(deviceId) {
    const next = devices.filter(item => item.id !== deviceId);
    save(deviceFile,next);
    devices = next;
    for(const [key,link] of channels)if(key.startsWith(deviceId+'/')){link.close();channels.delete(key);}
    if (![...channels.values()].some(item=>item.target===nativeTarget)) speechTarget.release();
  }

  function withErrors(handle) {
    return (req, res) => {
      if (stopped) return json(res, {error:'Figure Pet 连接已停用。'},503);
      void handle(req,res).catch(error => {
      if (res.headersSent) res.destroy();
      else json(res,{error:error instanceof LinkError || [404,409,413,422].includes(error.status) ? error.message : '连接暂时不可用，请重试。'},error.status ?? 500);
      });
    };
  }

  const relay = httpsServer({...identity,minVersion:'TLSv1.2'},withErrors(async (req,res) => {
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/,'');
    if (!privateIp.test(peer)) throw new LinkError(403,'连接只供局域网设备使用。');
    const url = new URL(req.url,'https://yume.local');
    if (req.method === 'POST' && url.pathname === '/pair') {
      const body = await jsonBody(req);
      if (typeof body.code !== 'string' || !ticket || ticket.expires < Date.now() || ticket.hash !== digest(body.code)) {
        throw new LinkError(401,'配对码已过期或已使用，请在电脑上重新生成。');
      }
      const name = typeof body.name === 'string' ? body.name.trim().slice(0,60) || 'Android 手机' : 'Android 手机';
      const token = nonce();
      const device = {id:randomUUID(), name, hash:digest(token), added:new Date().toISOString()};
      const next = [...devices,device];
      save(deviceFile,next);
      devices = next;
      ticket = null;
      return json(res,{token,id:device.id});
    }
    const auth = String(req.headers.authorization ?? '');
    const device = auth.startsWith('Bearer ') && devices.find(item => item.hash === digest(auth.slice(7)));
    if (!device) throw new LinkError(401,'这台手机的连接已解除，请重新扫码。');
    if (req.method === 'POST' && url.pathname === '/disconnect') {
      revoke(device.id);
      return json(res,{ok:true});
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const link = await channel(device,targetOf(url.searchParams.get('target')));
      const same = url.searchParams.get('connection') === link.id;
      const after = same ? Number(url.searchParams.get('after') ?? 0) : 0;
      if (!Number.isSafeInteger(after) || after < 0) throw new LinkError(400,'事件游标无效。');
      if (same && after && link.frames[0]?.seq > after+1) {
        link.close();
        throw new LinkError(409,'聊天记录正在重新同步。');
      }
      link.lastUsed = Date.now();
      const events = link.frames.filter(item => item.seq > after).map(({seq, frame}) => ({
        seq, frame: chatMedia.frameForPhone(frame, device.id, link.target),
      }));
      return json(res,{connection:link.id,after:events.at(-1)?.seq ?? after,events,ready:link.ready});
    }
    if (req.method === 'GET' && url.pathname === '/chat/image') {
      const target = targetOf(url.searchParams.get('target'));
      const cookie = channels.get(device.id+'/'+target)?.cookie ?? await cooCookie();
      const {mime,bytes} = await chatMedia.readImage({deviceId:device.id,target,id:url.searchParams.get('id'),cookie});
      res.writeHead(200,{'content-type':mime,'content-length':bytes.length,'x-resource-sha256':digest(bytes),
        'cache-control':'no-store','x-content-type-options':'nosniff'});
      return res.end(bytes);
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const body = await jsonBody(req,600 * 1024);
      const link = channels.get(device.id+'/'+targetOf(body.target));
      if (!link || link.id !== body.connection) throw new LinkError(409,'连接已变化，请等聊天重新同步。');
      return json(res,await link.dispatch(body));
    }
    if(req.method==='GET' && url.pathname==='/character'){
      const target=targetOf(url.searchParams.get('target'));
      return json(res,{character:await activeCharacter(target)});
    }
    if(req.method==='GET' && url.pathname==='/character/catalog'){
      const target=targetOf(url.searchParams.get('target'));
      return json(res,{models:await characterCatalog(target)});
    }
    if(req.method==='GET' && url.pathname==='/character/package'){
      const target=targetOf(url.searchParams.get('target'));
      return json(res,await characterPackage(target,url.searchParams.get('id')));
    }
    if(req.method==='GET' && ['/character/file','/character/frame-file'].includes(url.pathname)){
      const revision=url.searchParams.get('revision'),name=url.searchParams.get('name');
      const value=url.pathname.endsWith('/frame-file')
        ? await frameFile(targetOf(url.searchParams.get('target')),url.searchParams.get('id'),revision,name)
        : await characterAsset(revision,name);
      res.writeHead(200,{'content-type':'application/octet-stream','content-length':value.length,'cache-control':'no-store',
        'x-resource-sha256':digest(value)});
      return res.end(value);
    }
    if(req.method==='POST' && url.pathname==='/character/wear'){
      const body=await jsonBody(req);
      return json(res,{character:await changeCharacterLook(targetOf(body.target),body)});
    }
    throw new LinkError(404,'连接接口不存在。');
  }));

  let closing;
  function stop() {
    if (closing) return closing;
    stopped = true;
    ticket = null;
    clearInterval(cleanupTimer);
    for (const link of channels.values()) link.close();
    channels.clear();
    speechTarget.release();
    closing = closeServer(relay);
    return closing;
  }

  relay.requestTimeout = 15000;
  relay.headersTimeout = 10000;
  try {
    await listen(relay, relayPort, '0.0.0.0');
  } catch (error) {
    await stop();
    throw error;
  }
  relay.on('error', onError);
  cleanupTimer = setInterval(() => {
    for (const link of channels.values()) if (Date.now()-link.lastUsed > 30000) link.close();
  },15000).unref();
  return {setupStatus, createPairCode, revoke, stop};
}
