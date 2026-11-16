import { BODY_EFFECT_DEFAULTS } from '../kit/body-effects.js';
import { bodyEffectReport, effectOutcome } from '../body-effects-contract.js';

const effectPatch = (value) => Object.fromEntries(Object.keys(BODY_EFFECT_DEFAULTS)
  .filter(key => typeof value?.[key] === 'boolean').map(key => [key, value[key]]));

/** Static assembly description, not a session or a body instance. A presentation is
 * a peer definition, not a child of desktop. Only desktop is implemented today.
 * No native window is created here: the caller injects the existing body loader.
 */
export function defineBodyAssembly({ createBody, presentations = { desktop: {} }, defaultPresentation = 'desktop' }) {
  if (typeof createBody !== 'function') throw new TypeError('System body factory is required');
  if (!Object.hasOwn(presentations, defaultPresentation)) throw new TypeError('Default presentation is not defined');
  const definitions = Object.fromEntries(Object.entries(presentations).map(([id, value]) =>
    [id, Object.freeze({ bodyEffects: Object.freeze(effectPatch(value.bodyEffects)) })]));
  return Object.freeze({ createBody, presentations: Object.freeze(definitions), defaultPresentation });
}

/** Body domain owns the single committed body, staged replacement lifecycle and effect policy.
 * Scene, native window, speech and action routing still belong to existing adapters;
 * registering a presentation does NOT implement its visual layout.
 */
export function createBodyRuntime(definition) {
  let activeBody = null, pendingSwap = null, disposed = false, cleanupError = null;
  let generation = 0, modelGeneration = 0;
  const aborted = message => new DOMException(message, 'AbortError');
  const release = body => {
    try { body?.dispose?.(); }
    catch (error) { cleanupError = String(error?.message ?? error); console.warn('[pet-system] Body cleanup failed', error); }
  };
  const cancelBodySwap = (reason = aborted('Body swap cancelled')) => {
    generation++;
    pendingSwap?.abort(reason);
    pendingSwap = null;
  };
  // This is the only replacement writer of the committed body. All candidate work happens first.
  function install(body) {
    if (disposed) throw aborted('Pet system disposed');
    if (typeof body?.set !== 'function') throw new TypeError('System body adapter must implement set');
    body.set({ bodyEffects: resolveEffects() });
    body.reveal?.();
    const previous = activeBody;
    activeBody = body;
    if (previous !== body) { modelGeneration++; release(previous); }
  }
  const userEffects = {};
  const resolveEffects = () => ({ ...BODY_EFFECT_DEFAULTS,
    ...definition.presentations[definition.defaultPresentation].bodyEffects, ...userEffects });
  return {
    get body() { return activeBody; },
    get modelGeneration() { return modelGeneration; },
    // Low-level adapter preparation remains available; production replacement uses swapBody.
    prepareBody: options => definition.createBody(options),
    commitBody(body) { cancelBodySwap(aborted('Body committed directly')); install(body); },
    cancelBodySwap,
    removeBody() {
      if (!activeBody) return;
      const previous = activeBody;
      activeBody = null;
      modelGeneration++;
      release(previous);
    },
    async swapBody(options, { validate = () => {}, configure = () => {} } = {}) {
      if (disposed) throw aborted('Pet system disposed');
      options.signal?.throwIfAborted();
      validate(); // Reject an already obsolete UI request before cancelling useful work.
      cancelBodySwap(aborted('Body swap superseded'));
      const version = generation, controller = new AbortController();
      pendingSwap = controller;
      const externalAbort = () => controller.abort(options.signal.reason);
      options.signal?.addEventListener('abort', externalAbort, { once: true });
      let candidate = null, committed = false;
      const check = () => {
        controller.signal.throwIfAborted();
        if (disposed || version !== generation) throw aborted('Body swap superseded');
      };
      try {
        // The existing loader waits for ready + first layout frame while keeping the
        // candidate hidden in the SAME window. No active body is changed during await.
        candidate = await definition.createBody({ ...options, staged: true, signal: controller.signal });
        check(); validate();
        if (candidate === activeBody) throw new TypeError('Body loader must create an isolated candidate');
        // Admission/configure hooks are synchronous; await belongs to preparation.
        configure(candidate, activeBody);
        check(); validate();
        install(candidate);
        committed = true;
        return candidate;
      } finally {
        options.signal?.removeEventListener('abort', externalAbort);
        if (pendingSwap === controller) pendingSwap = null;
        if (!committed && candidate && candidate !== activeBody) release(candidate);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelBodySwap(aborted('Pet system disposed'));
      const previous = activeBody;
      activeBody = null;
      release(previous);
    },
    setUserBodyEffects(patch) {
      if (disposed) return;
      Object.assign(userEffects, effectPatch(patch));
      activeBody?.set({ bodyEffects: resolveEffects() });
    },
    snapshot() {
      return { presentation: definition.defaultPresentation, modelGeneration, bodyEffects: resolveEffects(),
        // bodyEffects is desired policy; only the report below describes acknowledgement.
        bodyEffectsStatus: activeBody?.bodyEffectsStatus ?? (activeBody
          ? effectOutcome(resolveEffects(), bodyEffectReport(activeBody))
          : { status: 'unbound', supported: [], values: {} }),
        userBodyEffects: { ...userEffects }, hasBody: activeBody !== null,
        swappingBody: pendingSwap !== null, disposed, bodyCleanupError: cleanupError };
    },
  };
}
