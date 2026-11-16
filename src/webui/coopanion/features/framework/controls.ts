import type { PageContext } from '../../base/page.ts';
import { invokePanel } from '../../base/api.ts';
import { LANGUAGE } from '../../base/language.ts';
import { WORKSPACE_PROVIDER, workspaceHref, type WorkspacePanel } from '../../../../framework/workspace.ts';

export const studioText = (cn: string, en: string) => LANGUAGE.startsWith('zh') ? cn : en;
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Shared primitives and the framework data plane for the task surfaces. */
export function studioControls(ctx: PageContext) {
  const doc = ctx.root.ownerDocument;
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') {
    const el = doc.createElement(tag);
    el.textContent = text;
    el.className = cls;
    return el;
  }
  function button(text: string, run: () => void, primary = false) {
    const el = node('button', text, primary ? 'studio-button is-primary' : 'studio-button');
    el.type = 'button';
    el.addEventListener('click', run, { signal: ctx.signal });
    return el;
  }
  function link(title: string, target: WorkspacePanel, task?: string) {
    const anchor = node('a', title, 'studio-link');
    anchor.href = workspaceHref(target, task);
    return anchor;
  }
  function section(title: string, description = '') {
    const el = node('section', '', 'studio-section');
    el.append(node('h2', title));
    if (description) el.append(node('p', description, 'studio-help'));
    return el;
  }
  function field(title: string, control: HTMLElement, description = '') {
    const el = node('label', '', 'studio-field'), copy = node('span', '', 'studio-field-copy');
    copy.append(node('strong', title));
    if (description) copy.append(node('small', description));
    el.append(copy, control);
    return el;
  }
  function range(input: HTMLInputElement, min: number, max: number, step: string, format: (value: number) => string = String) {
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = step;
    const element = node('span', '', 'studio-range');
    const readout = node('span', '', 'studio-range-value');
    readout.setAttribute('aria-hidden', 'true');
    element.append(input, readout);
    function sync() {
      const text = format(Number(input.valueAsNumber.toFixed(3)));
      readout.textContent = text;
      input.setAttribute('aria-valuetext', text);
      input.style.setProperty('--studio-range-progress', (100 * (input.valueAsNumber - min) / (max - min)) + '%');
    }
    input.addEventListener('input', sync, { signal: ctx.signal });
    sync();
    return { element, sync };
  }
  function status(cls = 'studio-status') {
    const el = node('p', '', cls);
    el.setAttribute('role', 'status');
    return el;
  }
  function dialog(title: string, cls = '') {
    const element = node('dialog', '', ('framework-dialog studio-dialog ' + cls).trim());
    const header = node('header', '', 'studio-preview-header');
    const heading = node('h2', title);
    const body = node('div', '', 'studio-dialog-body');
    const close = button('×', () => element.close());
    close.classList.add('studio-dialog-close');
    close.setAttribute('aria-label', studioText('关闭', 'Close'));
    heading.id = 'studio-dialog-' + (doc.defaultView?.crypto.randomUUID?.() ?? Math.random().toString(36).slice(2));
    header.append(heading, close);
    element.setAttribute('aria-labelledby', heading.id);
    element.append(header, body);
    element.addEventListener('close', () => { if (!element.open) element.remove(); }, { signal: ctx.signal });
    ctx.signal.addEventListener('abort', () => {
      if (element.open) element.close();
      element.remove();
    }, { once: true });
    let opener: HTMLElement | null = null;
    element.addEventListener('close', () => {
      if (ctx.signal.aborted) return;
      if (opener?.isConnected && !opener.closest('[hidden],details:not([open]) > :not(summary)')) opener.focus({ preventScroll: true });
      else ctx.root.querySelector<HTMLElement>('.studio-surface')?.focus({ preventScroll: true });
      opener = null;
    }, { signal: ctx.signal });
    function open(trigger?: HTMLElement) {
      if (ctx.signal.aborted || element.open || ctx.root.querySelector('dialog[open]')) return false;
      opener = trigger?.nodeType === 1 ? trigger : doc.activeElement as HTMLElement | null;
      ctx.root.append(element);
      element.showModal();
      return true;
    }
    return { element, heading, body, close, open };
  }
  function call<T>(method: string, args: unknown[] = []) {
    return invokePanel<T>(WORKSPACE_PROVIDER, 'framework', method, args, { signal: ctx.signal });
  }
  function keepalive(method: string, args: unknown[]) {
    void invokePanel(WORKSPACE_PROVIDER, 'framework', method, args, { keepalive: true }).catch(() => {});
  }
  return { doc, node, button, link, section, field, range, status, dialog, call, keepalive };
}
