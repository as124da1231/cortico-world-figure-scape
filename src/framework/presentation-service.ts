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

export function createPresentationService(ports: {
  desired: () => PresentationMode; persist: (mode: PresentationMode) => void;
  connected: () => boolean; visible?: () => boolean; model: () => string; modelBusy: () => boolean;
  transaction?: BodyTransaction;
  send: (message: { t: string; [key: string]: unknown }) => boolean;
  scene: () => unknown;
}) {
  const history = new Map<string, { operation: Operation; result: Promise<Operation> }>();
  let pending: { operation: Operation; finish: (phase: Operation['phase'], reason?: string) => void; request: string; model: string } | undefined;
  let observed: { mode: PresentationMode; details: unknown; generation: number | null } | null = null;
  let error: string | null = null, sceneResult: SceneReceipt | null = null;
  let sceneOrder: { id: string; mode: PresentationMode } | null = null;
  const state = () => ({ desired: ports.desired(), applied: observed?.mode ?? null, connected: ports.connected(), visible: ports.visible?.() ?? ports.connected(),
    available: [...PRESENTATIONS], details: observed?.details ?? null, generation: observed?.generation ?? null,
    operation: pending ? { ...pending.operation } : null, error });
  function select(mode: unknown, requested?: unknown, wallpaper?: { payload: unknown; commit?: () => Promise<void>; replace?: boolean }): Promise<Operation> {
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
      const timer = setTimeout(() => {
        ports.send({ t: 'presentation-cancel', request });
        finish('failed', 'presentation-timeout');
      }, mode === 'wallpaper' ? 24000 : 6000);
      function finish(phase: Operation['phase'], reason?: string, applied = false) {
        clearTimeout(timer);
        release?.();
        if (pending?.request === request) pending = undefined;
        operation.phase = phase;
        operation.applied = phase === 'completed' && applied;
        if (reason) operation.error = reason;
        error = reason ?? null;
        resolve({ ...operation });
      }
      async function commitSelection(applied: boolean) {
        clearTimeout(timer);
        try {
          if (wallpaper?.commit) await wallpaper.commit();
          ports.persist(targetMode);
          finish('completed', undefined, applied);
        }
        catch (e) { finish('failed', String(e instanceof Error ? e.message : e)); }
      }
      if (!ports.connected() || ports.visible?.() === false) { void commitSelection(false); return; }
      if (observed?.mode === mode && !wallpaper?.replace) { void commitSelection(true); return; }
      pending = { operation, request, model, finish(phase, reason) {
        if (phase === 'completed') void commitSelection(true); else finish(phase, reason);
      } };
      try { if (!ports.send({ t: 'presentation-apply', request, mode, ...(wallpaper ? { wallpaper:wallpaper.payload, replace:wallpaper.replace } : {}) })) finish('failed', 'window-disconnected'); }
      catch (e) { finish('failed', String(e instanceof Error ? e.message : e)); }
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
        const current = pending;
        ports.send({ t: 'presentation-cancel', request: current.request });
        current.finish('cancelled', 'cancelled');
      }
      return this.operation(id);
    },
    ready(message: Record<string, unknown>) {
      const active = pending;
      if (!active || message.request !== active.request || message.figure !== active.model
        || message.mode !== active.operation.mode || active.operation.phase !== 'applying') return;
      active.operation.phase = 'committing';
      if (!ports.send({ t: 'presentation-confirm', request: active.request })) active.finish('failed', 'window-disconnected');
    },
    receive(message: Record<string, unknown>) {
      const active = pending;
      if (message.request === null && active || message.request !== null && (!active || message.request !== active.request)) return;
      if (message.figure !== (active?.model ?? ports.model())) return;
      if (!active && message.ok === true && message.mode !== ports.desired()) return;
      if (message.ok !== true || !presentationMode(message.mode) || active && message.mode !== active.operation.mode) {
        const reason = typeof message.reason === 'string' ? message.reason : 'presentation-rejected';
        if (active) active.finish('failed', reason); else error = reason;
        return;
      }
      if (active && active.operation.phase !== 'committing') return;
      observed = { mode: message.mode, details: message.presentation, generation: typeof message.generation === 'number' ? message.generation : null };
      error = null;
      active?.finish('completed');
    },
    updateDetails(mode: unknown, details: unknown, generation: unknown) {
      if (observed && mode === observed.mode && details && typeof details === 'object') {
        observed = { mode: observed.mode, details, generation: typeof generation === 'number' ? generation : observed.generation };
      }
    },
    disconnected() {
      pending?.finish('failed', 'window-disconnected');
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
