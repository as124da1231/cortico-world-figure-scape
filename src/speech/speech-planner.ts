import type { ModelNativeCatalog, ModelProfile } from '../framework/model-contract.ts';
import { PlannerServices, plannerFetch, type PlannerConfig } from './planner/planner-services.ts';
// @ts-expect-error SoulLink speaking planner as used by Figure.
import { SoullinkSpeakingMotionPlanner } from './planner/soullink-speaking-planner.js';
// @ts-expect-error Shared by this service and the renderer.
import { PERFORMANCE_FACES, PROTECTED_PARAMETER, parsePerformanceCues } from '../../live2d-runtime/pack/backends/performance-plan.js';

export interface SpeechPlannerConfig extends PlannerConfig { enabled?: boolean }
interface PlannerBeat { time: number; duration: number; parameters: Record<string, number> }

export function createSpeechPlanner(ports: {
  config: () => SpeechPlannerConfig;
  activeService?: () => ReturnType<PlannerServices['connection']> | null;
  persist: (patch: SpeechPlannerConfig) => void;
  secret: (name: string) => string | undefined;
  storeSecret: (name: string, key: string) => void;
  reportUsage: (usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number }, model: string) => void;
}) {
  const services = new PlannerServices(ports);
  let last: { status: 'planned' | 'fallback'; at: number } | null = null;
  const connection = () => {
    const selected = ports.activeService?.();
    return selected === undefined ? services.connection() : selected;
  };
  const ready = () => ports.config().enabled === true && Boolean(connection());
  const state = () => ({ ...services.state(), enabled: ports.config().enabled === true, ready: ready(), last });
  return {
    ready,
    state,
    legacyKey: (id: string) => services.legacyKey(id), async invoke(method: string, args: unknown[]) {
      switch (method) {
        case 'audio.plannerState': return state();
        case 'audio.configurePlanner':
          if (typeof args[0] !== 'boolean') throw Error('Choose whether to enable the speech planner');
          ports.persist({ enabled: args[0] });
          return state();
        case 'audio.savePlanner': services.save(args[0]); return state();
        case 'audio.selectPlanner': services.select(args[0]); return state();
        case 'audio.removePlanner': services.remove(args[0]); return state();
        case 'audio.plannerModels': return services.models(args[0]);
        case 'audio.testPlanner': return services.test(args[0]);
        default: throw Error('Unknown speech planner command');
      }
    },
    async plan(text: string, mood: string | undefined, resources: ModelNativeCatalog['resources'], profile: Pick<ModelProfile, 'wardrobe' | 'mouth'>, cancelled: AbortSignal) {
      const service = connection();
      if (ports.config().enabled !== true || !service || !text.trim()) return undefined;
      const appearance = new Set(profile.wardrobe?.flatMap(group => group.options.map(item => item.resource)) ?? []);
      const protectedIds = new Set(profile.mouth?.targets ?? []);
      for (const resource of resources) {
        if (resource.classification !== 'appearance' && !appearance.has(resource.id)) continue;
        for (const channel of resource.parameters ?? []) {
          if (channel && typeof channel === 'object' && 'id' in channel && typeof channel.id === 'string') protectedIds.add(channel.id);
        }
      }
      const parameters = new Map<string, { name: string; min: number; max: number; default: number }>();
      for (const resource of resources) {
        if (resource.classification === 'appearance' || appearance.has(resource.id)) continue;
        for (const channel of resource.parameters ?? []) {
          if (!channel || typeof channel !== 'object') continue;
          const { id, label, target } = channel as { id?: unknown; label?: unknown; target?: unknown };
          if (typeof id !== 'string' || !/^[a-zA-Z][\w.-]{0,99}$/u.test(id) || ['constructor', 'prototype'].includes(id)
            || (target && target !== 'Parameter') || protectedIds.has(id) || PROTECTED_PARAMETER.test(id + ' ' + (label ?? ''))) continue;
          if (parameters.size < 96) parameters.set(id, { name: typeof label === 'string' ? label.slice(0, 100) : id, min: -1, max: 1, default: 0 });
        }
      }
      if (!parameters.size) return undefined;
      const { model, endpoint, apiKey } = service;
      const signal = AbortSignal.any([cancelled, AbortSignal.timeout(5000)]);
      try {
        signal.throwIfAborted();
        const planner = SoullinkSpeakingMotionPlanner.create({
          openAI: { apiKey: apiKey || 'local', baseURL: endpoint, model, timeoutMs: 4500,
            fetch: async (url: string, init: RequestInit) => {
              const response = await plannerFetch(service, url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
              void response.clone().json().then(({ usage }) => {
                if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens)) return;
                const cached = Number(usage.prompt_tokens_details?.cached_tokens) || 0;
                ports.reportUsage({ promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
                  cacheHitTokens: cached, cacheMissTokens: Math.max(0, usage.prompt_tokens - cached) }, model);
              }).catch(() => {});
              return response;
            },
          },
          generation: { mode: 'fixed', maxFrameCount: 8, maxPromptParameters: 96, twoStage: true },
        });
        const durationSec = Math.min(16, Math.max(2.4, 1.6 + Array.from(text).length * .14));
        const result = await planner.plan({ speechText: text, durationSec, frameCount: Math.min(8, Math.ceil(durationSec)),
          availableParameters: Object.fromEntries(parameters),
          expression: mood && PERFORMANCE_FACES.includes(mood) ? { emotion: mood } : null });
        signal.throwIfAborted();
        const beats: PlannerBeat[] = Array.isArray(result.parameterPlan) ? result.parameterPlan : [];
        const cues = beats.slice(0, 8).flatMap(beat => {
          if (!Number.isFinite(beat.time) || !Number.isFinite(beat.duration) || beat.time < 0 || beat.time > 17.9) return [];
          const pose = Object.fromEntries(Object.entries(beat.parameters ?? {}).filter(([id, value]) => parameters.has(id) && Number.isFinite(value)).slice(0, 12));
          return Object.keys(pose).length ? [{ at: beat.time, duration: Math.max(.1, Math.min(beat.duration, 18 - beat.time)), pose }] : [];
        }).sort((a, b) => a.at - b.at);
        if (!cues.length) throw Error('The planner returned no compatible poses');
        const validated: unknown[] = parsePerformanceCues(cues);
        last = { status: 'planned', at: Date.now() };
        return validated;
      } catch {
        if (!cancelled.aborted) last = { status: 'fallback', at: Date.now() };
        return undefined;
      }
    },
  };
}
