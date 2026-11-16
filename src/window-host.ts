/**
 * Starts and stops the process that shows the pet window: an Electron main process running
 * `host/electron-main.cjs`, which opens a transparent, frameless, always-on-top window over
 * the work area of one display (the primary one at start) and loads the pet page.
 *
 * Live2D runs its own main script using a configured, managed or locally installed Electron.
 * Explicit embedding commands remain supported. The built-in --pet-host belongs to Desktop Pet.
 *
 * Why the window is not there (`HostState.reason`) is kept as data: the bot reads it in its receipts in the
 * model-text language (`model-text.ts`), people read it in the page's language (`i18n/`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'cortico/core/types.ts';
import type { HostReason } from './host-reason.ts';

export const HOST_ENV = 'CORTICO_DESKTOP_PET_HOST';
const HOST_MAIN = fileURLToPath(new URL('../host/electron-main.cjs', import.meta.url));

export type HostPhase = 'stopped' | 'running' | 'missing' | 'error';

export interface HostState {
  phase: HostPhase;
  pid: number | null;
  /** Which command runs the window. */
  source: string | null;
  reason: HostReason | null;
}

export type HostCommand = { command: string; args: string[]; source: string } | { missing: HostReason };

export function resolveHostCommand(url: string, electronFile: string, managed: string | null, profile?: string,
  policy?: { hideFromCapture?: boolean; overTaskbar?: boolean }): HostCommand {
  const args = [HOST_MAIN, `--pet-url=${url}`, ...(profile ? [`--pet-profile=${profile}`] : []),
    ...(policy?.hideFromCapture === true ? ['--pet-hide-from-capture'] : []),
    ...(policy?.overTaskbar === false ? ['--pet-no-taskbar-overlap'] : [])];
  const env = process.env[HOST_ENV];
  if (env) {
    try {
      const argv = JSON.parse(env) as unknown;
      if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string')) {
        if (!argv.includes('--pet-host')) return { command: argv[0], args: [...argv.slice(1), `--pet-url=${url}`], source: HOST_ENV };
      } else return { missing: { kind: 'badHostEnv', env: HOST_ENV } };
    } catch { return { missing: { kind: 'badHostEnv', env: HOST_ENV } }; }
  }
  if (electronFile) {
    if (!existsSync(electronFile)) return { missing: { kind: 'noElectronFile', file: electronFile } };
    return { command: electronFile, args, source: electronFile };
  }
  if (managed) return { command: managed, args, source: managed };
  try {
    // Requiring Electron can synchronously download a missing binary and block the Core.
    const packageDir = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
    const pathFile = join(packageDir, 'path.txt');
    const override = process.env.ELECTRON_OVERRIDE_DIST_PATH;
    const file = existsSync(pathFile) ? readFileSync(pathFile, 'utf8').trim() : override ? 'electron' : '';
    if (file) {
      const bin = join(override || join(packageDir, 'dist'), file);
      if (existsSync(bin)) return { command: bin, args, source: bin };
    }
  } catch { /* not installed */ }
  return { missing: { kind: 'noElectron' } };
}

export class WindowHost {
  private child: ChildProcess | null = null;
  private st: HostState = { phase: 'stopped', pid: null, source: null, reason: null };

  constructor(private readonly log: Logger) {}

  state(): HostState {
    return { ...this.st, pid: this.child?.pid ?? null };
  }

  start(cmd: HostCommand): void {
    if (this.child) return;
    if ('missing' in cmd) {
      this.st = { phase: 'missing', pid: null, source: null, reason: cmd.missing };
      return;
    }
    const env = { ...process.env };
    // an embedding Electron app may run this process as Node; the window process must not
    delete env.ELECTRON_RUN_AS_NODE;
    let child: ChildProcess;
    try {
      // the window closes by itself if this process dies without stopping it
      child = spawn(cmd.command, [...cmd.args, `--parent-pid=${process.pid}`],
        { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    } catch (err) {
      this.st = { phase: 'error', pid: null, source: cmd.source, reason: { kind: 'startFailed', why: (err as Error).message } };
      return;
    }
    this.child = child;
    this.st = { phase: 'running', pid: child.pid ?? null, source: cmd.source, reason: null };
    const log = this.log.child('window');
    const forward = (d: Buffer) => { for (const line of d.toString().split(/\r?\n/)) if (line.trim()) log.debug(line); };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('error', (err) => {
      log.warn(`窗口进程出错:${err.message}`);
      this.st = { ...this.st, phase: 'error', reason: { kind: 'error', message: err.message } };
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      // a window process that ends on its own with a failure is logged; Windows exit codes such as 0x80000003 read in hex
      if (code !== 0) {
        const how = code === null ? signal : process.platform === 'win32' ? `0x${(code >>> 0).toString(16).toUpperCase()}` : code;
        log.warn(`窗口进程退出(退出码 ${how})`);
      }
      this.st = { phase: 'stopped', pid: null, source: cmd.source, reason: code === 0 ? { kind: 'closed' } : { kind: 'exited', code } };
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.st = { ...this.st, phase: 'stopped', pid: null, reason: null };
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }
  }
}
