import { describe, expect, it } from 'vitest';
// @ts-expect-error Shared browser code.
import { createNativeDraftLayer } from '../live2d-runtime/pack/backends/native-draft-layer.js';

describe('draft expression composition', () => {
  it('keeps unrelated channels in full preview and restores them after native-only preview', () => {
    const resources = [{ id: 'expression', kind: 'expression', seconds: 1 }];
    const value = (id: string) => ({ target: 'Parameter', id, value: 1, blend:'Overwrite', weight:1 });
    const native = { previewPlayer: () => ({ update: () => [value('CircleEyes'), value('LoadingMark')] }) };
    const layer = createNativeDraftLayer(native, resources);
    const binding = { word: 'happy', resource: 'expression' };
    const frame = {};
    layer.play(binding, 'editor', 'full');
    expect(layer.mix([value('CircleEyes'), value('Mouth')], frame, .1).values.map((v: { id: string }) => v.id))
      .toEqual(['Mouth', 'CircleEyes', 'LoadingMark']);
    expect(() => layer.play(binding, 'other-editor', 'replacement')).toThrow('different editor');
    layer.play(binding, 'editor', 'raw', 'native');
    expect(layer.mix([value('Mouth')], frame, .05)).toMatchObject({
      nativePreview:true,
      values:expect.arrayContaining([expect.objectContaining({id:'Mouth',blend:'Affine',value:expect.closeTo(2/3)})]),
    });
    expect(layer.mix([value('Mouth')], frame, .11)).toMatchObject({ nativePreview: true, values: [value('CircleEyes'), value('LoadingMark')] });
    layer.stop('editor', 'stop');
    expect(layer.mix([value('Mouth')], frame, .1).values).toContainEqual(expect.objectContaining({id:'CircleEyes',value:.6}));
    expect(layer.mix([value('Mouth')], frame, .15).values).toEqual([value('Mouth')]);
  });
});
