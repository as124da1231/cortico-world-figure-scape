import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser module
import { createSpeechPresentation } from '../web/framework/speech.js';
// @ts-expect-error browser module
import { createSpeech } from '../web/speech.js';
// @ts-expect-error browser module
import { createCabinSpeech } from '../web/framework/cabin-speech.js';

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

it('plays queued Cabin beats on their confirmed body, deduplicates and releases pending clips on exit', () => {
  let receive: (message: unknown) => void = () => {};
  let progress = {mode:'waiting',shown:0,done:false};
  const report = vi.fn(), unsubscribe = vi.fn();
  const body = {pack:'resident',words:['happy','wink'],layout:{},do:vi.fn(),set:vi.fn(),speech:vi.fn()};
  const shared = {start:vi.fn(),stop:vi.fn(),dispose:vi.fn(),tick:vi.fn(),position:()=>1.25,progress:()=>progress};
  const player = createCabinSpeech({body:()=>body,transport:{report,subscribe(callback:typeof receive){receive=callback;return unsubscribe;}},
    createSpeech:()=>shared});
  player.mount({vocab:[{id:'happy',seconds:.01},{id:'wink',seconds:.01},{id:'declared-only',seconds:.01}]},'current-body');
  expect(report).toHaveBeenCalledWith({type:'body-capabilities',figure:'resident',generation:'current-body',words:['happy','wink'],wordSource:'renderer'});
  const beat = {text:'你好',actions:['happy'],anchors:[{at:2,actions:['wink']}]};
  const take = (id: string, figure = 'resident') => ({type:'speech-play',generation:'current-body',speech:{id,figure,beats:[beat],clips:[id],faces:['happy'],planClips:[id]}});
  const expired = { ...take('stale-body'),generation:'former-body',actionDeadline:Date.now()+1000 };
  receive(expired);
  expect(report).toHaveBeenCalledWith({type:'speech-accepted',id:'stale-body',generation:'former-body',accepted:false});
  const unsupported = take('declared');
  receive({...unsupported,actionDeadline:Date.now()+1000,speech:{...unsupported.speech,beats:[{...beat,actions:['declared-only']}]}});
  expect(report).toHaveBeenCalledWith({type:'speech-accepted',id:'declared',generation:'current-body',accepted:false});
  receive(take('old','other'));
  expect(report).toHaveBeenCalledWith({id:'old',status:'cancelled',reason:'target-unavailable'});
  receive(take('current'));
  receive(take('current'));
  receive(take('next'));
  player.tick(.016);
  expect(shared.start).toHaveBeenCalledExactlyOnceWith(beat,expect.objectContaining({clip:'current',face:'happy',wantsPlan:true}));
  expect(report).toHaveBeenCalledWith({type:'speech-progress',rows:[
    expect.objectContaining({id:'current', clip:'current', offset:1.25, audio:true, leading:true}),
    expect.objectContaining({id:'next', clip:'next', offset:0, leading:false}),
  ]});
  player.tick(.016);
  expect(body.do).toHaveBeenCalledExactlyOnceWith('happy');
  progress = {mode:'audio',shown:2,done:true};
  player.tick(.016);
  player.tick(.016);
  expect(body.do).toHaveBeenLastCalledWith('wink');
  expect(shared.start.mock.calls.map(([,options])=>options.clip)).toEqual(['current','next']);
  receive(take('pending'));
  player.dispose();
  expect(shared.stop).toHaveBeenLastCalledWith('scene-closed');
  expect(report).toHaveBeenCalledWith({id:'pending',status:'cancelled',reason:'scene-closed'});
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('reports Cabin action completion and interrupts standalone orders during speech handoff', () => {
  let receive: (message: unknown) => void = () => {};
  const report = vi.fn();
  const word = 'wink';
  const body = {pack:'resident',words:[word],layout:{},do:vi.fn(),set:vi.fn(),speech:vi.fn()};
  const player = createCabinSpeech({body:()=>body,transport:{report,subscribe(callback:typeof receive){receive=callback;return () => {}; }},
    createSpeech:()=>({start:vi.fn(),stop:vi.fn(),tick:vi.fn(),dispose:vi.fn(),position:()=>null,take:()=>null,progress:()=>({mode:'text'})})});
  const generation = 'body';
  player.mount({vocab:[{id:word,seconds:.01}]},generation);
  function enqueue(id:string) {
    receive({type:'speech-play',generation,actionDeadline:Date.now()+1000,
      speech:{id,figure:'resident',beats:[{text:'',actions:[word],anchors:[]}],clips:[],faces:[],planClips:[]}});
  }
  enqueue('first');
  enqueue('next');
  player.tick(.001);
  player.tick(.001);
  player.event('done',{word});
  expect(report).toHaveBeenCalledWith({type:'body-action',id:'first',generation,status:'running'});
  expect(report).toHaveBeenCalledWith({type:'body-action',id:'first',generation,status:'completed',completion:'body-event'});
  receive({type:'speech-take',request:'handoff',deadline:Date.now()+1000});
  expect(report).toHaveBeenCalledWith({type:'body-action',id:'next',generation,status:'interrupted',reason:'scene-handoff'});
  expect(report).toHaveBeenCalledWith({type:'speech-checkpoint',request:'handoff',rows:[]});
  expect(body.do).toHaveBeenCalledExactlyOnceWith(word);
  player.dispose();
});
