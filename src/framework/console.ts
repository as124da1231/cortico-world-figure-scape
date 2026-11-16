import type { createActionDomain } from './action-domain.ts';
import type { createAppearanceDomain } from './appearance-domain.ts';
import type { createBodyControls } from './body-controls.ts';
import type { createDraftActionDomain } from './draft-action-domain.ts';
import type { createFrameworkConfiguration } from './configuration.ts';
import type { createModelDomain } from './model-domain.ts';

type Handler = (args: unknown[]) => unknown;

/** The settings transport translates RPC arguments. Validation and state changes stay in the domains. */
export function createFrameworkConsole(ports: {
  model: Pick<ReturnType<typeof createModelDomain>,  'open' | 'import' | 'editor' | 'save' | 'applySaved' | 'operation' | 'cancel'>;
  selectModel: (figure: unknown, operationId?: unknown) => Promise<{ applied: boolean }>;
  appearance: ReturnType<typeof createAppearanceDomain>;
  actions: ReturnType<typeof createActionDomain>;
  body: ReturnType<typeof createBodyControls>;
  draftAction: ReturnType<typeof createDraftActionDomain>;
  configuration: ReturnType<typeof createFrameworkConfiguration>;
  state: () => unknown;
  runtimeState: () => Record<string, unknown>;
  resources: () => unknown;
  modelImported?: (modelId: string) => void;
  unknownMethod: (method: string) => string;
}) {
  const { model, appearance, actions, body, configuration } = ports;
  const handlers: Record<string, Handler> = {
    state: ports.state,
    resources: ports.resources,
    'operation.get': ([id]) => model.operation(id) ?? null,
    'operation.cancel': ([id]) => model.operation(id) ? model.cancel(id) : null,
    async openModel([file, id]) {
      const operation = await model.open(file, id);
      return { ...ports.runtimeState(), modelApplied: operation.applied, modelOperation: operation };
    },
    async selectResource([figure, id]) {
      const operation = await ports.selectModel(figure, id);
      return { ...ports.runtimeState(), modelApplied: operation.applied };
    },
    async importModel([file, id]) {
      const operation = await model.import(file, id);
      if (operation.candidate) ports.modelImported?.(operation.candidate);
      return { imported: operation.candidate, modelOperation: operation };
    },
    modelEditor: ([target]) => model.editor(target),
    saveModel: ([figure, profile, revision, catalog, id]) => model.save(
      String(figure ?? ''), profile, String(revision ?? ''), typeof catalog === 'string' ? catalog : undefined, id,
    ),
    saveLibraryModel: ([figure, profile, revision, catalog, id]) => model.save(
      String(figure ?? ''), profile, String(revision ?? ''), typeof catalog === 'string' ? catalog : undefined, id, true,
    ),
    applySavedModel: ([figure, revision, id]) => model.applySaved(String(figure ?? ''), String(revision ?? ''), id),
    input: body.readInput,
    framing: ([figure]) => body.readFraming(figure),
    previewFraming: ([figure, command, owner]) => body.previewFraming(figure, command, owner),
    previewHeldInput: ([figure, snapshot]) => body.previewHeldInput(figure, snapshot),
    previewMouth: ([figure, kind]) => body.previewMouth(figure, kind),
    actions: actions.read,
    previewDraftAction: ([figure, command]) => ports.draftAction.run(figure, command),
    previewActions: ([figure, words]) => actions.preview(figure, words),
    previewAction: ([figure, word]) => ({ ...actions.preview(figure, [word]), word }),
    appearance: appearance.read,
    'appearance.presets': appearance.presets,
    'appearance.savePresets': ([looks]) => appearance.savePresets(looks),
    'appearance.applyPreset': ([id]) => appearance.applyPreset(id),
    setAppearance: ([figure, picks]) => appearance.select(figure, picks),
    setBodyEffects([patch]) {
      configuration.patchBodyEffects(patch);
      return ports.state();
    },
  };

  return {
    invoke(method: string, args: unknown[]) {
      if (!Object.hasOwn(handlers, method)) throw Error(ports.unknownMethod(method));
      return handlers[method](args);
    },
  };
}
