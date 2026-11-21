import { describe, expect, it } from 'vitest';
// @ts-expect-error Shared browser code.
import { createNativeDraftLayer } from '../live2d-runtime/pack/backends/native-draft-layer.js';
// @ts-expect-error Shared browser code.
import { createNativeActions } from '../live2d-runtime/pack/backends/native-actions.js';
// @ts-expect-error Shared renderer protocol.
import { draftActionCommand } from '../web/body-draft-action-contract.js';
// @ts-expect-error Shared renderer code.
import { wardrobeConfig, wardrobeTrial } from '../live2d-runtime/pack/backends/wardrobe.js';

describe('draft expression composition', () => {
  it('auditions a single pose, holds it briefly, then releases its channels without relaxing saved bindings', () => {
    const pose = {
      id:'motion-0000000000000001',kind:'motion',classification:'pose',seconds:.2,
      data:{Curves:[{Id:'Angle',Target:'Parameter',Segments:[0,0,0,.2,1]}]},
    };
    const binding = { word:'happy',resource:pose.id };
    const native = createNativeActions({resources:[pose]});
    const layer = createNativeDraftLayer(native,[pose]);
    expect(() => native.rebind([binding])).toThrow('release motion');
    expect(() => layer.play(binding,'editor','combination')).toThrow('release motion');
    const audition = draftActionCommand({kind:'play',owner:'editor',mode:'native',binding,audition:true});
    expect(() => draftActionCommand({...audition,binding:{...binding,release:pose.id}})).toThrow('one native resource');
    layer.play(audition.binding,audition.owner,'resource',audition.mode,audition.audition);
    const normal = [{ target:'Parameter',id:'Mouth',value:1,blend:'Overwrite',weight:1 }];
    for (let i=0;i<6;i++) layer.mix(normal,{},.1);
    expect(layer.mix(normal,{},.1)).toMatchObject({
      nativePreview:true, values:[expect.objectContaining({id:'Angle',value:1})],
    });
    for (let i=0;i<17;i++) layer.mix(normal,{},.1);
    expect(layer.state()).toMatchObject({ status:'finished',requestId:'resource' });
    expect(layer.mix(normal,{},.1).values).toEqual(normal);
    expect(() => native.rebind([binding])).toThrow('release motion');
  });

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

it('validates the chosen outfit during try-on and reserves whole-library conflict checks for save', () => {
  const track = (id: string, title: string, channel: string) => ({
    kind: 'expression', id, title, raw: { Parameters: [{ Id: channel, Value: 1, Blend: 'Overwrite' }] },
  });
  const catalog = { resources: [track('hood', 'Hood', 'Head'), track('hat', 'Hat', 'Head'), track('bag', 'Bag', 'Body')] };
  const groups = [
    { id: 'headwear', slot: 'outfit', name: 'Outfit', options: [{ id: 'hood', name: 'Hood', resource: 'hood' }] },
    { id: 'extras', slot: 'accessories', name: 'Accessories', options: [
      { id: 'hat', name: 'Hat', resource: 'hat' }, { id: 'bag', name: 'Bag', resource: 'bag' },
    ] },
  ];
  const saved = wardrobeConfig(catalog, [groups[0]], [], 1);
  // The persisted scheme only has positions for the saved groups. New axes use their own IDs.
  saved.groups = saved.groups.filter((group: { options: unknown[] }) => group.options.length);
  const result = wardrobeTrial(catalog, groups, [], saved, 'full-hood', { extras: 'bag' });
  expect(result.picks).toEqual({ headwear: 'hood', extras: 'bag' });
  expect(result.config.resources.map((resource: { id: string }) => resource.id)).toEqual(['hood', 'bag']);
  expect(() => wardrobeTrial(catalog, groups, [], saved, 'full-hood', { extras: 'hat' })).toThrow('「配饰 · Hat」与「装扮 · Hood」冲突');
  expect(() => wardrobeConfig(catalog, groups)).toThrow('「配饰 · Hat」与「装扮 · Hood」冲突');
  expect(() => wardrobeTrial(catalog, groups, [], saved, 'full-hood', { extras: 'missing' })).toThrow('找不到要试穿的装扮选项');
});
