export const WORKSPACE_PROVIDER = 'world:desktop-live2d-pet';

export const WORKSPACE_PANELS = [
  ['framework', '工作台', 'Workbench'],
  ['sound', '声音', 'Sound'],
  ['desktop', '场景', 'Scenes'],
  ['interaction', '交互', 'Interaction'],
  ['controls', '操作台布局', 'Control layout'],
  ['display', '显示', 'Display'],
  ['permissions', '权限', 'Permissions'],
  ['services', '模型服务', 'Model services'],
] as const;

export type WorkspacePanel = typeof WORKSPACE_PANELS[number][0];
type PanelLink = WorkspacePanel | '~prompts';

export function workspaceHref(panel: PanelLink, task?: string): string {
  return '#/provider/' + encodeURIComponent(WORKSPACE_PROVIDER) + '/' + panel
    + (task ? '?' + new URLSearchParams({ task }) : '');
}

export function legacyWorkspaceDestination(query: URLSearchParams, panel: string = 'framework'): string | null {
  const task = query.get('task') ?? undefined;
  if (query.has('cua')) return workspaceHref('permissions', 'computer');
  if (panel === 'model' || panel === 'performance') return workspaceHref('framework', task ?? (panel === 'model' ? 'library' : 'bindings'));
  if (panel === 'interaction') {
    if (task === 'mouth') return workspaceHref('framework', 'mouth');
    if (task === 'computer' || task === 'autonomy') return workspaceHref('permissions', task);
    if (task && ['speech', 'sound-effects', 'tts', 'listening', 'recognition', 'planner'].includes(task)) return workspaceHref('sound', task);
  }
  if (panel === 'desktop' && task === 'presentation') return workspaceHref('desktop', 'space');
  if (panel === 'desktop' && task === 'desktop-settings') return workspaceHref('desktop', 'desktop');
  switch (query.get('area')) {
    case 'resources': return workspaceHref('framework', 'library');
    case 'body': return workspaceHref('framework', task ?? 'framing');
    case 'expression': return workspaceHref('framework', task ?? 'bindings');
    case 'sound': return workspaceHref('sound', task);
    case 'interaction': return workspaceHref('interaction', task);
    case 'environment': return task === 'prompt' ? workspaceHref('~prompts') : workspaceHref('desktop');
    default: return null;
  }
}
