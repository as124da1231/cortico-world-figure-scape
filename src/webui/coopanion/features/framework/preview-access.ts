import { workspaceHref } from '../../../../framework/workspace.ts';

/** The native settings session permits the Core origin and Desktop Pet's own origin. */
export function requiresBrowserPreview(win: Window): boolean {
  return !!(win as Window & { coopanionWindow?: { platform?: string } }).coopanionWindow?.platform;
}

export function browserWorkbench(win: Window, worldUrl: string | URL, task: string, model: string): string {
  const url = new URL('/workbench-browser', worldUrl);
  const core = new URL('/', win.location.origin);
  core.hash = workspaceHref('framework', task) + '&model=' + encodeURIComponent(model);
  url.searchParams.set('return', core.href);
  return url.href;
}
