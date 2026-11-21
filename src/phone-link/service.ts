import { join } from 'node:path';
import type { PhoneLinkStatus, RunningPhoneLink } from './link.mjs';

export type PhoneConnectionState = PhoneLinkStatus & {
  running: boolean;
  issue: 'port-in-use' | 'startup-failed' | null;
  apk: { size: number } | null;
  consolePort: number;
  hasPassword: boolean;
};

export function createPhoneConnection(options: {
  dataDir: string;
  consolePort(): number | undefined;
  persistConsolePort(port: number): void;
  passwordSecret(): string | undefined;
  storePasswordSecret(value: string): void;
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

  const validPort = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
  function consolePort(fallback: number) {
    const port = options.consolePort();
    return validPort(port) ? port : fallback;
  }

  // Cortico stores one non-empty, whitespace-free value per secret. Encode
  // without trimming user passwords; the empty v1 marker clears the password.
  function password() {
    const stored = options.passwordSecret();
    if (!stored?.startsWith('v1.')) return '';
    const payload = stored.slice(3);
    const decoded = Buffer.from(payload, 'base64url');
    return decoded.toString('base64url') === payload ? decoded.toString('utf8') : '';
  }

  async function reconcile(enabled: boolean) {
    if (enabled && !closing && !relay) {
      try {
        const { startLink, defaultConsolePort } = await load();
        relay = await startLink({
          // Reuse the standalone World's identity and device store in this deployment.
          home: join(options.dataDir, 'yume-pet'),
          cooPort: consolePort(defaultConsolePort),
          figureScapeOrigin: () => origin,
          getPassword: password,
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
    const { apkInfo, defaultConsolePort } = await load();
    const live = relay;
    const details = live ? await live.setupStatus() : { ready: false, coo: '', addresses: [], devices: [] };
    // A status request can overlap disabling the listener.
    if (live !== relay) return status();
    return { ...details, running: !!live, issue, apk: apkInfo(),
      consolePort: consolePort(defaultConsolePort), hasPassword: Boolean(password()) };
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
    async configure(port: unknown, password: unknown) {
      if (!validPort(port) || (password !== undefined && (typeof password !== 'string' || password.length > 4096))) {
        throw Error('Invalid Figure Pet console settings');
      }
      await schedule(async () => {
        if (closing || relay) throw Error('Turn off Figure Pet before changing its console settings');
        if (password !== undefined) options.storePasswordSecret('v1.' + Buffer.from(password, 'utf8').toString('base64url'));
        options.persistConsolePort(port);
      });
      return status();
    },
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
