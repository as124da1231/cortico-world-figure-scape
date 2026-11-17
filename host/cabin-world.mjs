import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';

const [root, dataDir, mode, profile, installMode] = process.argv.slice(2);
const bundled = installMode === '--bundled';
const figure = profile ? JSON.parse(profile) : null;
const source = join(root, 'CabinWorld.exe');
let bridge, game, renderer, frames, gamePeer, renderPeer, stage, positionTimer, bodyDisconnectTimer, stopping = false;

function running(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

async function waitForExit(child, timeout) {
  const deadline = Date.now() + timeout;
  while (running(child) && Date.now() < deadline) await delay(60);
}

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(positionTimer);
  clearTimeout(bodyDisconnectTimer);
  try {
    if (running(game) && bridge?.host.connected) {
      bridge.host.send({type:'quit'});
      await waitForExit(game,3000);
    }
    if (running(game)) game.kill();
    renderPeer?.terminate();
    gamePeer?.terminate();
    frames?.close();
    bridge?.server.closeAllConnections();
    await bridge?.close();
    await waitForExit(game,1200);
    await waitForExit(renderer,1200);
    if (running(renderer)) {
      renderer.kill();
      await waitForExit(renderer,800);
    }
    if (stage) await rm(stage,{recursive:true,force:true,maxRetries:2,retryDelay:150}).catch(() => {});
  } finally {
    process.exit(0);
  }
}

async function stagePortrait() {
  const preview = new URL(figure.url);
  const id = preview.searchParams.get('model');
  if (preview.protocol !== 'http:' || preview.hostname !== '127.0.0.1' || !/^figure-[a-f0-9]{24}$/.test(id)) return '';
  const base = new URL('/figure-assets/'+id+'/',preview);
  const options = { redirect:'error', signal:AbortSignal.timeout(2500) };
  const manifest = await fetch(new URL('figure.json',base),options);
  if (!manifest.ok) return '';
  const {thumb} = await manifest.json();
  if (typeof thumb !== 'string') return '';
  const cover = new URL(thumb,base);
  const extension = /\.(png|webp|jpe?g)$/i.exec(cover.pathname)?.[0];
  if (cover.origin !== base.origin || !cover.pathname.startsWith(base.pathname) || !extension) return '';
  const response = await fetch(cover,options);
  if (!response.ok || !response.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 2 * 1024 * 1024) return '';
    chunks.push(chunk);
  }
  if (!size) return '';
  const file = join(stage,'portrait'+extension.toLowerCase());
  await writeFile(file,Buffer.concat(chunks,size));
  return file;
}

async function prepareBody() {
  const stageRoot = bundled ? dataDir : root;
  await mkdir(stageRoot,{recursive:true});
  stage = await mkdtemp(join(stageRoot,'.figure-scape-'));
  const exe = join(stage,'CabinWorld.exe');
  await link(source,exe).catch(async error => {
    if (error.code !== 'EXDEV') throw error;
    await copyFile(source,exe);
  });
  const script = join(stage,'body.gd');
  const chatScript = join(stage,'chat.gd');
  await Promise.all([
    [script,'./cabin-body.gd'], [chatScript,'./cabin-chat.gd'],
  ].map(async ([file,resource]) => writeFile(file,await readFile(new URL(resource,import.meta.url)))));
  await writeFile(join(stage,'override.cfg'),'[autoload]\nFigureScapeBody="*'+script.replaceAll('\\','/').replaceAll('"','\\"')+'"\n');
  const ini = bundled ? '' : await readFile(join(root,'cabinworld.ini'),'utf8').catch(() => '');
  const save = [...ini.matchAll(/^\s*save\s*=\s*([^\r\n]+)/gm)].at(-1)?.[1].trim();
  const savePath = save ? resolve(root,save) : null;

  const key = randomBytes(24).toString('hex');
  frames = new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:512 * 1024,perMessageDeflate:false});
  frames.on('error', () => { if (!stopping) void stop(); });
  await new Promise((done,reject) => { frames.once('listening',done); frames.once('error',reject); });
  const frameUrl = 'ws://127.0.0.1:'+frames.address().port+'/'+key;
  let lastFrame, positionReported = false;
  positionTimer = setInterval(() => {
    if (!positionReported && bridge?.ready && gamePeer?.readyState === WebSocket.OPEN) gamePeer.send('report-position', () => {});
  },350);
  positionTimer.unref();
  frames.on('connection',(socket,request) => {
    if (request.url === '/source/'+key && !renderPeer) {
      renderPeer = socket;
      socket.on('error', () => {});
      socket.on('message',(frame,binary) => {
        if (!binary || !Buffer.isBuffer(frame)) return;
        lastFrame = frame;
        if (gamePeer?.readyState === WebSocket.OPEN && gamePeer.bufferedAmount === 0) {
          gamePeer.send(frame,{binary:true},() => {});
        }
      });
      socket.on('close', () => { if (renderPeer === socket) renderPeer = undefined; });
      return;
    }
    if (request.url !== '/'+key || gamePeer) {socket.close(1008);return;}
    gamePeer = socket;
    clearTimeout(bodyDisconnectTimer);
    socket.on('error', () => {});
    socket.on('message',(data,binary) => {
      if (binary) return;
      const message = data.toString();
      if (message === 'position-reported') positionReported = true;
      if (message === 'ready' && process.connected) process.send('body-ready');
      if (message === 'presented' && process.connected) process.send('body-presented');
      if (message.length > 4096 || message[0] !== '{' || !process.connected) return;
      let request;
      try { request = JSON.parse(message); } catch { return; }
      if (request?.type === 'chat-read') process.send({type:'chat-read'});
      if (request?.type === 'chat-send' && typeof request.id === 'string' && typeof request.text === 'string') {
        process.send({type:'chat-send',id:request.id,text:request.text});
      }
    });
    socket.on('close', () => {
      if (gamePeer !== socket) return;
      gamePeer = undefined;
      if (stopping) return;
      bodyDisconnectTimer = setTimeout(() => {
        if (!gamePeer && running(game) && process.connected) process.send('body-lost');
      },1500);
    });
    if (lastFrame) socket.send(lastFrame, {binary:true}, () => {});
  });
  const rendererProfile = join(stage,'render');
  await mkdir(rendererProfile);
  const rendererEnv = {
    ...process.env,
    FIGURE_SCAPE_RENDER_URL:figure.url,
    FIGURE_SCAPE_RENDER_PROFILE:rendererProfile,
    FIGURE_SCAPE_RENDER_CHANNEL:'ws://127.0.0.1:'+frames.address().port+'/source/'+key,
  };
  delete rendererEnv.ELECTRON_RUN_AS_NODE;
  function startRenderer() {
    if (stopping || renderer) return;
    renderer = spawn(figure.electron,[fileURLToPath(new URL('./cabin-render.cjs',import.meta.url))],{
      env:rendererEnv,stdio:['ignore','ignore','inherit'],windowsHide:true,
    });
    const lost = () => { if (!stopping && process.connected) process.send('body-lost'); };
    renderer.once('error',lost);
    renderer.once('exit',code => { if (!stopping) console.error('Cabin figure renderer exited:',code); lost(); });
  }
  const portraitCache = join(dataDir,'figure-scape','portraits');
  await mkdir(portraitCache,{recursive:true}).catch(() => {});
  const portraitSource = await stagePortrait().catch(() => '');
  return {exe,savePath,startRenderer,env:{
    FIGURE_SCAPE_CABIN_ACTOR:figure.key,
    FIGURE_SCAPE_CABIN_BODY:frameUrl,
    FIGURE_SCAPE_CABIN_PORTRAITS:portraitCache,
    FIGURE_SCAPE_CABIN_PORTRAIT_SOURCE:portraitSource,
    FIGURE_SCAPE_CABIN_CHAT:chatScript,
  }};
}

try {
  process.on('message', message => {
    if (message === 'stop') void stop();
    if (message === 'reveal-body' && gamePeer?.readyState === WebSocket.OPEN) gamePeer.send('reveal', () => {});
    if ((message?.type === 'chat-state' || message?.type === 'chat-result') && gamePeer?.readyState === WebSocket.OPEN) {
      gamePeer.send(JSON.stringify(message), () => {});
    }
  });
  process.on('disconnect', () => void stop());
  const { loadConfig, startBridge } = await import(pathToFileURL(join(root,'bridge','bridge.mjs')).href);
  const config = loadConfig(join(root,'bridge','bridge.config.json'));
  Object.assign(config,{dataDir,gameExe:source,http:{host:'127.0.0.1',port:0}});
  const body = figure ? await prepareBody() : null;
  if (figure) config.residents = [...config.residents.filter(resident => resident.key !== figure.key),{key:figure.key,name:figure.name}];
  bridge = await startBridge(config,{launch:false,quiet:true});
  if (!process.connected) await stop();
  // An already open standalone game may reconnect to the regular bridge.
  if (!body) await delay(1200);
  if (bridge.host.connected || stopping) {
    if (bridge.host.connected) bridge.host.once('disconnected',() => void stop());
  } else {
    if (body) bridge.host.once('connected',body.startRenderer);
    const exe = body?.exe ?? source;
    const save = bundled ? join(dataDir,'saves') : body?.savePath;
    game = spawn(exe,[
      ...(mode === '--headless' ? ['--headless'] : []),
      ...(body && mode !== '--headless' ? ['--position','-16000,-16000'] : []),
      '--log-file',join(dataDir,'window.log'),
      '--','--data',dataDir,'--layout',join(dataDir,'layouts','home-grid-layout.json'),
      ...(save ? ['--save',save] : []),
    ],{cwd:dirname(exe),env:{...process.env,...body?.env},stdio:'ignore',windowsHide:mode === '--headless'});
    game.once('error',() => { process.send?.('game-launch-failed'); void stop(); });
    game.once('exit',code => {
      if (!stopping && process.connected) process.send(code === 0 ? 'game-closed' : {type:'game-exited',code},() => void stop());
      else void stop();
    });
  }
} catch (error) {
  console.error('Cabin World host:',error.message);
  if (process.connected && !stopping) process.send('bridge-launch-failed',() => void stop());
  else void stop();
}
