import { join } from 'node:path';
import { createImportUpload } from '../live2d/import-upload.ts';
import type { ModelResources } from './model-contract.ts';
import type { createModelIntake } from '../live2d/model-intake.ts';
import type { createAdaptationService } from '../live2d/adaptation.ts';
import type { createSdkService } from '../live2d/sdk-service.ts';

export function createResourceConsole(ports: {
  adaptation?: ReturnType<typeof createAdaptationService>;
  sdk?: ReturnType<typeof createSdkService>;
  intake?: ReturnType<typeof createModelIntake>;
  models?: ModelResources;
  protectedModels: () => readonly string[];
  modelBusy: () => boolean;
  open: (file: string, operationId: unknown) => unknown;
  importModel?: (file: string, operationId: unknown) => unknown;
  unknownMethod: (method: string) => string;
}) {
  const upload = ports.intake && createImportUpload(ports.intake);
  return async function invoke(method: string, args: unknown[]) {
    const { intake } = ports;
    const requireIntake = () => { if (!intake) throw Error('Model intake is unavailable'); return intake; };
    if (/^resources\.(?:begin|append|finish|cancel)Upload$/.test(method)) {
      if (!upload) throw Error('Model intake is unavailable');
      return upload(method, args);
    }
    switch (method) {
      case 'resources.cacheState': return ports.models?.cacheState?.(ports.protectedModels()) ?? null;
      case 'resources.removeModel':
        if (typeof args[0] !== 'string' || !ports.models?.removeModel) throw Error('Invalid model ID');
        if (ports.modelBusy()) throw Error('The body is busy; try again after the current operation');
        return ports.models.removeModel(args[0], ports.protectedModels());
      case 'resources.pruneCache':
        if (!ports.models?.pruneCache || ports.modelBusy()) throw Error('The model cache is unavailable or busy');
        return ports.models.pruneCache(ports.protectedModels());
      case 'resources.adaptationState': return { options: ports.adaptation?.options(), plans: ports.adaptation?.list() ?? [] };
      case 'resources.configureAdaptation': return ports.adaptation?.configure(args[0]);
      case 'resources.inspectActions': {
        if (args[2] !== undefined && (!args[2] || typeof args[2] !== 'object' || Array.isArray(args[2]))) throw Error('Invalid action inspection request');
        return ports.adaptation?.actions(args[0], args[1], args[2] as Record<string, unknown> | undefined);
      }
      case 'resources.proposeAdaptation': return ports.adaptation?.propose(args[0], args[1]);
      case 'resources.approveAdaptation': return ports.adaptation?.approve(args[0]);
      case 'resources.rejectAdaptation': return ports.adaptation?.reject(args[0]);
      case 'resources.applyAdaptation': return ports.adaptation?.apply(args[0]);
      case 'resources.runtimeState': return ports.sdk?.state() ?? null;
      case 'resources.runtimeLicense': return ports.sdk?.license(args[0]);
      case 'resources.ensureRuntime': return ports.sdk?.ensure(args[0]);
      case 'resources.importPaths': return requireIntake().importPaths(args[0]);
      case 'resources.imported': return requireIntake().list();
      case 'resources.cancelImport': return { cancelled: requireIntake().cancel() };
      case 'resources.importCandidate': {
        const item = requireIntake().candidate(args[0]);
        if (!ports.importModel) throw Error('Model import is unavailable');
        return ports.importModel(join(item.dir, item.file), args[1]);
      }
      case 'resources.openImported': {
        const item = requireIntake().candidate(args[0]);
        return ports.open(join(item.dir, item.file), args[1]);
      }
      default: throw Error(ports.unknownMethod(method));
    }
  };
}
