
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { expect, test, vi } from 'vitest';
import { startLink } from '../src/phone-link/link.mjs';

const qr = vi.hoisted(() => ({ pairUrl: '' }));
vi.mock('qrcode', () => ({
  default: { toDataURL: async (value: string) => { qr.pairUrl = value; return 'data:image/png;base64,fixture'; } },
}));
const lan = Object.values(networkInterfaces()).flat().find(ip =>
  ip?.family === 'IPv4' && !ip.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(ip.address),
)?.address;

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}
async function body(req: IncomingMessage) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Test socket has no port');
  return address.port;
}
function close(server: ReturnType<typeof createServer>) {
  return new Promise<void>(resolve => server.close(() => resolve()));
}

test.skipIf(!lan)('paired phone uses only this World for chat, character, assets and wardrobe', async () => {
  const home = await mkdtemp(join(tmpdir(), 'scape-phone-scope-'));
  const fakePassword = 'fixture-password';
  const existingToken = 'fixture-previous-device-token';
  const requests: string[] = [];
  const scope = '/api/webui/providers/world%3Adesktop-live2d-pet/panels/framework/';
  const ownSocket = '/ws/providers/world%3Adesktop-live2d-pet/panels/chat';
  let scheme = 'home';
  let message = '';
  const bodyAsset = 'export function renderFigure() {}';
  const character = {
    id: 'demo', base: '/packs/demo/', entry: 'figure.js', export: 'renderFigure', name: 'Demo',
    axes: [{ id: 'dress', options: [{ id: 'home' }, { id: 'travel' }] }],
  };
  const consoleServer = createServer((req, res) => {
    requests.push(req.url ?? '');
    void (async () => {
      if (req.url === '/api/auth/status') return json(res, { required: true });
      if (req.url === '/api/auth/login' && (await body(req)).password === fakePassword) {
        res.setHeader('set-cookie', ['fixture=paired; HttpOnly']);
        return json(res, { ok: true });
      }
      if (req.headers.cookie !== 'fixture=paired') return json(res, {}, 401);
      if (req.url === scope + 'resources') return json(res, [{ id: 'demo', name: 'Demo' }]);
      if (req.url === scope + 'resources.chooseWardrobe') {
        scheme = (await body(req)).args[1];
        return json(res, {});
      }
      return json(res, {}, 404);
    })().catch(() => json(res, {}, 500));
  });
  const socketServer = new WebSocketServer({ noServer: true });
  consoleServer.on('upgrade', (req, socket, head) => {
    requests.push(req.url ?? '');
    if (req.url !== ownSocket || req.headers.cookie !== 'fixture=paired') return socket.destroy();
    socketServer.handleUpgrade(req, socket, head, channel => {
      channel.on('message', bytes => {
        const frame = JSON.parse(String(bytes));
        if (frame.t === 'hello') channel.send(JSON.stringify({ t: 'init', bot: 'Scape', items: [] }));
        if (frame.t === 'send') {
          message = frame.text;
          channel.send(JSON.stringify({ t: 'sent', id: frame.id, cursor: 1 }));
          channel.send(JSON.stringify({ t: 'item', item: { kind: 'say', cursor: 2, text: 'own reply' } }));
        }
      });
    });
  });
  const ownServer = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/api/state') return json(res, { skin: { figure: 'demo', scheme } });
    if (req.url === '/api/bodies/demo') return json(res, character);
    if (req.url === '/packs/demo/figure.json') return json(res, { version: 1 });
    if (req.url === '/packs/demo/figure.js') return res.end(bodyAsset);
    return json(res, {}, 404);
  });
  let relay: Awaited<ReturnType<typeof startLink>> | undefined;
  try {
    const [cooPort, ownPort] = await Promise.all([listen(consoleServer), listen(ownServer)]);
    const reserve = createServer();
    const relayPort = await listen(reserve);
    await close(reserve);
    await writeFile(join(home, 'devices.json'), JSON.stringify([{ id: 'previous', name: 'Already paired',
      hash: createHash('sha256').update(existingToken).digest('hex'), added: '2026-11-20' }]));
    relay = await startLink({ home, cooPort, relayPort, getPassword: () => fakePassword,
      figureScapeOrigin: () => 'http://127.0.0.1:' + ownPort });
    const { cert } = JSON.parse(await readFile(join(home, 'identity.json'), 'utf8'));
    async function call(path: string, token = existingToken, data?: unknown): Promise<{ code: number; payload: any }> {
      const encoded = data === undefined ? undefined : JSON.stringify(data);
      return new Promise((resolve, reject) => {
        const outgoing = request({ hostname: lan, port: relayPort, path,
          ca: cert, checkServerIdentity: () => undefined,
          method: encoded ? 'POST' : 'GET',
          headers: { ...(token ? { authorization: 'Bearer ' + token } : {}),
            ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}) },
        }, res => {
          const parts: Buffer[] = [];
          res.on('data', (bytes: Buffer) => parts.push(bytes));
          res.on('end', () => {
            const str = Buffer.concat(parts).toString('utf8');
            let payload;
            try { payload = JSON.parse(str); } catch { payload = str; }
            resolve({ code: res.statusCode!, payload });
          });
          res.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.end(encoded);
      });
    }
    expect(await relay.setupStatus()).toMatchObject({ ready: true, devices: [{ id: 'previous' }] });
    await relay.createPairCode(lan!);
    const code = new URL(qr.pairUrl).searchParams.get('code');
    const paired = await call('/pair', '', { code, name: 'New phone' });
    expect(paired).toMatchObject({ code: 200 });
    const token = String(paired.payload.token);
    expect((await call('/pair', '', { code, name: 'Replay' })).code).toBe(401);
    const before = requests.length;
    for (const path of ['/events', '/character', '/character/catalog', '/character/package', '/character/file', '/character/frame-file', '/chat/image']) {
      expect((await call(path + '?target=desktop-pet', token)).code).toBe(400);
    }
    expect((await call('/chat',token,{ target: 'desktop-pet' })).code).toBe(400);
    expect((await call('/character/wear',token,{ target: 'desktop-pet' })).code).toBe(400);
    expect(requests).toHaveLength(before);
    expect((await call('/character')).payload.character).toMatchObject({ target: 'desktop-live2d-pet', scheme: 'home' });
    expect((await call('/character/catalog', token)).payload.models).toEqual([{ id: 'demo', name: 'Demo' }]);
    const pack = (await call('/character/package?id=demo', token)).payload;
    expect(pack).toMatchObject({ engine: 'body-api-2', target: 'desktop-live2d-pet' });
    expect((await call('/character/frame-file?id=demo&revision=' + pack.revision + '&name=figure.js', token)).payload).toBe(bodyAsset);
    expect((await call('/character/wear', token, { id: 'demo', scheme: 'home', axis: 'dress', option: 'travel' })).payload.character.picks).toEqual({ dress: 'travel' });
    let connection = '';
    await vi.waitFor(async () => {
      const events = await call('/events?target=desktop-live2d-pet', token);
      expect(events.payload.ready).toBe(true);
      expect(events.payload.events[0].frame.bot).toBe('Scape');
      connection = events.payload.connection;
    });
    expect((await call('/chat', token, { connection, t:'send', id:'a8aa02ee-98ab-4287-a91f-954d15f246ab', text:'phone line' })).payload)
      .toMatchObject({ t: 'sent', cursor: 1 });
    expect(message).toBe('phone line');
    await vi.waitFor(async () => {
      expect((await call('/events?connection=' + connection, token)).payload.events[1].frame.item.text).toBe('own reply');
    });
    expect(requests.some(path => path.includes('world%3Adesktop-pet') || path === '/api/figures')).toBe(false);
  } finally {
    await relay?.stop();
    for (const channel of socketServer.clients) channel.terminate();
    socketServer.close();
    await Promise.all([close(consoleServer),close(ownServer)]);
  }
}, 15000);
