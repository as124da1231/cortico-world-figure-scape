import type { WebUi } from 'cortico/web/shared/client-panel.ts';
import { openModal, modalCard, type OverlayEnv } from '../../../shared/modal.ts';
import { S } from './strings.ts';

export function confirm(
  ui: WebUi, env: OverlayEnv, opts: { title: string; body: HTMLElement; ok: string },
): Promise<boolean> {
  if (env.signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let accepted = false;
    const modal = openModal(env, () => resolve(accepted));
    const { body } = modalCard(env, modal, opts.title, true);
    const bar = ui.h('div', 'rowbar');
    const cancel = ui.button(S.cancel, { size: 'sm' });
    const ok = ui.button(opts.ok, { size: 'sm', variant: 'primary' });
    cancel.addEventListener('click', () => modal.close(), { signal: modal.signal });
    ok.addEventListener('click', () => { accepted = true; modal.close(); }, { signal: modal.signal });
    bar.append(ui.h('span', 'grow'), cancel, ok);
    body.append(opts.body, bar);
    ok.focus();
  });
}
