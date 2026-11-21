import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Browser microphone module.
import { createMic } from '../web/mic.js';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const media = new EventTarget();
  const getUserMedia = vi.fn();
  Object.assign(media, { enumerateDevices: async () => [], getUserMedia });
  vi.stubGlobal('navigator', { mediaDevices: media });
  const reports: string[] = [];
  const capture = createMic({ prefs: { mic: true, micDevice: '' },
    send: (message: { t: string; state: string }) => { if (message.t === 'mic') reports.push(message.state); },
    sendAudio: () => {} });
  return { media, getUserMedia, reports, capture };
}

describe('desktop microphone capture state', () => {
  it('stays denied on repeated prefs, and retries after an explicit off/on', async () => {
    const { capture, getUserMedia, reports } = fixture();
    getUserMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    await capture.start();
    await capture.start();
    expect(reports).toEqual(['opening', 'denied']);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    capture.stop();
    await capture.start();
    expect(reports).toEqual(['opening', 'denied', 'off', 'opening', 'denied']);
  });

  it('cleans up a failed audio graph and retries on device change', async () => {
    const { capture, media, getUserMedia, reports } = fixture();
    const close = vi.fn();
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    getUserMedia.mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] });
    const connect = vi.fn().mockImplementationOnce(() => { throw Error('Graph failed'); });
    vi.stubGlobal('AudioContext', class {
      audioWorklet = { addModule: async () => {} };
      close = close;
      createMediaStreamSource() { return { connect }; }
    });
    vi.stubGlobal('AudioWorkletNode', class { port = {}; });
    await capture.start();
    expect(reports).toEqual(['opening', 'error']);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    media.dispatchEvent(new Event('devicechange'));
    await vi.waitFor(() => expect(reports).toEqual(['opening', 'error', 'off', 'opening', 'on']));
    capture.stop();
    expect(track.stop).toHaveBeenCalledTimes(2);
    expect(reports.at(-1)).toBe('off');
  });
});
