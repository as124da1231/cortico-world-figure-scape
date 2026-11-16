import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { CoverRenderer } from './model-cover-jobs.ts';

/** Same installed Chromium fallback as Figure's still image capture. */
function browserPath() {
  const locations = [
    process.env.CHROME_PATH?.trim(),
    ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter((value): value is string => !!value)
      .flatMap(root => [
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(root, 'Chromium', 'Application', 'chrome.exe'),
      ]),
  ];
  return locations.find(path => path && existsSync(path));
}

function ended(child: ChildProcess) {
  return new Promise<void>(done => {
    child.once('exit', () => done());
    child.once('error', () => done());
  });
}

async function terminate(child: ChildProcess, exit: Promise<void>) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore' });
    await ended(killer);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exit;
}

export function modelCoverRenderer(workspace: string): CoverRenderer {
  return async (url, receipt, signal) => {
    const executable = browserPath();
    if (!executable) throw Error('找不到可用于生成封面的 Chrome 或 Edge。');
    signal.throwIfAborted();
    await mkdir(workspace, { recursive:true });
    const root = await realpath(workspace);
    const profile = await mkdtemp(join(root,'render-'));
    let child: ChildProcess | undefined, exit: Promise<void> | undefined;
    let abort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      child = spawn(executable, [
        '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling',
        '--disable-background-networking', '--disable-component-update', '--disable-breakpad', '--mute-audio',
        '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=640,640',
        '--user-data-dir=' + profile, url,
      ], {
        windowsHide:true, stdio:'ignore',
        env:{ ...process.env, TEMP:profile, TMP:profile },
      });
      exit = ended(child);
      const cancelled = new Promise<never>((_done,reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort',abort,{once:true});
        if (signal.aborted) abort();
      });
      return await Promise.race([receipt, cancelled, exit.then(() => { throw Error('封面渲染进程提前结束。'); })]);
    } finally {
      if (abort) signal.removeEventListener('abort',abort);
      if (child && exit) await terminate(child,exit);
      if (resolve(profile).startsWith(root + sep)) {
        await rm(profile, { recursive:true, force:true, maxRetries:3, retryDelay:80 }).catch(() => {});
      }
    }
  };
}
