import { DESKTOP_PET_DEFINITION } from '../../web/framework/definition.js';
import { BODY_EFFECT_KEYS, bodyEffectsFor, type BodyEffects, type readBodyEffectsFeedback } from '../body-effects.ts';

/** Owns configuration meaning, not storage. Always reads the host's live cfg. */
export function createFrameworkConfiguration(adapter: {
  read: () => unknown;
  persist: (patch: { bodyEffects: BodyEffects }) => void;
  apply: () => void;
  observed: () => ReturnType<typeof readBodyEffectsFeedback> | null;
}) {
  const fields = BODY_EFFECT_KEYS.map(key => Object.freeze({
    key, path: `bodyEffects.${key}`, type: 'boolean' as const, owner: 'body',
    scope: 'user' as const, default: true, writableBy: 'user' as const,
  }));
  return {
    desired: () => bodyEffectsFor(adapter.read()),
    read() {
      const desired = bodyEffectsFor(adapter.read());
      const observed = adapter.observed();
      return {
        definition: DESKTOP_PET_DEFINITION,
        configuration: { schemaVersion: 1, bodyEffects: { fields, desired, observed } },
        capabilities: BODY_EFFECT_KEYS.map(key => ({ id: `body.effects.${key}`,
          declared: true, allowed: desired[key],
          supported: observed ? observed.supported.includes(key) : null,
          active: observed?.status === 'applied' && observed.supported.includes(key) ? observed.values[key] === true : null,
        })),
      };
    },
    patchBodyEffects(raw: unknown) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('bodyEffects must be an object');
      const patch = raw as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (!(BODY_EFFECT_KEYS as readonly string[]).includes(key) || typeof value !== 'boolean') throw new TypeError(`Invalid body effect: ${key}`);
      }
      if (Object.keys(patch).length) {
        adapter.persist({ bodyEffects: { ...bodyEffectsFor(adapter.read()), ...patch } });
        adapter.apply();
      }
      return this.read();
    },
  };
}
