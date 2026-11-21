const { app, BrowserWindow, ipcMain } = require('electron');
const { join } = require('node:path');
const { WebSocket } = require('ws');

const url = new URL(process.env.FIGURE_SCAPE_RENDER_URL);
const frameUrl = new URL(process.env.FIGURE_SCAPE_RENDER_CHANNEL);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/model-preview' || url.searchParams.get('cabin') !== '1' || frameUrl.protocol !== 'ws:' || frameUrl.hostname !== '127.0.0.1') app.exit(1);
const channel = new WebSocket(frameUrl, {perMessageDeflate:false});
channel.on('error', () => app.exit(2));
channel.on('close', () => app.exit());
app.setPath('userData', process.env.FIGURE_SCAPE_RENDER_PROFILE);
app.setPath('sessionData', process.env.FIGURE_SCAPE_RENDER_PROFILE);
app.commandLine.appendSwitch('disk-cache-size', '1048576');
app.commandLine.appendSwitch('disable-background-networking');

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false, width: 256, height: 384, transparent: true,
    webPreferences: { sandbox:true, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false, offscreen:true,
      autoplayPolicy:'no-user-gesture-required', preload:join(__dirname,'cabin-render-preload.cjs') },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({action:'deny'}));
  contents.on('will-navigate', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents,_permission,reply) => reply(false));
  contents.session.webRequest.onBeforeRequest(({url:request},reply) => reply({cancel:!request.startsWith(url.origin + '/') && !request.startsWith(url.origin.replace('http:','ws:') + '/') && !/^(data|blob|about):/.test(request)}));
  contents.on('render-process-gone', () => app.exit(2));
  contents.setFrameRate(20);
  let ready = false, sending = false;
  channel.on('message', (data, binary) => {
    if (binary || !ready || data.length > 256 * 1024 || contents.isDestroyed()) return;
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (['speech-play','speech-stop','speech-take'].includes(message?.type)) contents.send('cabin:speech', message);
  });
  ipcMain.on('cabin:speech-report', (event, report) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame) return;
    if (report?.type === 'body-capabilities' && typeof report.figure === 'string' && typeof report.generation === 'string' && Array.isArray(report.words)) {
      const packet = JSON.stringify({type:'body-capabilities',figure:report.figure,generation:report.generation,words:report.words,wordSource:report.wordSource});
      if (Buffer.byteLength(packet) <= 64 * 1024) {
        const send = () => { if (channel.readyState === WebSocket.OPEN) channel.send(packet, () => {}); };
        if (channel.readyState === WebSocket.CONNECTING) channel.once('open',send);
        else send();
      }
      return;
    }
    if (channel.readyState !== WebSocket.OPEN) return;
    if (report?.type === 'speech-accepted' && typeof report.id === 'string' && typeof report.generation === 'string' && typeof report.accepted === 'boolean') {
      channel.send(JSON.stringify({type:'speech-accepted',id:report.id,generation:report.generation,accepted:report.accepted}), () => {});
      return;
    }
    if (report?.type === 'body-action' && typeof report.id === 'string' && report.id.length <= 80 &&
      typeof report.generation === 'string' && report.generation.length === 36 &&
      ['running','completed','failed','interrupted'].includes(report.status)) {
      const { id,generation,status } = report;
      const completion = ['body-event','duration'].includes(report.completion) ? report.completion : undefined;
      const reason = typeof report.reason === 'string' ? report.reason.slice(0,160) : undefined;
      channel.send(JSON.stringify({type:'body-action',id,generation,status,completion,reason}), () => {});
      return;
    }
    const checkpoint = report?.type === 'speech-checkpoint' && typeof report.request === 'string';
    if ((checkpoint || report?.type === 'speech-progress') && Array.isArray(report.rows)) {
      const packet = JSON.stringify({type:report.type,...(checkpoint ? {request:report.request} : {}),rows:report.rows.slice(0,64)});
      if (Buffer.byteLength(packet) <= 16_384) channel.send(packet, () => {});
      return;
    }
    if (!report || typeof report.id !== 'string' || !['preparing','started','paused','finished','failed','cancelled'].includes(report.status)) return;
    channel.send(JSON.stringify({type:'speech-report',id:report.id,status:report.status,duration:report.duration,position:report.position,reason:report.reason}), () => {});
  });
  contents.on('paint', (_event, _dirty, image) => {
    if (!ready || sending || image.isEmpty() || channel.readyState !== WebSocket.OPEN || channel.bufferedAmount) return;
    sending = true;
    channel.send(image.toPNG(), {binary:true}, () => { sending = false; });
  });
  await contents.loadURL(url.href);
  const timer = setInterval(() => {
    void contents.executeJavaScript('document.getElementById("status")?.dataset.state').then(state => {
      if (state === 'error') {
        void contents.executeJavaScript('document.getElementById("status")?.textContent').then(reason => {
          console.error('Cabin figure preview:',reason);
          app.exit(3);
        }, () => app.exit(3));
        clearInterval(timer);
      }
      if (state === 'ready') {
        clearInterval(timer);
        // The iframe can be ready before Chromium finishes compositing its image layers.
        setTimeout(() => {
          if (contents.isDestroyed()) return;
          ready = true;
          contents.invalidate();
        },500);
      }
    }, () => app.exit(3));
  },150);
}).catch(error => { console.error('Cabin figure renderer:',error.message); app.exit(2); });
