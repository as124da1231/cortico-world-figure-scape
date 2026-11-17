const { app, BrowserWindow } = require('electron');
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
    webPreferences: { sandbox:true, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false, offscreen:true },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({action:'deny'}));
  contents.on('will-navigate', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents,_permission,reply) => reply(false));
  contents.session.webRequest.onBeforeRequest(({url:request},reply) => reply({cancel:!request.startsWith(url.origin + '/') && !request.startsWith(url.origin.replace('http:','ws:') + '/') && !/^(data|blob|about):/.test(request)}));
  contents.on('render-process-gone', () => app.exit(2));
  contents.setFrameRate(20);
  let ready = false, sending = false;
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
