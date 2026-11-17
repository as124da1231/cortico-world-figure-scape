const { win32 } = require('node:path');

const systemOverlays = new Set(['screenclippinghost.exe', 'screenclip.exe', 'capturepicker.exe']);
const captureApps = new Set(['snippingtool.exe','snipaste.exe','pixpin.exe','sharex.exe','greenshot.exe','lightshot.exe','obs64.exe']);

function isCaptureWindow({exe, foreground, topmost, toolWindow, boundary, caption}) {
  if (systemOverlays.has(exe)) return true;
  if (captureApps.has(exe)) return !caption && (foreground || topmost);
  return foreground && topmost && toolWindow && boundary && !caption;
}

function createCaptureWindowReader() {
  if (process.platform !== 'win32') return () => false;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll'), k = koffi.load('kernel32.dll');
    const top = u.func('intptr_t __stdcall GetTopWindow(intptr_t hwnd)');
    const next = u.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t command)');
    const visible = u.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
    const style = u.func('int32_t __stdcall GetWindowLongW(intptr_t hwnd, int32_t index)');
    const rectangle = u.func('bool __stdcall GetWindowRect(intptr_t hwnd, void *buffer)');
    const thread = u.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)');
    const open = k.func('intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
    const image = k.func('bool __stdcall QueryFullProcessImageNameW(intptr_t process, uint32_t flags, void *name, _Inout_ uint32_t *size)');
    const close = k.func('bool __stdcall CloseHandle(intptr_t handle)');
    const bounds = Buffer.alloc(16), name = Buffer.alloc(2048), cache = new Map();
    let refreshed = 0;
    function rect(h) {
      return rectangle(h, bounds) ? [0,4,8,12].map(offset => bounds.readInt32LE(offset)) : null;
    }
    function processName(h) {
      const pid = [0];
      if (!thread(h, pid) || !pid[0]) return '';
      if (cache.has(pid[0])) return cache.get(pid[0]);
      let file = '';
      const p = open(0x1000, false, pid[0]);
      if (p) {
        try {
          const length = [name.length / 2];
          if (image(p, 0, name, length)) file = win32.basename(name.toString('utf16le', 0, length[0]*2)).toLowerCase();
        } finally { close(p); }
      }
      cache.set(pid[0], file);
      return file;
    }
    return (own, foreground) => {
      try {
        if (Date.now() - refreshed >= 2000) {cache.clear(); refreshed = Date.now();}
        const area = rect(own);
        if (!area) return false;
        const [left,topEdge,right,bottom] = area;
        function matches(h, extendedStyle) {
          if (!h || BigInt(h) === own || !visible(h)) return false;
          const box = rect(h);
          if (!box || box[2]-box[0] < 32 || box[3]-box[1] < 24) return false;
          const intersection = box[0] < right && box[2] > left && box[1] < bottom && box[3] > topEdge;
          if (!intersection) return false;
          const boundary = box[0] <= left + 12 && box[1] <= topEdge + 12 && box[2] >= right - 12 && box[3] >= bottom - 12;
          const caption = (style(h,-16) & 0x00c00000) === 0x00c00000;
          const exe = processName(h);
          return isCaptureWindow({exe,foreground:BigInt(h) === foreground,topmost:!!(extendedStyle & 8),toolWindow:!!(extendedStyle & 0x80),boundary,caption});
        }
        if (foreground && matches(foreground,style(foreground,-20))) return true;
        for (let h = top(0), count = 0; h && count < 64; h = next(h,2), count++) {
          const extended = style(h,-20);
          if ((extended & 8) && matches(h,extended)) return true;
        }
      } catch { /* The foreground window can close between calls. */ }
      return false;
    };
  } catch { return () => false; }
}

module.exports = { createCaptureWindowReader, isCaptureWindow };
