import type { WebUiClientBundle } from 'cortico/web/shared/client-panel.ts';
import { WORKSPACE_PANELS } from '../framework/workspace.ts';
import { mountConsolePage } from './coopanion/base/page.ts';
import { workspacePage } from './coopanion/features/framework/index.ts';

const bundle: WebUiClientBundle = {
  panels: Object.fromEntries(WORKSPACE_PANELS.map(([id]) => [
    id, { mount: ctx => mountConsolePage(workspacePage(id), ctx) },
  ])),
};
export default bundle;
