import { expect, it, vi } from 'vitest';
import { createSpeechHandoff, type SpeechOrder } from '../src/framework/speech-handoff.ts';

function order(id: string): SpeechOrder {
  return { id, figure:'figure-a', cursor:72, beats:[
    {text:'第一段',actions:['happy'],anchors:[{at:1,actions:['smile']}]},
    {text:'继续第二段',actions:['nod'],anchors:[{at:2,actions:['wink']}]},
  ], clips:[id+'-a',id+'-b'], faces:[null,null], planClips:[], cueBeat:0 };
}

it('keeps the original speech and conversation identifiers across both transfers without repeating the earlier beat', async () => {
  const transfer = createSpeechHandoff(vi.fn());
  const first = order('speech'), second = order('queued');
  transfer.remember(first);
  const request = vi.fn(() => true);
  const capture = transfer.capture('desktop',request);
  const [token] = request.mock.calls[0] as unknown as [string];
  expect(transfer.defer(second)).toBe(true);
  transfer.receive('cabin',token,[]);
  const checkpoint = {id:first.id,beat:1,shown:2,fired:1,offset:1.75,audio:true,leading:true,displayed:true};
  transfer.receive('desktop',token,[checkpoint,checkpoint,{id:'unrelated',beat:0}]);
  await capture;
  expect([...transfer.clips()]).toEqual(['speech-b','queued-a','queued-b']);
  const toCabin = transfer.resume('figure-a');
  expect(toCabin).toEqual([{...first,clips:[null,'speech-b'],resume:checkpoint},second]);
  toCabin.forEach(item=>transfer.remember(item));

  const back = vi.fn(() => true);
  const returning = transfer.capture('cabin',back);
  const [backToken] = back.mock.calls[0] as unknown as [string];
  transfer.receive('desktop',token,[checkpoint]);
  transfer.receive('cabin',backToken,[{...checkpoint,shown:4,offset:2.4}]);
  await returning;
  expect(transfer.resume('other-body')).toEqual([expect.objectContaining({
    id:'speech',cursor:72,figure:'other-body',clips:[null,'speech-b'],resume:{...checkpoint,shown:4,offset:2.4},
    beats:[{text:'第一段',actions:[],anchors:[]},{text:'继续第二段',actions:[],anchors:[]}],
  })]);
  expect(transfer.active()).toBe(false);
});

it('keeps a queued reply through a snapshot timeout and can clean an abandoned transfer', async () => {
  vi.useFakeTimers();
  try {
    const stop = vi.fn(), transfer = createSpeechHandoff(stop);
    const sent = vi.fn(() => true);
    const capture = transfer.capture('desktop',sent);
    expect(transfer.defer(order('waiting'))).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    await capture;
    expect(transfer.resume('figure-a')).toEqual([order('waiting')]);
    await transfer.capture('desktop',() => false);
    expect(transfer.defer(order('abandoned'))).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(stop.mock.calls.map(args => args[0])).toEqual(['abandoned-a','abandoned-b']);
    expect(transfer.active()).toBe(false);
  } finally { vi.useRealTimers(); }
});

it('recovers the last reported progress if a Cabin renderer cannot answer and honors an explicit empty checkpoint', async () => {
  vi.useFakeTimers();
  try {
    const transfer = createSpeechHandoff(vi.fn());
    const speech = order('detached');
    transfer.remember(speech);
    const checkpoint = {id:speech.id,beat:1,shown:3,fired:1,offset:1.25,audio:true,leading:true,displayed:false};
    const recover = vi.fn(() => [checkpoint]);
    const capture = transfer.capture('cabin',() => true,recover);
    await vi.advanceTimersByTimeAsync(900);
    await capture;
    expect(transfer.resume('figure-a')).toEqual([{...speech,clips:[null,'detached-b'],resume:checkpoint}]);
    await transfer.capture('cabin',() => false,recover);
    expect(transfer.resume('figure-a')[0]?.resume).toEqual(checkpoint);

    recover.mockClear();
    await transfer.capture('cabin',request => { transfer.receive('cabin',request,[]); return true; },recover);
    expect(recover).not.toHaveBeenCalled();
    expect(transfer.resume('figure-a')).toEqual([]);
  } finally { vi.useRealTimers(); }
});
