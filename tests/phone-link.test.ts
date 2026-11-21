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
  vi.mocked(startLink).mockReset();
  let enabled = false;
  const persist = vi.fn((value: boolean) => { enabled = value; });
  const phone = createPhoneConnection({
    dataDir: 'test-data',
    consolePort: () => undefined,
    persistConsolePort: vi.fn(),
    passwordSecret: () => undefined,
    storePasswordSecret: vi.fn(),
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


test('only World settings feed the console port and password; the panel returns no password', async () => {
  vi.mocked(startLink).mockReset();
  let enabled = false, port: number | undefined, secret: string | undefined;
  const phone = createPhoneConnection({
    dataDir: 'test-data',
    consolePort: () => port,
    persistConsolePort: value => { port = value; },
    passwordSecret: () => secret,
    storePasswordSecret: value => {
      // Mirror Cortico's storeSecret contract without touching real credentials.
      if (!value || /\s/u.test(value)) throw Error('Invalid secret storage value');
      secret = value;
    },
    enabled: () => enabled,
    persist: value => { enabled = value; },
  });
  vi.mocked(startLink).mockResolvedValue({
    stop: vi.fn(), createPairCode: vi.fn(), revoke: vi.fn(),
    setupStatus: async () => ({ ready: true, coo: '', devices: [], addresses: [] }),
  });
  await phone.start('http://127.0.0.1:7802', () => {});
  expect(await phone.status()).toMatchObject({ consolePort: 17788, hasPassword: false });
  await expect(phone.configure(0, 'fake')).rejects.toThrow('Invalid');
  expect(secret).toBeUndefined();
  const longest = '密'.repeat(4096);
  expect(await phone.configure(17880, longest)).toMatchObject({ hasPassword: true });
  expect(secret).toHaveLength(16387);
  await expect(phone.configure(17880, longest + 'x')).rejects.toThrow('Invalid');
  const state = await phone.configure(17880, '   fake-secret   ');
  expect(state).toMatchObject({ consolePort: 17880, hasPassword: true });
  expect(JSON.stringify(state)).not.toContain('fake-secret');
  expect(JSON.stringify(state)).not.toContain(secret!);
  await phone.configure(17881, undefined);
  await phone.setEnabled(true);
  const options = vi.mocked(startLink).mock.calls[0][0];
  expect(options.cooPort).toBe(17881);
  expect(options.getPassword?.()).toBe('   fake-secret   ');
  await expect(phone.configure(17788, '')).rejects.toThrow();
  expect(secret).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);
  expect(options.getPassword?.()).toBe('   fake-secret   ');
  await phone.setEnabled(false);
  expect(await phone.configure(17788, '')).toMatchObject({ consolePort: 17788, hasPassword: false });
  expect(secret).toBe('v1.');
  await phone.setEnabled(true);
  expect(vi.mocked(startLink).mock.calls[1][0].getPassword?.()).toBe('');
  await phone.stop();
});
