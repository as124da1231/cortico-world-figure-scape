import { randomUUID } from 'node:crypto';
import type { BodyTransaction } from './body-transaction.ts';

export type PresentationMode = 'desktop' | 'room' | 'phone' | 'wallpaper';
export type ScenePosition = { x: number; y?: number; facing?: 1 | -1 };
export const PRESENTATIONS = ['desktop', 'room', 'phone', 'wallpaper'] as const;
export function presentationMode(value: unknown): value is PresentationMode {
  return PRESENTATIONS.some(mode => mode === value);
}
export function scenePosition(value: Record<string, unknown>): ScenePosition | null {
  const bounded = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (!bounded(value.x) || value.y !== undefined && !bounded(value.y)) return null;
  return { x: value.x, ...(bounded(value.y) ? { y: value.y } : {}),
    ...(value.facing === 1 || value.facing === -1 ? { facing: value.facing } : {}) };
}

type Operation = { operationId: string; bodyId: 'desktop-live2d-pet'; mode: PresentationMode; phase: 'applying' | 'committing' | 'completed' | 'failed' | 'cancelled'; applied: boolean; error?: string };
type SceneReceipt = { id: string; status: string; reason?: string };
type Selection = { payload?: unknown; save?: () => Promise<() => Promise<void>>; replace?: boolean; whileHidden?: boolean };
type Frame = { mode: PresentationMode; details: unknown; generation: number | null };

export function createPresentationService(ports: {
  desired: () => PresentationMode; persist: (mode: PresentationMode) => void;
  connected: () => boolean; visible?: () => boolean; model: () => string; modelBusy: () => boolean;
  transaction?: BodyTransaction;
  send: (message: { t: string; [key: string]: unknown }) => boolean;
  scene: () => unknown;
}) {
  const history = new Map<string, { operation: Operation; result: Promise<Operation> }>();
  let pending: { operation: Operation; ready: () => void; applied: (frame: Frame) => void;
    fail: (reason: string, cancelled?: boolean) => void; request: string; model: string; previousMode: PresentationMode } | undefined;
  let observed: Frame | null = null;
  let error: string | null = null, sceneResult: SceneReceipt | null = null;
  let sceneOrder: { id: string; mode: PresentationMode } | null = null;
  const state = () => ({ desired: pending?.previousMode ?? ports.desired(), applied: observed?.mode ?? null, connected: ports.connected(), visible: ports.visible?.() ?? ports.connected(),
    available: [...PRESENTATIONS], details: observed?.details ?? null, generation: observed?.generation ?? null,
    operation: pending ? { ...pending.operation } : null, error });
  function select(mode: unknown, requested?: unknown, options?: Selection): Promise<Operation> {
    if (!presentationMode(mode)) throw Error('Invalid presentation mode');
    if (requested !== undefined && (typeof requested !== 'string' || !/^[\w-]{1,80}$/.test(requested))) throw Error('Invalid operation ID');
    const targetMode = mode;
    const id = typeof requested === 'string' ? requested : randomUUID();
    const old = history.get(id);
    if (old) {
      if (old.operation.mode !== mode) throw Error('Operation ID belongs to a different presentation');
      return old.result;
    }
    if (pending || ports.modelBusy()) throw Error('The body is busy; try again when the current operation finishes');
    const release = ports.transaction?.reserve('presentation');
    const operation: Operation = { operationId: id, bodyId: 'desktop-live2d-pet', mode, phase: 'applying', applied: false };
    const result = new Promise<Operation>(resolve => {
      const request = randomUUID(), model = ports.model();
      const previousMode = ports.desired();
      let undoSelection: (() => Promise<void>) | undefined;
      let savedMode = false, saving = false, confirmed = false, settled = false;
      let failure: { reason: string; cancelled: boolean } | undefined;
      const send = (t: string) => ports.send({ t, request });
      // A wallpaper can try live, video, and poster before the body draws its first frame.
      let timer = setTimeout(() => fail('presentation-timeout'), mode === 'wallpaper' ? 30000 : 6000);
      function finish(phase: Operation['phase'], reason?: string, applied = false) {
        settled = true;
        clearTimeout(timer);
        release?.();
        if (pending?.request === request) pending = undefined;
        operation.phase = phase;
        operation.applied = phase === 'completed' && applied;
        if (reason) operation.error = reason;
        error = reason ?? null;
        resolve({ ...operation });
      }
      async function restore() {
        if (!failure || settled) return;
        const { reason, cancelled } = failure;
        const errors: string[] = [];
        if (savedMode) {
          try { ports.persist(previousMode); }
          catch (error) { errors.push(String(error)); }
        }
        if (undoSelection) {
          try { await undoSelection(); }
          catch (error) { errors.push(String(error)); }
        }
        finish(cancelled ? 'cancelled' : 'failed', errors.length ? reason + ' (rollback: ' + errors.join(', ') + ')' : reason);
      }
      function fail(reason: string, cancelled = false) {
        if (failure || settled) return;
        failure = { reason, cancelled };
        clearTimeout(timer);
        try { send('presentation-cancel'); } catch { /* The renderer also abandons unconfirmed candidates. */ }
        if (!saving) void restore();
      }
      async function commitSelection(needsFrame: boolean, alreadyApplied = false) {
        operation.phase = 'committing';
        clearTimeout(timer);
        saving = true;
        try {
          if (options?.save) undoSelection = await options.save();
          if (failure) return;
          if (targetMode !== previousMode) {
            ports.persist(targetMode);
            savedMode = true;
          }
          if (!needsFrame) { finish('completed', undefined, alreadyApplied); return; }
          confirmed = true;
          timer = setTimeout(() => fail('presentation-timeout'), 4000);
          if (!send('presentation-confirm')) fail('window-disconnected');
        } catch (e) {
          fail(String(e instanceof Error ? e.message : e));
        } finally {
          saving = false;
          if (failure) await restore();
        }
      }
      pending = { operation, request, model, previousMode, fail, ready: () => void commitSelection(true), applied(frame) {
        if (!confirmed || failure || settled) return;
        observed = frame;
        finish('completed', undefined, true);
      } };
      if (!ports.connected() || ports.visible?.() === false && !options?.whileHidden) { void commitSelection(false); return; }
      if (observed?.mode === mode && !options?.replace) { void commitSelection(false, true); return; }
      try {
        if (!ports.send({ t: 'presentation-apply', request, mode, wallpaper: options?.payload,
          replace: options?.replace, whileHidden: options?.whileHidden })) fail('window-disconnected');
      } catch (e) { fail(String(e instanceof Error ? e.message : e)); }
    });
    history.set(id, { operation, result });
    if (history.size > 64) history.delete(history.keys().next().value!);
    return result;
  }
  return {
    state, select,
    busy: () => !!pending,
    mode: () => observed?.mode ?? 'desktop',
    operation(id: unknown) {
      const operation = typeof id === 'string' ? history.get(id)?.operation : undefined;
      return operation ? { ...operation } : null;
    },
    cancel(id: unknown) {
      if (pending && pending.operation.operationId === id && pending.operation.phase === 'applying') {
        pending.fail('cancelled', true);
      }
      return this.operation(id);
    },
    ready(message: Record<string, unknown>) {
      const active = pending;
      if (!active || message.request !== active.request || message.figure !== active.model
        || message.mode !== active.operation.mode || active.operation.phase !== 'applying') return;
      active.ready();
    },
    receive(message: Record<string, unknown>) {
      const active = pending;
      if (message.request === null && active || message.request !== null && (!active || message.request !== active.request)) return;
      if (message.figure !== (active?.model ?? ports.model())) return;
      if (!active && message.ok === true && message.mode !== ports.desired()) return;
      if (message.ok !== true || !presentationMode(message.mode) || active && message.mode !== active.operation.mode) {
        const reason = typeof message.reason === 'string' ? message.reason : 'presentation-rejected';
        if (active) active.fail(reason); else error = reason;
        return;
      }
      const frame = { mode: message.mode, details: message.presentation, generation: typeof message.generation === 'number' ? message.generation : null };
      if (active) { active.applied(frame); return; }
      observed = frame;
      error = null;
    },
    updateDetails(mode: unknown, details: unknown, generation: unknown) {
      if (observed && mode === observed.mode && details && typeof details === 'object') {
        observed = { mode: observed.mode, details, generation: typeof generation === 'number' ? generation : observed.generation };
      }
    },
    disconnected() {
      pending?.fail('window-disconnected');
      if (sceneOrder) sceneResult = { id: sceneOrder.id, status: 'cancelled', reason: 'window-disconnected' };
      sceneOrder = null;
      observed = null;
    },
    sceneState() { return { mode: this.mode(), available: ports.connected() && ports.visible?.() !== false && !!observed, scene: ports.scene(), active: sceneOrder, recent: sceneResult }; },
    sceneStart(value: unknown, interact: boolean, run: unknown) {
      if (pending || ports.modelBusy() || !ports.connected() || ports.visible?.() === false || !observed) throw Error('Scene is unavailable');
      const target = typeof value === 'string' ? value : value && typeof value === 'object' && scenePosition(value as Record<string, unknown>);
      if (!target || interact && typeof target !== 'string' || typeof target === 'string' && !/^[a-z][a-z0-9-]{0,30}$/.test(target)) throw Error('Invalid scene target');
      const id = randomUUID(), mode = this.mode();
      if (sceneOrder) ports.send({ t: 'scene-cancel', id: sceneOrder.id });
      if (!ports.send({ t: 'scene-order', id, mode, target, normalized: true, interact, run: run === true })) throw Error('Scene is unavailable');
      sceneOrder = { id, mode };
      return { id, status: 'accepted' };
    },
    sceneCancel(id: unknown) {
      if (!sceneOrder || sceneOrder.id !== id) return { cancelled: false };
      return { cancelled: ports.send({ t: 'scene-cancel', id }) };
    },
    sceneReceive(message: Record<string, unknown>) {
      if (!sceneOrder || sceneOrder.id !== message.id || !['completed', 'failed', 'cancelled'].includes(String(message.status))) return;
      sceneResult = { id: sceneOrder.id, status: String(message.status), ...(typeof message.reason === 'string' ? { reason: message.reason } : {}) };
      sceneOrder = null;
    },
  };
}
