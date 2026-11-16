/** Versioned, additive body-effect feedback for the existing iframe contract.
 * A report is the body's declared capability and current value, not proof of pixels.
 */
export const BODY_EFFECT_KEYS = Object.freeze(['squash', 'dragStretch', 'breathing']);
export function readEffectReport(report) {
  const supported = BODY_EFFECT_KEYS.filter(key => Array.isArray(report?.supported) && report.supported.includes(key));
  const values = {};
  for (const key of supported) if (typeof report?.values?.[key] === 'boolean') values[key] = report.values[key];
  return { supported, values };
}
export function bodyEffectReport(body) {
  return readEffectReport({ supported: body?.capabilities?.bodyEffects, values: body?.bodyEffects });
}
export function effectOutcome(requested, report) {
  const clean = readEffectReport(report);
  const keys = BODY_EFFECT_KEYS.filter(key => typeof requested?.[key] === 'boolean');
  const unsupported = keys.filter(key => !clean.supported.includes(key));
  const mismatched = keys.filter(key => clean.supported.includes(key) && clean.values[key] !== requested[key]);
  return { status: unsupported.length ? 'unsupported' : mismatched.length ? 'mismatch' : 'applied',
    ...clean, unsupported, mismatched };
}

/** The frame's state handler; shared with transport tests, not a second implementation. */
export function applyBodyState(body, state, effectSeq) {
  body.set?.(state);
  return Number.isSafeInteger(effectSeq) && effectSeq > 0
    ? { t: 'body-effects', seq: effectSeq, report: bodyEffectReport(body) } : null;
}
