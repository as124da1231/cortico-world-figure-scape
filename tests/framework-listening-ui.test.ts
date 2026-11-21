// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { PageContext } from '../src/webui/coopanion/base/page.ts';

const api = vi.hoisted(() => ({ invokePanel: vi.fn() }));
vi.mock('../src/webui/coopanion/base/api.ts', () => api);
vi.mock('../src/webui/coopanion/base/language.ts', () => ({ LANGUAGE: 'en' }));
import { listening } from '../src/webui/coopanion/features/framework/listening.ts';

it('shows the pending microphone connection and cancels after a late start receipt if the dialog closed', async () => {
  const initial = {
    enabled: true, windowVisible: true, engine: 'funasr', engineSetting: '',
    server: { phase: 'running' }, model: {phase: 'ready'}, api: {model: ''},
    mic: {state: 'off'}, input: {mode: 'toggle', deviceId: '', devices: []},
    test: {phase: 'idle'}, level: -100, thresholdDb: -35, recent: [],
  };
  let accept!: (value: unknown) => void;
  const pending = new Promise(resolve => { accept = resolve; });
  api.invokePanel.mockImplementation(async (_page, _panel, method) => method === 'testStart' ? pending : initial);
  const root = document.createElement('div');
  const controller = new AbortController();
  const panel = listening({root,signal:controller.signal,lifecycle:{interval() {}}} as unknown as PageContext, vi.fn());
  root.append(panel.element);
  await panel.refresh();

  const primary = root.querySelector<HTMLButtonElement>('.studio-voice-test-actions button')!;
  const cancel = root.querySelector<HTMLButtonElement>('.studio-voice-test-actions button:last-child')!;
  const result = root.querySelector<HTMLElement>('.studio-voice-test-result')!;
  primary.click();
  expect(result.dataset.phase).toBe('opening');
  expect(primary.disabled).toBe(true);
  expect(cancel.disabled || cancel.hidden).toBe(false);
  panel.cancelTest();
  expect(api.invokePanel.mock.calls.map(args => args[2])).toEqual(['state', 'testStart']);
  accept({...initial,test:{phase:'opening'}});
  await vi.waitFor(() => expect(result.dataset.phase).toBe('idle'));
  expect(api.invokePanel.mock.calls.map(args => args[2])).toEqual(['state', 'testStart', 'testCancel']);
  expect(primary.disabled).toBe(false);
  controller.abort();
});
