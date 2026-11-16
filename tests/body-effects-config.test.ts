import { describe, expect, it } from 'vitest';
import { bodyEffectsFor, readBodyEffectsFeedback } from '../src/body-effects.ts';
import { DESKTOP_PET_DEFAULTS, desktopPetConfigGroups } from '../src/config.ts';
describe('body effect persistent configuration', () => {
  it('preserves legacy defaults and registers independent hot boolean settings', () => {
    expect(bodyEffectsFor(undefined)).toEqual(DESKTOP_PET_DEFAULTS.bodyEffects);
    expect(bodyEffectsFor({ squash: false, breathing: 'false' })).toEqual({ squash: false, dragStretch: true, breathing: true });
    const properties = desktopPetConfigGroups()[0].schema.properties!;
    for (const key of ['squash', 'dragStretch', 'breathing']) {
      expect(properties[`worlds.desktop-live2d-pet.bodyEffects.${key}`]).toMatchObject({ type: 'boolean', 'x-hot': true });
    }
  });
  it('bounds feedback keys and never copies arbitrary iframe metadata', () => {
    expect(readBodyEffectsFeedback({ status: 'invented', supported: ['squash', 'secret'], values: { squash: false, secret: 'no' } }))
      .toEqual({ status: 'unknown', supported: ['squash'], values: { squash: false } });
  });
});
