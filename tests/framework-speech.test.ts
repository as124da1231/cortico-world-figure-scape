import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser module
import { createSpeechPresentation } from '../web/framework/speech.js';
// @ts-expect-error browser module
import { createSpeech } from '../web/speech.js';

describe('speech presentation contract', () => {
 it('keeps bubble progress with the audio clock and returns to text on failure', () => {
  const clip = { state: 'preparing', position: 0, duration: 4 };
  const player = { play: vi.fn(() => clip), stop: vi.fn(), snapshot: vi.fn() };
  const onUnit = vi.fn(), speech = createSpeechPresentation({ audio: {}, onUnit, createPlayer: () => player });
  const owner = {};
  speech.start(owner, { text: '你🌟好!', clip: 'first' });
  expect(speech.progress(owner)).toEqual({ mode: 'waiting' });
  clip.state = 'started'; clip.position = 2;
  expect(speech.progress(owner)).toEqual({ mode: 'audio', shown: 3, done: false });
  expect(speech.progress({})).toEqual({ mode: 'text' });
  clip.state = 'failed';
  expect(speech.progress(owner)).toEqual({ mode: 'text' });
  expect(onUnit).not.toHaveBeenCalled();
  speech.dispose(); speech.dispose();
  expect(player.stop.mock.calls).toEqual([['replaced'], ['disposed']]);
 });
 it('releases the body contribution on preview and stop without forcing the expression mouth to zero', () => {
  const onRelease=vi.fn(), player={snapshot:vi.fn(),stop:vi.fn()};
  const speech=createSpeechPresentation({audio:{},onRelease,bodySpeech:()=>({supported:{pulse:true,release:true},status:'applied',state:{pulse:0}}),createPlayer:()=>player});
  speech.stop(); speech.preview('release', 'preview');
  expect(onRelease).toHaveBeenCalledTimes(2);
  expect(speech.snapshot()).toMatchObject({capabilities:{releaseSpeechContribution:true,immediateMouthReset:false},body:{state:{pulse:0}}});
 });
 it('ignores old same-text request completion after stop and restart', async () => {
  const requests: Array<{resolve:(value:unknown)=>void}> = [];
  vi.stubGlobal('location', {href:'http://localhost/'});
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const speech = createSpeech({output:()=>null}, {unitsOf:()=>new Promise(resolve=>requests.push({resolve}))});
  speech.configure({enabled:true}); speech.begin('same'); speech.stop(); speech.begin('same');
  // An old malformed answer must not touch or throw in the restarted generation.
  requests[0].resolve(null); await Promise.resolve();
  requests[1].resolve([]); await Promise.resolve();
  expect(speech.snapshot()).toMatchObject({generation:3,error:null,scheduledSources:0});
  speech.stop();vi.unstubAllGlobals();
 });
});
