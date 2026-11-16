import { describe, expect, it, vi } from 'vitest';
import { createFrameworkConfiguration } from '../src/framework/configuration.ts';

describe('framework configuration', () => {
  it('uses the single live store and persists a merged validated patch before applying', () => {
    let cfg = { squash: false, dragStretch: true, breathing: false };
    const calls: string[] = [];
    const service = createFrameworkConfiguration({ read: () => cfg,
      persist: patch => { calls.push('persist'); cfg = patch.bodyEffects; },
      apply: () => { calls.push('apply'); }, observed: () => null });
    const state = service.patchBodyEffects({ dragStretch: false });
    expect(state.configuration.bodyEffects.desired).toEqual({ squash: false, dragStretch: false, breathing: false });
    expect(calls).toEqual(['persist', 'apply']);
    cfg.breathing = true;
    expect(service.desired().breathing).toBe(true);
    expect(state.capabilities.every(c => c.supported === null && c.active === null)).toBe(true);
    expect(Object.keys(state.definition.presentations)).toEqual(['desktop', 'room', 'phone', 'wallpaper']);
  });
  it('rejects unknown keys and non-boolean values without partial writes', () => {
    const persist = vi.fn(); const apply = vi.fn();
    const service = createFrameworkConfiguration({ read: () => ({}), persist, apply, observed: () => null });
    for (const patch of [{ squash: false, unknown: true }, { squash: 'false' }, [], null]) {
      expect(() => service.patchBodyEffects(patch)).toThrow();
    }
    expect(persist).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });
});
