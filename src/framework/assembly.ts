import { DESKTOP_PET_DEFINITION, type PetDefinition } from '../../web/framework/definition.js';
import { createDirectModelService } from '../live2d/direct-model-service.ts';
import type { createSdkService } from '../live2d/sdk-service.ts';
import type { ModelResources } from './model-contract.ts';
type ResourcePorts = { dataDir: string; sdk: ReturnType<typeof createSdkService> };

/** Node resources are injected separately from renderer factories: no filesystem APIs enter the window. */
export function createModelResources(ports: ResourcePorts, definition: PetDefinition = DESKTOP_PET_DEFINITION): ModelResources {
  const implementations: Record<string, (ports: ResourcePorts) => ModelResources> = {
    'direct-live2d': ({ dataDir, sdk }) => createDirectModelService({
      dataDir, sdkProvider: sdk.prepare, sdkCache: sdk.verifiedCache,
    }),
  };
  const factory = implementations[definition.resources.model.implementation];
  if (!factory) throw Error(`Unbound model resources: ${definition.resources.model.implementation}`);
  return factory(ports);
}
