import { randomUUID } from 'node:crypto';
import type { DirectModelResource } from '../framework/model-contract.ts';

export type CoverJob = { phase: 'queued' | 'rendering' } | { phase: 'failed'; reason: string };
export type CoverReceipt = { saved: true } | { saved: false; reason: string };
export type CoverRenderer = (url: string, receipt: Promise<CoverReceipt>, signal: AbortSignal) => Promise<CoverReceipt>;

export function createModelCoverJobs(ports: {
  origin(): string;
  model(id: string): DirectModelResource | null | undefined;
  render: CoverRenderer;
  timeoutMs?: number;
}) {
  const jobs = new Map<string, CoverJob>();
  let enabled = false;
  let draining: Promise<void> | undefined;
  let current: { id: string; token: string; controller: AbortController; finish: (result: CoverReceipt) => void } | undefined;

  function needsCover(id: string) {
    const model = ports.model(id);
    return !!model && !model.cover && !model.generatedCover;
  }
  async function drain() {
    for (const [id, job] of jobs) {
      if (!enabled) break;
      if (job.phase !== 'queued') continue;
      if (!needsCover(id)) { jobs.delete(id); continue; }
      const controller = new AbortController();
      const token = randomUUID();
      let finish!: (result: CoverReceipt) => void;
      const receipt = new Promise<CoverReceipt>(resolve => { finish = resolve; });
      current = { id, token, controller, finish };
      const rendering = { phase:'rendering' } as const;
      jobs.set(id, rendering);
      const timeout = setTimeout(() => controller.abort(Error('封面生成超时，可稍后重试。')), ports.timeoutMs ?? 35_000);
      timeout.unref();
      try {
        const url = new URL('/model-preview', ports.origin());
        url.search = new URLSearchParams({model:id, cover:'1'}).toString();
        url.hash = new URLSearchParams({ capture:token }).toString();
        const result = await ports.render(url.href, receipt, controller.signal);
        if (jobs.get(id) !== rendering) continue;
        if (result.saved) jobs.delete(id);
        else jobs.set(id, { phase:'failed', reason:result.reason });
      } catch (error) {
        if (jobs.get(id) === rendering) jobs.set(id, { phase:'failed', reason: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(timeout);
        current = undefined;
      }
    }
  }

  function launch() {
    if (!enabled || draining) return;
    draining = Promise.resolve().then(drain).finally(() => {
      draining = undefined;
      if (enabled && [...jobs.values()].some(job => job.phase === 'queued')) launch();
    });
  }

  function enqueue(id: string, retry = false) {
    const existing = jobs.get(id);
    if (!enabled || (existing && !(retry && existing.phase === 'failed')) || !needsCover(id)) return false;
    jobs.set(id, { phase:'queued' });
    launch();
    return true;
  }

  function authorized(id: string, token: unknown) {
    return !!current && current.id === id && current.token === token && !current.controller.signal.aborted;
  }

  return {
    enqueue,
    state: (id: string) => jobs.get(id),
    start(ids: readonly string[]) {
      enabled = true;
      for (const id of ids) enqueue(id);
    },
    cancel(id: string) {
      jobs.delete(id);
      if (current?.id === id) current.controller.abort();
    },
    async stop() {
      enabled = false;
      jobs.clear();
      current?.controller.abort();
      await draining;
    },
    authorized,
    finish(id: string, token: unknown, result: CoverReceipt) {
      if (authorized(id, token)) current?.finish(result);
    },
  };
}
