// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ invokePanel: vi.fn() }));
vi.mock('../src/webui/coopanion/base/api.ts', () => api);
vi.mock('../src/webui/coopanion/base/language.ts', () => ({ LANGUAGE: 'zh' }));
import { phoneLinkPanel } from '../src/webui/coopanion/features/framework/phone-link.ts';
import type { PageContext } from '../src/webui/coopanion/base/page.ts';

it('clears a recovered status read error without hiding a pairing action failure', async () => {
  const abort = new AbortController();
  const root = document.createElement('div');
  document.body.append(root);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  let failStatus = true;
  api.invokePanel.mockImplementation(async (_provider, _panel, method) => {
    if (method === 'phone.pair') throw Error('Unable to create code');
    if (failStatus) throw Error('Temporary status failure');
    return {
      running: true, ready: true, issue: null, apk: null,
      consolePort: 17788, hasPassword: false, addresses: ['192.168.1.3'], devices: [],
    };
  });
  try {
    const phone = phoneLinkPanel({
      root, signal: abort.signal, lifecycle: { interval: () => 0 },
      ui: { button: (value: string) => { const button = document.createElement('button'); button.textContent = value; return button; } },
    } as unknown as PageContext);
    root.append(phone.element);
    phone.element.querySelector<HTMLButtonElement>('[aria-haspopup=dialog]')!.click();
    const dialog = root.querySelector<HTMLDialogElement>('dialog[open]')!;
    const feedback = dialog.querySelector('.studio-phone-feedback')!;
    await vi.waitFor(() => expect(feedback.textContent).toContain('Temporary status failure'));

    failStatus = false;
    await phone.update();
    expect(feedback.textContent).toBe('');
    expect(dialog.textContent).toContain('等待手机扫码或重连');

    [...dialog.querySelectorAll('button')].find(button => button.textContent === '生成配对码')!.click();
    await vi.waitFor(() => expect(feedback.textContent).toContain('Unable to create code'));
    await phone.update();
    expect(feedback.textContent).toContain('Unable to create code');
  } finally {
    abort.abort();
    root.remove();
  }
});
