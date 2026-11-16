/** Persistent user-owned body policy. These settings never grant AI self-adjustment. */
export const BODY_EFFECT_KEYS = ['squash', 'dragStretch', 'breathing'] as const;
export type BodyEffect = typeof BODY_EFFECT_KEYS[number];
export type BodyEffects = Record<BodyEffect, boolean>;
export const DEFAULT_BODY_EFFECTS: Readonly<BodyEffects> = Object.freeze({ squash: true, dragStretch: true, breathing: true });
export function bodyEffectsFor(value: unknown): BodyEffects {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(BODY_EFFECT_KEYS.map(key => [key, typeof source[key] === 'boolean' ? source[key] : true])) as BodyEffects;
}
const STATUSES = new Set(['unknown', 'reported', 'pending', 'applied', 'unsupported', 'mismatch', 'timeout', 'disposed', 'unbound']);
export function readBodyEffectsFeedback(value: unknown) {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const supported = BODY_EFFECT_KEYS.filter(key => Array.isArray(v.supported) && v.supported.includes(key));
  const raw = v.values && typeof v.values === 'object' ? v.values as Record<string, unknown> : {};
  return { status: typeof v.status === 'string' && STATUSES.has(v.status) ? v.status : 'unknown',
    supported, values: Object.fromEntries(supported.filter(key => typeof raw[key] === 'boolean').map(key => [key, raw[key]])) };
}
