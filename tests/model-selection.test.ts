import { expect, it, vi } from 'vitest';
import { DESKTOP_PET_DEFAULTS } from '../src/config.ts';
import { preparedFigureSkin } from '../src/live2d/model-selection.ts';
import type { FigurePack } from '../src/packs.ts';

it('retains appearance by axis identity in the candidate first frame', () => {
  const axis = (id: string, ids: string[]) => ({ id, name: { en: id }, options: ids.map(id => ({ id, name: { en: id } })) });
  const old = 'live2d-1234567890abcdef-11111111', next = 'live2d-1234567890abcdef-22222222';
  const skin = { ...structuredClone(DESKTOP_PET_DEFAULTS.skin), figure: old, scheme: 'red-hat' };
  const packs = () => [
    { id: old, manifest: { axes: [axis('model', ['red']), axis('outfit', ['default', 'hat'])] } },
    { id: next, manifest: { axes: [axis('model', ['red']), axis('parts', ['default']), axis('outfit', ['default', 'hat'])] } },
  ] as unknown as FigurePack[];
  expect(preparedFigureSkin(skin, next, packs)).toMatchObject({ figure: next, scheme: 'red-default-hat' });
  expect(skin).toMatchObject({ figure: old, scheme: 'red-hat' });
});

it('keeps same-model picks and does not transfer them to a different source', () => {
  const skin = { ...structuredClone(DESKTOP_PET_DEFAULTS.skin), figure: 'other-pack', scheme: 'hat' };
  const packs = vi.fn(() => []);
  expect(preparedFigureSkin(skin, 'other-pack', packs).scheme).toBe('hat');
  expect(preparedFigureSkin(skin, 'new-pack', packs).scheme).toBe('');
  expect(packs).not.toHaveBeenCalled();
});
