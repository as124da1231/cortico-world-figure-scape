import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

export interface PageContext {
  readonly root: HTMLElement;
  readonly signal: AbortSignal;
  readonly pickPath?: WebUiPanelContext['pickPath'];
  readonly ui: WebUiPanelContext['ui'];
  readonly stream?: WebUiPanelContext['stream'];
  readonly lifecycle: {
    interval: WebUiPanelContext['interval'];
    add(cleanup: () => void): void;
  };
}

export interface Page {
  readonly route: string;
  readonly label: string;
  readonly icon: string;
  mount(ctx: PageContext): void | Promise<void>;
}

export function mountConsolePage(page: Page, ctx: WebUiPanelContext): void | Promise<void> {
  const root = ctx.ui.h('div', 'desktop-live2d-native-page');
  ctx.root.append(root);
  return page.mount({
    root, ui: ctx.ui, signal: ctx.signal, pickPath: options => ctx.pickPath(options), stream: handlers => ctx.stream(handlers),
    lifecycle: {
      interval: (fn, ms) => ctx.interval(fn, ms),
      add: dispose => { ctx.own({ dispose }); },
    },
  });
}

declare global {
  interface Window {
    coopanionWindow?: { loginItem?: { get(): boolean; set(enabled: boolean): void } };
  }
}
