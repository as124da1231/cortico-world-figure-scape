import { execFile } from 'node:child_process';

/** Use the desktop session's default browser. Only the local model pages can be opened. */
export function openLocalBrowser(address: string): Promise<void> {
  const url = new URL(address);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !['/model-editor', '/model-preview'].includes(url.pathname)) {
    return Promise.reject(Error('Unexpected model page address'));
  }
  const [program, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url.href]]
    : process.platform === 'darwin' ? ['open', [url.href]] : ['xdg-open', [url.href]];
  return new Promise((resolve, reject) => {
    execFile(program, args, { windowsHide: true, timeout: 5000 }, error => error ? reject(error) : resolve());
  });
}
