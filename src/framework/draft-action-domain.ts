import { randomUUID } from 'node:crypto';
// @ts-expect-error Shared with the renderer.
import { draftActionCommand } from '../../web/body-draft-action-contract.js';

type DraftCommand = {
  t: 'draft-action';
  id: string;
  figure: string;
  command: { kind: 'play' | 'stop'; owner: string };
};

export function createDraftActionDomain(ports: {
  selected: () => string;
  ready: () => boolean;
  busy: () => boolean;
  send: (message: DraftCommand) => boolean;
}, timeoutMs = 3500) {
  let pending: {
    id: string;
    figure: string;
    owner: string;
    status: 'playing' | 'stopped';
    timer: ReturnType<typeof setTimeout>;
    resolve: (report: { requestId: string; owner: string; status: 'playing' | 'stopped' }) => void;
    reject: (error: Error) => void;
  } | null = null;

  function reject(error: Error) {
    if (!pending) return;
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    request.reject(error);
  }

  return {
    async run(figure: unknown, raw: unknown) {
      if (typeof figure !== 'string' || figure !== ports.selected() || ports.busy()) {
        throw Error('The active model changed or is loading');
      }
      if (!ports.ready()) throw Error('The active body does not support native draft preview');
      const command = draftActionCommand(raw), id = randomUUID();
      reject(Error('A newer draft preview superseded the request'));
      return new Promise<{ requestId: string; owner: string; status: 'playing' | 'stopped' }>((resolve, fail) => {
        const timer = setTimeout(() => reject(Error('Draft action acknowledgement timed out')), timeoutMs);
        pending = { id, figure, owner: command.owner, status: command.kind === 'play' ? 'playing' : 'stopped', timer, resolve, reject: fail };
        try {
          if (!ports.send({ t: 'draft-action', id, figure, command })) reject(Error('The main window is not connected'));
        } catch (error) {
          reject(error instanceof Error ? error : Error(String(error)));
        }
      });
    },
    receive(message: Record<string, unknown>) {
      if (!pending || message.requestId !== pending.id || message.figure !== pending.figure) return;
      if (ports.selected() !== pending.figure) {
        reject(Error('The active model changed while previewing'));
        return;
      }
      if (message.ok !== true) {
        reject(Error(String(message.reason || 'Draft action preview failed').slice(0, 400)));
        return;
      }
      const request = pending;
      const report = message.report as { requestId?: unknown; owner?: unknown; status?: unknown } | null | undefined;
      if (report?.requestId !== request.id || report.owner !== request.owner || report.status !== request.status) return;
      pending = null;
      clearTimeout(request.timer);
      request.resolve({ requestId: request.id, owner: request.owner, status: request.status });
    },
    disconnected() {
      reject(Error('The main window disconnected before acknowledging draft preview'));
    },
  };
}
