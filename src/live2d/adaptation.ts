import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_MODEL_ADAPTATION, type ModelAdaptationSettings } from '../config.ts';
import type { ModelResources, NativeBinding } from '../framework/model-contract.ts';
// @ts-expect-error Shared Figure analysis policy is implemented in JavaScript.
import { catalogPage, confirmationReasons } from './adaptation-analysis.mjs';
import type { createModelIntake } from './model-intake.ts';
// @ts-expect-error Same Figure rules as editor validation and playback.
import { inspectNative, validateBindings, FACE_WORDS, MOTION_WORDS } from '../../live2d-runtime/tools/native-catalog.mjs';

interface ActionRequest { resources?: unknown; parameter_offset?: unknown }

type Intake = ReturnType<typeof createModelIntake>;
type Candidate = ReturnType<Intake['candidate']>;
interface Plan {
  id: string;
  target: Candidate;
  sourceId: string;
  fingerprint: string;
  revision: string;
  bindings: NativeBinding[];
  skipped: string[];
  status: 'pending' | 'approved' | 'executing' | 'saved' | 'rejected';
  createdAt: number;
  requiresConfirmation: boolean;
  reviewWarnings: string[];
}

export function createAdaptationService(ports: {
  intake: Intake;
  resources: ModelResources;
  settings: () => ModelAdaptationSettings | undefined;
  persist: (settings: ModelAdaptationSettings) => void;
}) {
  const plans = new Map<string, Plan>();
  const options = () => {
    const { mode, automatic, confirmFallback } = { ...DEFAULT_MODEL_ADAPTATION, ...ports.settings() };
    return { mode, automatic, confirmFallback };
  };
  const needsConfirmation = (plan: Plan, settings = options()) => plan.requiresConfirmation || !settings.automatic
    || settings.mode !== 'ai' || (settings.confirmFallback && (!plan.bindings.length || plan.skipped.length > 0));

  function get(id: unknown) {
    const plan = typeof id === 'string' ? plans.get(id) : undefined;
    if (!plan || plan.status === 'rejected' || (plan.status !== 'saved' && Date.now() - plan.createdAt > 30 * 60_000)) {
      throw Error('The adaptation proposal expired. Inspect the source again');
    }
    return plan;
  }

  async function inspect(target: Candidate, signal?: AbortSignal) {
    const catalog = await inspectNative(target, { signal });
    if (catalog.missingRequiredAssets.length) throw Error('Missing model files: ' + catalog.missingRequiredAssets.slice(0, 4).join(', '));
    return catalog;
  }

  return {
    options,
    configure(raw: unknown) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid adaptation settings');
      const current = options();
      const value = raw as Partial<ModelAdaptationSettings>;
      const next = {
        mode: value.mode ?? current.mode,
        automatic: value.automatic ?? current.automatic, confirmFallback: value.confirmFallback ?? current.confirmFallback,
      };
      if (!['none', 'manual', 'ai'].includes(next.mode)
        || typeof next.automatic !== 'boolean'
        || typeof next.confirmFallback !== 'boolean') throw Error('Invalid adaptation settings');
      ports.persist(next);
      return next;
    },
    list: () => [...plans.values()].map(plan => structuredClone({ ...plan, requiresConfirmation: needsConfirmation(plan) })),
    async actions(id: unknown, offset: unknown, request: ActionRequest = {}, signal?: AbortSignal) {
      const target = ports.intake.candidate(id);
      const catalog = await inspect(target, signal);
      const start = offset ?? 0;
      if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) throw Error('Invalid resource page offset');
      return { model: target.id, fingerprint: catalog.fingerprint, expressions: FACE_WORDS, motions: MOTION_WORDS,
        ...catalogPage(catalog, start, request) };
    },
    async propose(id: unknown, raw: unknown, signal?: AbortSignal) {
      const target = ports.intake.candidate(id);
      const [catalog, source] = await Promise.all([
        inspect(target, signal), ports.resources.source?.(join(target.dir, target.file)),
      ]);
      if (!source || source.catalogFingerprint !== catalog.fingerprint) throw Error('The model changed during inspection');
      const settings = options();
      const selected: NativeBinding[] = settings.mode === 'none' ? [] : validateBindings(catalog, raw ?? []);
      const skipped: string[] = [];
      const automatic = settings.mode === 'ai' && settings.automatic;
      const bindings = automatic ? selected.filter(binding => {
        const resource = catalog.resources.find((item: { id: string }) => item.id === binding.resource);
        const safe = (binding.confidence ?? 0) >= .7 && resource?.classification !== 'appearance';
        if (!safe) skipped.push(binding.word);
        return safe;
      }) : selected;
      const reviewWarnings: string[] = confirmationReasons(catalog, bindings);
      if (settings.confirmFallback && (!bindings.length || skipped.length)) reviewWarnings.push('有动作将沿用通用表现');
      const plan: Plan = {
        id: randomUUID(), target, sourceId: source.sourceId, fingerprint: catalog.fingerprint, revision: source.revision, bindings, skipped, reviewWarnings,
        status: 'pending', createdAt: Date.now(), requiresConfirmation: !automatic || reviewWarnings.length > 0,
      };
      signal?.throwIfAborted();
      plans.set(plan.id, plan);
      for (const [key, old] of plans) if (plans.size > 40 && old.status !== 'executing') plans.delete(key);
      return structuredClone(plan);
    },
    read(id: unknown) {
      const plan = get(id);
      return structuredClone({ ...plan, requiresConfirmation: needsConfirmation(plan) });
    },
    approve(id: unknown) {
      const plan = get(id);
      if (plan.status === 'pending') plan.status = 'approved';
      return structuredClone(plan);
    },
    reject(id: unknown) {
      const plan = get(id);
      if (plan.status === 'pending' || plan.status === 'approved') plan.status = 'rejected';
      return structuredClone(plan);
    },
    async apply(id: unknown, signal?: AbortSignal) {
      const plan = get(id);
      if (plan.status === 'saved') return structuredClone(plan);
      if (plan.status === 'executing') throw Error('The proposal is already running');
      const approved = plan.status === 'approved';
      if (!approved && needsConfirmation(plan)) throw Error('User approval is required for this proposal');
      const previous = plan.status;
      plan.status = 'executing';
      try {
        const file = join(plan.target.dir, plan.target.file);
        const save = ports.resources.saveSourceProfile;
        if (!save) throw Error('Model profile storage is unavailable');
        await save(file, plan.bindings, plan.revision, plan.fingerprint, signal);
        plan.status = 'saved';
        return structuredClone(plan);
      } catch (error) {
        plan.status = previous;
        throw error;
      }
    },
  };
}
