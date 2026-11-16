import { randomUUID } from 'node:crypto';
// @ts-expect-error Shared with the renderer.
import { framingCommand } from '../../web/body-framing-contract.js';
// @ts-expect-error Shared with the renderer.
import { heldInputSnapshot } from '../../web/body-input-contract.js';

type RuntimeReport = { figure: string; snapshot: Record<string, unknown> };
type BodyCommand = { t: string; id: string; figure: string } & Record<string, unknown>;

/** Node boundary for temporary body controls. The renderer owns the applied state. */
export function createBodyControls(ports: {
  selected: () => string;
  connected: () => boolean;
  busy: () => boolean;
  report: () => RuntimeReport | null;
  send: (command: BodyCommand) => boolean;
}) {
  function snapshot() {
    if (!ports.connected()) return null;
    const report = ports.report();
    return report?.figure === ports.selected() ? report.snapshot : null;
  }

  function domains() {
    return snapshot()?.domains as { body?: { framing?: unknown; modelBehavior?: unknown }; input?: unknown } | undefined;
  }

  function target(figure: unknown, mutation = false): string {
    if (typeof figure !== 'string' || figure !== ports.selected() || (mutation && ports.busy())) {
      throw Error(mutation ? 'The active model changed or is loading' : 'The active model changed');
    }
    return figure;
  }

  function send(type: string, figure: string, data: Record<string, unknown>) {
    const requestId = randomUUID();
    if (!ports.send({ ...data, t: type, id: requestId, figure })) {
      throw Error('The main window is not connected');
    }
    return { accepted: true, requestId };
  }

  const framing = () => domains()?.body?.framing ?? null;
  return {
    snapshot,
    behavior: () => domains()?.body?.modelBehavior ?? null,
    framing,
    readFraming(figure: unknown) {
      target(figure);
      return framing();
    },
    readInput() {
      return { figure: ports.selected(), available: ports.connected(), runtime: domains()?.input ?? null };
    },
    previewFraming(figure: unknown, raw: unknown, owner: unknown) {
      const id = target(figure, true);
      if (typeof owner !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(owner)) {
        throw Error('Invalid editor owner');
      }
      const command = framingCommand(raw);
      const report = framing() as { supported?: Record<string, boolean> } | null;
      if (!report?.supported?.[command.kind]) throw Error('The active body does not support framing preview');
      return { ...send('framing-preview', id, { command, owner }), owner };
    },
    previewHeldInput(figure: unknown, raw: unknown) {
      const id = target(figure, true);
      const input = domains()?.input as { body?: { supported?: { held?: boolean } } } | undefined;
      if (!input?.body?.supported?.held) throw Error('The active body does not support held input');
      return send('held-input-preview', id, { snapshot: heldInputSnapshot(raw) });
    },
    previewMouth(figure: unknown, kind: unknown) {
      const id = target(figure, true);
      if (kind !== 'pulse' && kind !== 'release') throw Error('Unknown speech contribution command');
      return { ...send('speech-control', id, { kind }), kind };
    },
  };
}
