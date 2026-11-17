import { expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { createPhoneConnection } from '../src/phone-link/service.ts';
import { startLink } from '../src/phone-link/link.mjs';

vi.mock('../src/phone-link/link.mjs', () => ({
  startLink: vi.fn(),
  apkInfo: () => ({ size: 4165187 }),
  defaultConsolePort: 17788,
}));

test('the existing pairing store is reused and a port conflict can be retried without enabling a second relay', async () => {
  let enabled = false;
  const persist = vi.fn((value: boolean) => { enabled = value; });
  const phone = createPhoneConnection({
    dataDir: 'test-data',
    botDir: 'test-bot',
    secret: () => '',
    enabled: () => enabled,
    persist,
  });
  const stop = vi.fn(async () => {});
  const setupStatus = vi.fn(async () => ({
    ready: true,
    coo: '',
    addresses: ['192.168.0.10'],
    devices: [{ id: 'paired-phone', name: 'Phone', added: '2026-01-01' }],
  }));
  vi.mocked(startLink)
    .mockRejectedValueOnce(Object.assign(Error('Address is in use'), { code: 'EADDRINUSE' }))
    .mockResolvedValueOnce({ stop, setupStatus, createPairCode: vi.fn(), revoke: vi.fn() });
  await phone.start('http://127.0.0.1:7802', () => {});
  expect(startLink).not.toHaveBeenCalled();
  expect(await phone.setEnabled(true)).toMatchObject({ running: false, issue: 'port-in-use' });
  expect(persist).not.toHaveBeenCalled();
  const [first, second] = await Promise.all([phone.setEnabled(true), phone.setEnabled(true)]);
  expect(first).toMatchObject({ running: true, devices: [{ id: 'paired-phone' }] });
  expect(second).toEqual(first);
  expect(startLink).toHaveBeenCalledTimes(2);
  const [params] = vi.mocked(startLink).mock.calls[1];
  expect(params.home).toBe(join('test-data', 'yume-pet'));
  expect(params.figureScapeOrigin()).toBe('http://127.0.0.1:7802');
  await phone.stop();
  expect(stop).toHaveBeenCalledOnce();
  expect(enabled).toBe(true);
});
