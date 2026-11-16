import { describe, expect, it } from 'vitest';
import { DESKTOP_PET_DEFAULTS } from '../src/config.ts';
import { modelForCoo } from '../src/live2d/coo-resource-adapter.ts';
import { testModel } from './helpers/model.ts';
import { planSettings } from '../src/self.ts';

const cfg = () => structuredClone(DESKTOP_PET_DEFAULTS);
const packs = [modelForCoo(testModel)];

describe('live2d_pet_set', () => {
  it('changes what reaches the person only after asking them', () => {
    const { changes } = planSettings({ roam: 'free', sound: false, scale: 1.5, bubbleSize: 1.2, fontSize: 1.2, theme: 'light', user: '小明', hoverButtons: ['chat'] }, cfg(), packs);
    expect(Object.fromEntries(changes.map((c) => [c.key, c.tier]))).toEqual({ roam: 'self', sound: 'ask', scale: 'ask', bubbleSize: 'ask', fontSize: 'ask', theme: 'ask', user: 'ask', hoverButtons: 'ask' });
  });

  it('refuses settings that are not the bot\'s', () => {
    const { changes, errors } = planSettings({ asr: { enabled: false }, rememberPosition: true }, cfg(), packs);
    expect(changes).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it('rejects a figure that is outside this World', () => {
    expect(planSettings({ figure: 'whale' }, cfg(), packs).errors).toHaveLength(1);
  });

  it('changes an imported model’s outfit through its scheme', () => {
    const config = cfg();
    config.skin.figure = testModel.id;
    const { changes, errors } = planSettings({ scheme: 'alternate' }, config, packs);
    expect(errors).toEqual([]);
    expect(changes.map(change => change.patch)).toEqual([{ skin: { scheme: 'alternate' } }]);
  });
});
