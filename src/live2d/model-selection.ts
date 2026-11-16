import type { PetSkin } from '../config.ts';
import { lookOf, type FigurePack } from '../packs.ts';
import { migrateAppearanceScheme } from '../framework/appearance-domain.ts';

/** Compatibility with the current Figure-backed provider, not a raw-model identity contract.
 * Plan the same appearance before loading and persisting, so the first frame does not reset it.
 */
export function preparedFigureSkin(skin: PetSkin, figure: string, packs: () => FigurePack[]): PetSkin {
  const previous = skin.figure;
  let scheme = previous === figure ? skin.scheme : '';
  if (previous && /^live2d-[a-f0-9]{16}-/.test(previous) && previous.slice(0, 23) === figure.slice(0, 23)) {
    const available = packs(), before = available.find(p => p.id === previous), after = available.find(p => p.id === figure);
    if (before && after) scheme = migrateAppearanceScheme(before.manifest.axes, lookOf(skin), after.manifest.axes);
  }
  return { ...skin, figure, scheme };
}
