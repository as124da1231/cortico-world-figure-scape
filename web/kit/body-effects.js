/** Body-local effect definition. No World, session, DOM, scene or audio ownership here.
 * Defaults preserve Desktop Pet rendering. The eventual system assembler supplies resolved
 * policy; configure is not an AI permission boundary and does not persist user settings.
 */
export const BODY_EFFECT_DEFAULTS = Object.freeze({ squash: true, dragStretch: true, breathing: true });

export function createBodyEffects(initial = {}) {
  const enabled = { ...BODY_EFFECT_DEFAULTS };
  function configure(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
    for (const key of Object.keys(BODY_EFFECT_DEFAULTS)) {
      if (typeof patch[key] === 'boolean') enabled[key] = patch[key];
    }
  }
  configure(initial);
  return {
    configure,
    snapshot: () => ({ ...enabled }),
    // Drop suppressed impulses, including those from landing/touch/cue. Re-enabling
    // cannot resurrect stored spring energy. Do not reset locomotion or model physics.
    resetDisabled(state) {
      if (!enabled.squash) { state.sq = 0; state.sqv = 0; }
      if (!enabled.dragStretch) state.stretch = 0;
    },
    compose(squash, stretch, breath) {
      const sq = enabled.squash ? squash : 0;
      const st = enabled.dragStretch ? stretch : 0;
      const br = enabled.breathing ? breath : 0;
      return {
        sx: (1 + sq * .7) * (1 - .05 * st) * (1 - .009 * br),
        sy: (1 - sq) * (1 + .09 * st) * (1 + .016 * br),
        shadowScale: 1 + sq * .5,
      };
    },
  };
}
