/**
 * Local HTTP + WebSocket server for the pet's pages. Binds 127.0.0.1 only and answers only
 * requests whose Host is a loopback name, so a web page cannot reach it through DNS rebinding.
 *
 * - `/pet`: the pet itself. In the pet window it is transparent and click-through outside
 *   the figure; in a browser tab it draws a floor.
 * - `/model-editor` uses its own credential for `POST /api/editor`. `/model-preview`
 *   hosts a read-only preview. Both use the model's sandboxed frame.
 * - `/api/bodies/:id` describes a direct model or figure pack. `/model-frame` limits
 *   asset access to the selected character and the runtime resources it needs.
 * - `/api/speech/clip/:id` serves audio for a requested line or voice preview.
 * - `/socket?role=pet|dress&host=window|tab`: one live pet connection plus any number of
 *   pages that only receive skin and preference updates. The window and overlay source authenticate
 *   with the key carried by `windowUrl`. A newer pet connection replaces the live one, except
 *   that a browser tab only watches while the pet window is connected. A
 *   watching tab still sends typed text, preference changes and run-control clicks.
 *   Binary frames from the pet connection are 16 kHz mono PCM16 microphone audio.
 * - `/overlay` and `/socket?role=overlay`: the OBS overlay page and its feed, while `overlay()` is on
 *   (404 and a closed socket otherwise). `/socket?role=overlay-source` is the pet window process: it is told
 *   `{ t: 'overlay', on }` (on while the overlay is on and a page watches) and its binary frames
 *   (host/overlay.cjs) go to every overlay page as they are; when it goes, the pages are sent a frame that clears them.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { languageTag, type Language } from 'cortico/core/language.ts';
import { readTextFile } from 'cortico/core/util.ts';
import type { FigurePack } from './packs.ts';
import type { FigureSettings } from './framework/figure-library.ts';
import type { createWallpaperLibrary } from './framework/wallpaper-library.ts';
import { BUNDLE_TYPE, MODEL_ARCHIVE_LIMIT, MODEL_BUNDLE_LIMIT } from './live2d/import-files.ts';
import { petText, type PetText } from './i18n/index.ts';
import type { SpeechUnit } from './speech/index.ts';
import type { ModelResources } from './framework/model-contract.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};
const EDITOR_MANIFEST = new URL('../package.json', import.meta.url);
const PAGES: Record<string, string> = { '/pet': 'pet.html', '/dress': 'workspace-entry.html', '/model-preview': 'model-preview.html' };
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const PORT_ATTEMPTS = 10;
/** Prevent a model asset opened as a page from running in the host origin. */
const RESOURCE_CSP = "sandbox allow-scripts; default-src 'none'";
/** The pages' own CSP. */
const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'self' http://127.0.0.1:* http://localhost:*";
/** What a watching pet page may still send: input that is the person's whichever page it came from. */
const WATCHER_MESSAGES = new Set(['text', 'prefs', 'control']);

export type PageMessage = Record<string, unknown> & { t: string };

import type { CoverReceipt } from './live2d/model-cover-jobs.ts';

export interface PetServerOptions {
  wallpaperAsset?: ReturnType<typeof createWallpaperLibrary>['asset'];
  wallpaperSettings?: ReturnType<typeof createWallpaperLibrary>['settings'];
  port: () => number;
  webDir: string;
  /** Snapshot sent to every new connection and served at `/api/state`. */
  snapshot(): Record<string, unknown>;
  onPetMessage(msg: PageMessage): void;
  onAudio(frame: Int16Array): void;
  onPetConnect(): void;
  onPetDisconnect(): void;
  /** A dressing page saved a skin. */
  onSkin(skin: unknown): void | Promise<void>;
  editorInvoke?(method: string, args: unknown[]): Promise<unknown>;
  media?(id: string): Promise<{ bytes: Buffer; mime: string } | null>;
  mediaPlan?(id: string): Promise<unknown[] | null>;
  importModels?(kind: 'zip' | 'bundle', bytes: Uint8Array): Promise<unknown>;
  onPrefs(prefs: Record<string, unknown>): void;
  /** The saved looks, and the list a dressing page writes back whole. */
  looks(): unknown[];
  onLooks(looks: unknown): void;
  /** The figure packs, looked up again for each request. */
  packs?(): FigurePack[];
  figureAsset?(id: string, path: string): string | null | undefined;
  figureSettings?(id: string): FigureSettings | undefined;
  models?: ModelResources;
  coverJobs?: {
    authorized(id: string, token: unknown): boolean;
    finish(id: string, token: unknown, result: CoverReceipt): void;
  };
  /** The app language, stamped on each page's `<html lang>` as it is served; the page loads its text in it. `zh` when absent. */
  language?(): Language;
  /** The text table of the app language, for errors; Chinese when absent. */
  text?(): PetText;
  /** Whether the OBS overlay is served; off when absent. */
  overlay?(): boolean;
  /** The syllables `text` is spoken as; `POST /api/speech` answers 404 without it. */
  speech?(text: string): SpeechUnit[];
}

export class PetServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private pet: WebSocket | null = null;
  private petIsWindow = false;
  /** Dressing pages and pet pages that only watch. */
  private readonly dressers = new Set<WebSocket>();
  /** The pet window process sending the overlay's frames, and the overlay pages watching. */
  private overlaySource: WebSocket | null = null;
  private readonly overlayViewers = new Set<WebSocket>();
  private readonly modelPreviews = new Set<WebSocket>();
  /** What the source was last told. */
  private overlayTold: boolean | null = null;
  private boundPort = 0;
  private readonly windowKey = randomUUID();
  private readonly editorKey = randomUUID();

  constructor(private readonly opts: PetServerOptions) {}

  get port(): number {
    return this.boundPort;
  }

  private get t(): PetText {
    return this.opts.text?.() ?? petText();
  }

  get origin(): string {
    return this.boundPort ? `http://127.0.0.1:${this.boundPort}` : '';
  }

  /** Only the window host receives this URL; its fragment stays out of HTTP requests and referrers. */
  get windowUrl(): string {
    return `${this.origin}/pet#key=${this.windowKey}`;
  }

  editorUrl(model: string, task: string): string {
    return `${this.origin}/model-editor?${new URLSearchParams({ model, task })}#key=${this.editorKey}`;
  }

  get petConnected(): boolean {
    return this.pet !== null && this.pet.readyState === this.pet.OPEN;
  }

  /** The connected pet page is the pet window, not a browser tab. */
  get petInWindow(): boolean {
    return this.petConnected && this.petIsWindow;
  }

  async start(): Promise<number> {
    const base = this.opts.port();
    let lastErr: Error | null = null;
    for (let i = 0; i < PORT_ATTEMPTS; i++) {
      const server = createServer((req, res) => { void this.handle(req, res); });
      try {
        await new Promise<void>((done, fail) => {
          server.once('error', fail);
          server.listen(base === 0 ? 0 : base + i, '127.0.0.1', () => { server.off('error', fail); done(); });
        });
      } catch (err) {
        lastErr = err as Error;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE' || code === 'EACCES') continue;
        throw err;
      }
      this.http = server;
      const addr = server.address();
      this.boundPort = typeof addr === 'object' && addr ? addr.port : 0;
      this.wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req, socket, head) => {
        if (!this.allowed(req, true)) { socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n'); return; }
        const url = new URL(req.url ?? '/', this.origin);
        if (url.pathname !== '/socket') { socket.destroy(); return; }
        const params = url.searchParams;
        if ((params.get('host') === 'window' || params.get('role') === 'overlay-source') && params.get('key') !== this.windowKey) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => this.accept(ws, req));
      });
      return this.boundPort;
    }
    throw new Error(this.t.portsTaken(base, base + PORT_ATTEMPTS - 1, lastErr?.message ?? ''));
  }

  async stop(): Promise<void> {
    for (const ws of [this.pet, ...this.dressers, this.overlaySource, ...this.overlayViewers, ...this.modelPreviews]) ws?.close();
    this.pet = null;
    this.dressers.clear();
    this.overlaySource = null;
    this.overlayViewers.clear();
    this.modelPreviews.clear();
    this.wss?.close();
    this.wss = null;
    const http = this.http;
    this.http = null;
    this.boundPort = 0;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    }
  }

  /** Sends to the pet page; false when no page is connected. */
  sendPet(msg: PageMessage): boolean {
    if (!this.petConnected) return false;
    this.pet!.send(JSON.stringify(msg));
    return true;
  }

  /** Sends to the pet page and every dressing page. */
  broadcast(msg: PageMessage): void {
    const text = JSON.stringify(msg);
    for (const ws of [this.pet, ...this.dressers]) if (ws && ws.readyState === ws.OPEN) ws.send(text);
  }

  /** Follows `overlay()`: off closes the overlay pages; the source streams while it is on and a page watches. */
  syncOverlay(): void {
    if (!this.overlayEnabled) for (const ws of this.overlayViewers) ws.close(4003, 'overlay off');
    const source = this.overlaySource;
    if (!source || source.readyState !== source.OPEN) return;
    const on = this.overlayEnabled && this.overlayViewers.size > 0;
    if (on === this.overlayTold) return;
    this.overlayTold = on;
    source.send(JSON.stringify({ t: 'overlay', on }));
  }

  private get overlayEnabled(): boolean {
    return this.opts.overlay?.() ?? false;
  }

  /** Browser writes require this service's HTTP origin; local clients may omit Origin. Reads also allow loopback and opaque origins. */
  private allowed(req: IncomingMessage, write: boolean): boolean {
    if (!LOOPBACK.test(req.headers.host ?? '')) return false;
    const origin = req.headers.origin;
    if (origin === 'null') return !write;
    if (!origin) return true;
    if (write) return origin === this.origin || origin === `http://localhost:${this.boundPort}`;
    try {
      return LOOPBACK.test(new URL(origin).host);
    } catch {
      return false;
    }
  }

  private accept(ws: WebSocket, req: IncomingMessage): void {
    const params = new URL(req.url ?? '/', 'http://x').searchParams;
    const fromWindow = params.get('host') === 'window';
    if (params.get('role') === 'model-preview') {
      const id = params.get('model') ?? '';
      const release = this.opts.models?.retainPreview?.(id) ?? (this.opts.packs?.().some(pack => pack.id === id && !pack.rawModel) ? () => {} : null);
      if (!release) { ws.close(4004, 'model unavailable'); return; }
      this.modelPreviews.add(ws);
      ws.on('close', () => { this.modelPreviews.delete(ws); release(); });
      ws.send(JSON.stringify({ t: 'preview-retained' }));
      return;
    }
    if (params.get('role') === 'overlay-source') return this.acceptOverlaySource(ws);
    if (params.get('role') === 'overlay') return this.acceptOverlayViewer(ws);
    ws.send(JSON.stringify({ t: 'init', ...this.opts.snapshot() }));
    // the pet window outranks a browser tab: a tab opened while the window is connected only watches
    const watcher = params.get('role') !== 'pet' || (!fromWindow && this.petConnected && this.petIsWindow);
    if (!watcher) {
      const old = this.pet;
      this.pet = ws;
      this.petIsWindow = fromWindow;
      if (old) old.close(4000, 'replaced');
      this.opts.onPetConnect();
      ws.on('message', (data, isBinary) => {
        if (this.pet !== ws) return;
        if (isBinary) {
          const buf = data as Buffer;
          if (buf.length % 2 === 0) this.opts.onAudio(new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
          return;
        }
        const msg = parse(data.toString());
        if (msg) this.opts.onPetMessage(msg);
      });
      ws.on('close', () => {
        if (this.pet !== ws) return;
        this.pet = null;
        this.opts.onPetDisconnect();
      });
      return;
    }
    if (params.get('role') === 'pet') {
      ws.send(JSON.stringify({ t: 'watching' }));
      ws.on('message', (data, isBinary) => {
        const msg = isBinary ? null : parse(data.toString());
        if (msg && WATCHER_MESSAGES.has(msg.t)) this.opts.onPetMessage(msg);
      });
    }
    this.dressers.add(ws);
    ws.on('close', () => this.dressers.delete(ws));
  }

  private acceptOverlaySource(ws: WebSocket): void {
    this.overlaySource?.close(4000, 'replaced');
    this.overlaySource = ws;
    this.overlayTold = null;
    ws.on('message', (data, isBinary) => {
      if (this.overlaySource !== ws || !isBinary || !this.overlayEnabled) return;
      for (const viewer of this.overlayViewers) if (viewer.readyState === viewer.OPEN) viewer.send(data, { binary: true });
    });
    ws.on('close', () => {
      if (this.overlaySource !== ws) return;
      this.overlaySource = null;
      // the window process is gone: the pages must not keep its last picture
      const clear = Buffer.alloc(24);
      for (const viewer of this.overlayViewers) if (viewer.readyState === viewer.OPEN) viewer.send(clear, { binary: true });
    });
    this.syncOverlay();
  }

  private acceptOverlayViewer(ws: WebSocket): void {
    if (!this.overlayEnabled) { ws.close(4003, 'overlay off'); return; }
    this.overlayViewers.add(ws);
    ws.on('close', () => { this.overlayViewers.delete(ws); this.syncOverlay(); });
    this.syncOverlay();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowed(req, req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(421).end(); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/api/wallpaper-settings' && req.headers.origin !== 'null' && this.opts.wallpaperSettings) {
      try { return json(res, 200, await this.opts.wallpaperSettings()); }
      catch { return json(res, 503, {error:'Wallpaper settings unavailable'}); }
    }
    const frameMatch = /^\/wallpaper-frame\/([a-f0-9]{24})$/.exec(path);
    if (req.method === 'GET' && frameMatch && this.opts.wallpaperAsset) {
      const scope = `http://localhost:${this.boundPort}/api/wallpaper-assets/${frameMatch[1]}/ ${this.origin}/api/wallpaper-assets/${frameMatch[1]}/`;
      try {
        const { live2dWallpaper } = JSON.parse(await readFile(EDITOR_MANIFEST, 'utf8'));
        if (!/^dist\/wallpaper-[A-Z0-9]+\.js$/.test(live2dWallpaper)) throw Error('Missing wallpaper bundle');
        const bundle = `${this.origin}/${live2dWallpaper}`;
        const csp = `sandbox allow-scripts; default-src 'none'; script-src ${bundle} ${scope} blob: 'unsafe-eval' 'unsafe-inline'; style-src ${scope} 'unsafe-inline'; connect-src ${scope}; img-src ${scope} data: blob:; media-src ${scope} blob:; font-src ${scope} data:; worker-src blob:; frame-src blob:; frame-ancestors ${this.origin}; form-action 'none'; base-uri ${scope}`;
        const html = `<!doctype html><meta charset="utf-8"><style>html,body,#wallpaper{width:100%;height:100%;margin:0;overflow:hidden}#wallpaper{position:relative}</style><div id="wallpaper"></div><script type="module" src="/${live2dWallpaper}"></script>`;
        res.writeHead(200, {'content-type':'text/html; charset=utf-8','content-security-policy':csp,'cache-control':'no-store','referrer-policy':'same-origin'});
        res.end(html);
      } catch { res.writeHead(503).end(); }
      return;
    }
    if (req.method === 'GET' && /^\/dist\/wallpaper-[A-Z0-9]+\.js$/.test(path)) {
      return this.sendFile(res, join(this.opts.webDir, '..', path.slice(1)), null, req.headers.origin === 'null');
    }
    const assetMatch = /^\/api\/wallpaper-assets\/([a-f0-9]{24})\/(.+)$/.exec(path);
    if ((req.method === 'GET' || req.method === 'HEAD') && assetMatch && this.opts.wallpaperAsset) {
      try {
        const file = await this.opts.wallpaperAsset(assetMatch[1], decodeURIComponent(assetMatch[2]));
        if (!file) { res.writeHead(404).end(); return; }
        const scope = `${this.origin}/api/wallpaper-assets/${assetMatch[1]}/`;
        const csp = `sandbox allow-scripts; default-src 'none'; script-src ${scope} 'unsafe-inline'; style-src ${scope} 'unsafe-inline'; img-src ${scope} data: blob:; media-src ${scope} blob:; font-src ${scope} data:; connect-src ${scope}; frame-ancestors ${this.origin}; form-action 'none'; base-uri ${scope}`;
        const headers = {'access-control-allow-origin':'null', 'content-security-policy':csp, 'x-content-type-options':'nosniff'};
        if ('json' in file) {
          res.writeHead(200, {...headers, 'content-type':MIME['.json']});
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify(file.json));
          return;
        }
        const range = req.headers.range;
        let start = 0, end = file.size - 1;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (match?.[1]) {
            start = Number(match[1]);
            if (match[2]) end = Math.min(end, Number(match[2]));
          } else if (match?.[2]) start = Math.max(0, file.size - Number(match[2]));
          if (!match || start > end || (!match[1] && !match[2])) {
            res.writeHead(416, {...headers, 'content-range':`bytes */${file.size}`}).end(); return;
          }
        }
        res.writeHead(range ? 206 : 200, {
          ...headers, 'content-type':MIME[file.extension] ?? 'application/octet-stream',
          'accept-ranges':'bytes', 'content-length':end-start+1, 'cache-control':'no-cache',
          ...(range ? {'content-range':`bytes ${start}-${end}/${file.size}`} : {}),
        });
        if (req.method === 'HEAD' || !file.size) { res.end(); return; }
        const stream = createReadStream(file.file, {start, end});
        res.on('close', () => stream.destroy());
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      } catch {
        if (!res.headersSent) res.writeHead(400).end();
        else res.destroy();
      }
      return;
    }
    if (req.method === 'POST' && path === '/api/editor' && this.opts.editorInvoke) {
      if (req.headers.authorization !== 'Bearer ' + this.editorKey) return json(res, 403, { error: 'Editor authorization required' });
      try {
        const bytes = await readBytes(req, 2 * 1024 * 1024);
        if (!bytes) return json(res, 413, { error: 'Editor request is too large' });
        const { method, args } = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (typeof method !== 'string' || !Array.isArray(args)) return json(res, 400, { error: 'Invalid editor request' });
        return json(res, 200, await this.opts.editorInvoke(method, args) ?? null);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (req.method === 'GET' && path === '/model-editor' && this.opts.editorInvoke) {
      try {
        const { live2dEditor } = JSON.parse(await readFile(EDITOR_MANIFEST, 'utf8'));
        const entry = (key: string, extension: string) => {
          const file = live2dEditor?.[key];
          if (typeof file !== 'string' || !new RegExp('^dist/editor-[A-Z0-9]+\\.' + extension + '$').test(file)) throw Error('Invalid editor asset');
          return '/' + file;
        };
        const html = (await readFile(join(this.opts.webDir, 'model-editor.html'), 'utf8'))
          .replace('EDITOR_JS', entry('script', 'js')).replace('EDITOR_CSS', entry('style', 'css'))
          .replace('lang="zh-CN"', `lang="${languageTag(this.opts.language?.() ?? 'zh')}"`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'content-security-policy': PAGE_CSP }).end(html);
      } catch {
        res.writeHead(503).end('Build the Live2D editor first');
      }
      return;
    }
    if (req.method === 'GET' && /^\/dist\/editor-[A-Z0-9]+\.(js|css)$/.test(path)) {
      return this.sendFile(res, join(this.opts.webDir, '..', path.slice(1)), null);
    }
    if(req.method==='POST'&&path==='/api/workspace'){
      this.opts.onPetMessage({t:'control',action:'dress'});
      return json(res,200,{ok:true});
    }
    if (req.method === 'GET' && path === '/workbench-browser') {
      try {
        const target = new URL(url.searchParams.get('return') ?? '');
        if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname) || target.username || target.password
          || target.pathname !== '/' || target.search || !/^#\/provider\/world%3Adesktop-live2d-pet\/framework\?task=(framing|bindings|wardrobe|visual|behavior|mouth)&model=live2d-[a-f0-9-]+$/.test(target.hash)) {
          res.writeHead(400).end(); return;
        }
        res.writeHead(302, { location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end();
      } catch { res.writeHead(400).end(); }
      return;
    }
    const coverModel = /^\/api\/model-cover\/(live2d-[a-f0-9]{16}-[a-f0-9]{8})$/.exec(path)?.[1];
    if (req.method === 'POST' && coverModel && this.opts.models?.saveGeneratedCover) {
      const job = this.opts.coverJobs;
      const token = req.headers['x-live2d-cover'];
      if (!job?.authorized(coverModel, token)) return json(res, 403, { error: 'Cover job expired' });
      const complete = (status: number, receipt: CoverReceipt) => {
        json(res, status, receipt);
        job.finish(coverModel, token, receipt);
      };
      if (req.headers['content-type'] === 'text/plain') {
        const message = await readBytes(req, 4096);
        return complete(200, { saved:false, reason:message ? Buffer.from(message).toString('utf8').trim().slice(0,320) : '封面渲染失败。' });
      }
      if (req.headers['content-type'] !== 'image/png') return complete(415, { saved:false, reason:'封面格式不受支持。' });
      const png = await readBytes(req, 512 * 1024);
      if (!png || !isCoverPng(Buffer.from(png))) return complete(400, { saved:false, reason:'未生成有效的 PNG 封面。' });
      if (!job.authorized(coverModel, token)) return json(res, 403, { error: 'Cover job expired' });
      try {
        const saved = await this.opts.models.saveGeneratedCover(coverModel, png);
        if (saved) return complete(200, { saved:true });
        return complete(409, { saved:false, reason:'这个模型已经移出模型库。' });
      } catch {
        return complete(500, { saved:false, reason:'封面保存失败。' });
      }
    }
    if(req.method==='GET'&&path==='/api/models')return json(res,200,this.opts.models?.directModels?.()??[]);
    if(req.method==='GET'&&path.startsWith('/api/bodies/')){
      const id=decodeURIComponent(path.slice('/api/bodies/'.length));
      const pack=(this.opts.packs?.()??[]).find(p=>p.id===id && (p.rawModel || /^figure-[a-f0-9]{24}$/.test(id)));
      if(!pack)return json(res,404,{error:'Body resource not found'});
      const m=pack.manifest;
      if (req.headers.origin === 'null') { res.writeHead(403).end(); return; }
      const settings = pack.rawModel ? undefined : this.opts.figureSettings?.(id);
      return json(res,200,{id:pack.id,kind:pack.rawModel?'live2d-model':'figure-pack',base:pack.base,name:m.name,version:m.version,entry:m.entry,export:m.export,model:m.model??null,
        resource:pack.rawModel??null, figureSettings:settings,axes:m.axes,presets:m.presets,vocab:m.vocab,sounds:m.sounds,can:m.can,needs:m.needs,voice:m.voice,effects:m.effects,bubble:m.bubble??null});
    }
    if(req.method==='GET'&&path==='/model-frame'){
      const id = url.searchParams.get('model');
      const figure = id && /^figure-[a-f0-9]{24}$/.test(id) && this.opts.packs?.().some(pack => pack.id === id && !pack.rawModel);
      const raw = id && (this.opts.models?.hasModel?.(id) ?? this.opts.models?.directModels?.().some(resource => resource.id === id));
      if ((!figure && !raw) || req.headers.origin === 'null') { res.writeHead(404).end(); return; }
      const self = `http://${req.headers.host}`;
      const resources = figure ? `${self}/figure-assets/${id}/` : `${self}/model-assets/${id}/`;
      const code = figure ? `${self}/web/ ${resources}` : self;
      return this.sendFile(res, join(this.opts.webDir, 'model-frame.html'), [
        'sandbox allow-scripts', "default-src 'none'", `script-src ${code}`,
        `img-src ${figure ? code : self} data: blob:`, "style-src 'unsafe-inline'", `connect-src ${resources}`,
        `font-src ${resources} data:`, `media-src ${resources} blob:`,
        `frame-ancestors ${self} http://127.0.0.1:* http://localhost:*`,
      ].join('; '));
    }
    if (req.method === 'GET' && path.startsWith('/figure-assets/')) {
      const [, , id, ...parts] = path.split('/');
      let file;
      try { file = this.opts.figureAsset?.(id, decodeURIComponent(parts.join('/'))); } catch { /* malformed path */ }
      if (!file) { res.writeHead(404).end(); return; }
      return this.sendFile(res, file, RESOURCE_CSP, req.headers.origin === 'null');
    }
    if(req.method==='GET'&&(path.startsWith('/model-assets/')||path.startsWith('/model-runtime/'))){
      let file:string|null|undefined;
      if(path.startsWith('/model-assets/')){const[,,id,...rest]=path.split('/');file=this.opts.models?.directAsset?.(id,decodeURIComponent(rest.join('/')));}
      else file=await this.opts.models?.runtimeAsset?.(decodeURIComponent(path.slice('/model-runtime/'.length)));
      if(!file){res.writeHead(404).end();return;}
      return this.sendFile(res,file,RESOURCE_CSP,req.headers.origin==='null');
    }
    if (req.method === 'POST' && path === '/api/models/import' && this.opts.importModels) {
      const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim();
      if (type !== 'application/zip' && type !== BUNDLE_TYPE) return json(res, 415, { error: this.t.importing.zipOrFolder });
      const bytes = await readBytes(req, type === BUNDLE_TYPE ? MODEL_BUNDLE_LIMIT : MODEL_ARCHIVE_LIMIT);
      if (!bytes) return json(res, 400, { error: this.t.importing.truncated });
      try { return json(res, 200, await this.opts.importModels(type === BUNDLE_TYPE ? 'bundle' : 'zip', bytes)); }
      catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, this.opts.snapshot());
    if (req.method === 'GET' && path.startsWith('/api/speech/clip/') && this.opts.media) {
      try {
        const id = path.slice('/api/speech/clip/'.length);
        if (url.searchParams.get('part') === 'plan') {
          res.setHeader('cache-control', 'no-store');
          const plan = await this.opts.mediaPlan?.(id);
          return plan ? json(res, 200, plan) : json(res, 404, { error: 'Speech plan unavailable' });
        }
        const clip = await this.opts.media(id);
        if (!clip) return json(res, 404, { error: 'Speech clip unavailable' });
        res.writeHead(200, { 'content-type': clip.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(clip.bytes);
        return;
      } catch (error) { return json(res, 502, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (req.method === 'POST' && path === '/api/speech') {
      const msg = parse(await readBody(req) ?? '');
      if (!this.opts.speech) { res.writeHead(404).end(); return; }
      if (typeof msg?.text !== 'string') return json(res, 400, { error: 'bad json' });
      return json(res, 200, { units: this.opts.speech(msg.text) });
    }
    if (req.method === 'GET' && path === '/api/looks') return json(res, 200, this.opts.looks());
    if (req.method === 'POST' && path === '/api/looks') {
      const msg = parse(await readBody(req) ?? '');
      if (!Array.isArray(msg?.looks)) return json(res, 400, { error: 'bad json' });
      this.opts.onLooks(msg.looks);
      return json(res, 200, this.opts.looks());
    }
    if (req.method === 'POST' && (path === '/api/skin' || path === '/api/prefs')) {
      const body = await readBody(req);
      const msg = body ? parse(body) : null;
      if (!msg) return json(res, 400, { error: 'bad json' });
      if (path === '/api/skin') {
        try { await this.opts.onSkin(msg.skin); }
        catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      } else this.opts.onPrefs(msg);
      return json(res, 200, { ok: true });
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (path === '/') { res.writeHead(302, { location: '/pet' }).end(); return; }
    if (path === '/overlay') {
      if (!this.overlayEnabled) { res.writeHead(404).end(); return; }
      return this.sendPage(res, join(this.opts.webDir, 'overlay.html'));
    }
    const file = PAGES[path] ?? (path.startsWith('/web/') ? path.slice(5) : null);
    if (!file) { res.writeHead(404).end(); return; }
    const root = normalize(this.opts.webDir).replace(/[\\/]+$/, '') + sep;
    const full = normalize(join(root, file));
    if (!full.startsWith(root)) { res.writeHead(403).end(); return; }
    if (PAGES[path]) return this.sendPage(res, full);
    return this.sendFile(res, full, null, path.startsWith('/web/') && req.headers.origin === 'null');
  }

  /** A page, its `<html lang>` set to the app language (`zh` as `zh-CN`). */
  private async sendPage(res: ServerResponse, full: string): Promise<void> {
    const lang = languageTag(this.opts.language?.() ?? 'zh');
    try {
      const html = readTextFile(full).replace(/<html lang="[^"]*"/, `<html lang="${lang}"`);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache', 'content-security-policy': PAGE_CSP });
      res.end(html);
    } catch {
      res.writeHead(404).end();
    }
  }

  /** A file with the pages' CSP (or `csp`); `frame` answers the figure frame's CORS request. */
  private async sendFile(res: ServerResponse, full: string, csp: string | null, frame = false): Promise<void> {
    try {
      const bytes = await readFile(full);
      res.writeHead(200, {
        'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-security-policy': csp ?? PAGE_CSP,
        'x-content-type-options': 'nosniff',
        ...(frame ? { 'access-control-allow-origin': 'null' } : {}),
      });
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  }
}

function parse(text: string): PageMessage | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as PageMessage) : null;
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** The body of `req`, or null when it is longer than `max` bytes or breaks off. */
function readBytes(req: IncomingMessage, limit: number): Promise<Uint8Array | null> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const take = (chunk: Buffer) => {
      total += chunk.length;
      if (total <= limit) { chunks.push(chunk); return; }
      chunks.length = 0;
      req.off('data', take);
      req.resume();
      done(null);
    };
    req.on('data', take);
    req.on('end', () => done(total > limit ? null : Buffer.concat(chunks)));
    req.on('error', () => done(null));
    req.on('aborted', () => done(null));
  });
}

function isCoverPng(png: Buffer): boolean {
  if (png.length < 45 || png.toString('hex', 0, 8) !== '89504e470d0a1a0a'
    || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR'
    || png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256) return false;
  let hasImage = false;
  for (let offset = 33; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) return false;
    const kind = png.toString('ascii', offset + 4, offset + 8);
    if (kind === 'IDAT' && length) hasImage = true;
    if (kind === 'IEND') return !length && hasImage && end === png.length;
    offset = end;
  }
  return false;
}

const MAX_BODY = 64 * 1024;
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((done) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); done(null); return; }
      chunks.push(c);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done(null));
  });
}
