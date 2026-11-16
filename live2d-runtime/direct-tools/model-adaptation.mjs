import { describeImportedAdaptation, inferPrivateEmotionMap } from './support/model-adaptation.js';
import { wardrobeChannels } from '../pack/backends/wardrobe.js';

export function inspectModelAdaptation({metadata,physics,roles,diagnostics,cleanParams={},resources=[]}) {
  const mappedIds = new Set(Object.values(roles).flatMap(role => role.targets));
  const protectedIds = new Set(Object.keys(cleanParams));
  const settings = Array.isArray(physics?.PhysicsSettings) ? physics.PhysicsSettings : [];
  for (const setting of settings) {
    const outputs = Array.isArray(setting?.Output) ? setting.Output : [];
    for (const output of outputs) {
      if (output?.Destination?.Target === 'Parameter') protectedIds.add(output.Destination.Id);
    }
  }
  for (const resource of resources) {
    if (resource?.classification !== 'appearance') continue;
    for (const channel of wardrobeChannels(resource)) {
      if (channel.startsWith('Parameter:')) protectedIds.add(channel.slice(10));
    }
  }
  const privateEmotionMap = inferPrivateEmotionMap(metadata,{mappedIds,protectedIds});
  const report = describeImportedAdaptation({metadata,roles,diagnostics,privateEmotionMap});
  return {privateEmotionMap,report};
}
