import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhoneLinkStatus, RunningPhoneLink } from './link.mjs';

export type PhoneConnectionState = PhoneLinkStatus & {
  running: boolean;
  issue: 'port-in-use' | 'startup-failed' | null;
  apk: { size: number } | null;
};

export function createPhoneConnection(options: {
  dataDir: string;
  botDir: string;
  secret(name: string): string;
  enabled(): boolean;
  persist(enabled: boolean): void;
}) {
  const load = () => import('./link.mjs');
  let relay: RunningPhoneLink | undefined;
  let issue: PhoneConnectionState['issue'] = null;
  let queue = Promise.resolve();
  let closing = false;
  let origin = '';
  let report: (code: string) => void = () => {};

  function config() {
    try {
      const { web } = JSON.parse(readFileSync(join(options.botDir, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
      return web as { port?: number; password?: string } | undefined;
    } catch { return undefined; }
  }

  async function reconcile(enabled: boolean) {
    if (enabled && !closing && !relay) {
      try {
        const { startLink, defaultConsolePort } = await load();
        const port = Number(config()?.port);
        relay = await startLink({
          // Reuse the standalone World's identity and device store in this deployment.
          home: join(options.dataDir, 'yume-pet'),
          cooPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultConsolePort,
          figureScapeOrigin: () => origin,
          getPassword: () => options.secret('YUME_COO_CONSOLE_PASSWORD')
            || options.secret('CORTICO_WEB_PASSWORD') || config()?.password || '',
          onError: error => report(error.code ?? 'ERROR'),
        });
        issue = null;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        issue = code === 'EADDRINUSE' ? 'port-in-use' : 'startup-failed';
        report(code ?? 'ERROR');
      }
    } else if (!enabled && relay) {
      await relay.stop();
      relay = undefined;
    }
    if (!enabled) issue = null;
  }

  function schedule(run: () => Promise<void>) {
    // Startup, settings changes and World shutdown share one listener lifecycle.
    const work = queue.then(run);
    queue = work.catch(() => {});
    return work;
  }

  async function status(): Promise<PhoneConnectionState> {
    const { apkInfo } = await load();
    const live = relay;
    const details = live ? await live.setupStatus() : { ready: false, coo: '', addresses: [], devices: [] };
    // A status request can overlap disabling the listener.
    if (live !== relay) return status();
    return { ...details, running: !!live, issue, apk: apkInfo() };
  }

  return {
    start(figureScapeOrigin: string, onError: (code: string) => void) {
      origin = figureScapeOrigin;
      report = onError;
      if (options.enabled()) return schedule(() => reconcile(true));
    },
    stop() {
      closing = true;
      return schedule(() => reconcile(false));
    },
    async setEnabled(enabled: boolean) {
      await schedule(async () => {
        if (closing || !origin) throw Error('Figure Scape is not running');
        await reconcile(enabled);
        if (!enabled || relay) {
          try { options.persist(enabled); }
          catch (error) {
            await reconcile(options.enabled());
            throw error;
          }
        }
      });
      return status();
    },
    status,
    async apk() { return (await load()).androidApk(); },
    pair(address: string) {
      if (!relay || closing) throw Error('Figure Pet is not connected');
      return relay.createPairCode(address);
    },
    revoke(id: string) {
      if (!relay || closing) throw Error('Figure Pet is not connected');
      relay.revoke(id);
      return status();
    },
  };
}
