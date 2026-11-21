import { createBodyActions } from './actions.js';
import { createSpeechPresentation } from './speech.js';

/** Plays the current Cabin resident's performance. The text remains in Coo's event store. */
export function createCabinSpeech({ body, transport, createSpeech = createSpeechPresentation }) {
  let context, current;
  let nextProgress = 0;
  let generation = null;
  let words = new Set();
  const queue = [], seen = new Set();
  const tracked = new Map();
  const actions = createBodyActions({ body: { get body() { return body(); } }, receipt: () => {}, onWordReceipt });
  const speech = createSpeech({
    audio: { speechOutput() {
      if (!context) {
        const ctx = new AudioContext();
        const master = ctx.createGain();
        master.gain.value = .55;
        master.connect(ctx.destination);
        context = { ctx, master };
      }
      return context;
    } },
    onRelease: () => body()?.speech({kind:'release'}),
    onMediaLevel: level => body()?.speechLevel(level),
    onMediaPlan: command => body()?.speechPlan(command),
    onMediaReport: report => transport.report(report),
  });

  function reportAction(id, request, status, detail = {}) {
    transport.report({type:'body-action',id,generation:request.generation,status,...detail});
  }

  function onWordReceipt(row) {
    const request = tracked.get(row.requestId);
    if (!request) return;
    if (row.status === 'running' && !request.started) {
      request.started = true;
      reportAction(row.requestId,request,'running');
    }
    if (!['completed','failed','interrupted'].includes(row.status)) return;
    if (row.completion === 'duration') request.timed = true;
    if (row.status === 'failed' || (row.status === 'interrupted' && !request.failure)) {
      request.failure = { status:row.status, reason:row.reason };
    }
    if (--request.remaining > 0) return;
    tracked.delete(row.requestId);
    if (request.failure) reportAction(row.requestId,request,request.failure.status,{reason:request.failure.reason});
    else reportAction(row.requestId,request,'completed',{completion:request.timed ? 'duration' : 'body-event'});
  }

  function interruptActions(reason) {
    actions.interrupt(reason);
    for (const [id, request] of tracked) reportAction(id,request,'interrupted',{reason});
    tracked.clear();
  }

  function cancelClips(item, start, reason) {
    for (const id of item.clips.slice(start)) if (id) transport.report({id,status:'cancelled',reason});
  }
  function stop(reason) {
    speech.stop(reason);
    interruptActions(reason);
    if (current) cancelClips(current.item, current.index + 1, reason);
    for (const item of queue.splice(0)) cancelClips(item, 0, reason);
    current = undefined;
    publishProgress();
  }
  const unsubscribe = transport.subscribe(message => {
    if (message.type === 'speech-stop') { stop(message.reason); return; }
    if (message.type === 'speech-take') {
      if (Number.isFinite(message.deadline) && Date.now() <= message.deadline) {
        transport.report({type:'speech-checkpoint',request:message.request,rows:take()});
      }
      return;
    }
    const item = message.speech;
    if (message.type !== 'speech-play' || !item || !Array.isArray(item.beats) || !Array.isArray(item.clips)) return;
    const acknowledge = Number.isFinite(message.actionDeadline);
    const wordsInOrder = item.beats.length === 1 && !item.beats[0].text && !item.beats[0].anchors?.length && !item.clips.length
      ? item.beats[0].actions : null;
    const receipt = accepted => {
      if (acknowledge) transport.report({type:'speech-accepted',id:item.id,generation:message.generation,accepted});
    };
    if (generation === null || message.generation !== generation || body()?.pack !== item.figure || queue.length >= 12 ||
      (acknowledge && (Date.now() > message.actionDeadline || !Array.isArray(wordsInOrder) || !wordsInOrder.length ||
        wordsInOrder.length > 6 || wordsInOrder.some(word => !words.has(word))))) {
      cancelClips(item, 0, 'target-unavailable');
      receipt(false);
      return;
    }
    if (seen.has(item.id)) { receipt(true); return; }
    seen.add(item.id);
    if (seen.size > 64) seen.delete(seen.values().next().value);
    if (acknowledge) tracked.set(item.id,{generation,remaining:wordsInOrder.length,started:false,timed:false});
    queue.push(item);
    receipt(true);
    publishProgress();
  });
  function checkpoints(position) {
    const rows = queue.filter(item => !tracked.has(item.id)).map(item => {
      const checkpoint = item.resume ?? {id:item.id,beat:0,shown:0,fired:0,offset:0,audio:true,leading:false};
      return {...checkpoint,clip:item.clips[checkpoint.beat] ?? null};
    });
    if (!current || tracked.has(current.item.id)) return rows;
    const { item,index,fired,shown } = current;
    return [{id:item.id,beat:index,shown,fired,offset:position ?? 0,audio:position !== null,leading:true,
      displayed:item.resume?.displayed,clip:item.clips[index] ?? null},...rows];
  }
  function publishProgress() {
    if (!current && !queue.length && !nextProgress) return;
    nextProgress = current || queue.length ? performance.now() + 250 : 0;
    transport.report({type:'speech-progress',rows:checkpoints(current ? speech.position(current.beat) : null)});
  }
  function take() {
    const rows = checkpoints(current ? speech.take(current.beat) : null);
    for (const row of rows) seen.delete(row.id);
    queue.length = 0;
    interruptActions('scene-handoff');
    current = undefined;
    nextProgress = 0;
    return rows;
  }
  function nextBeat(item, index, resume) {
    const beat = item.beats[index], clip = item.clips[index];
    if (!beat) { current = undefined; publishProgress(); return; }
    current = { item,index,beat,shown:resume?.shown ?? 0,elapsed:(resume?.shown ?? 0) / 20,fired:resume?.fired ?? 0 };
    if (tracked.has(item.id)) actions.enqueueRequest(item.id,...beat.actions);
    else if (!resume?.leading) actions.enqueue(...beat.actions);
    speech.start(beat, { text:beat.text, clip, cues:index === (item.cueBeat ?? item.clips.findIndex(Boolean)) ? item.cues : undefined,
      wantsPlan:item.planClips.includes(clip), face:item.faces[index],offset:resume?.offset });
    if (beat.text && !clip) body()?.speech({kind:'pulse'});
    publishProgress();
  }
  return {
    mount(pack, nextGeneration) {
      const runtimeWords = body()?.words;
      const reported = Array.isArray(runtimeWords);
      const vocab = reported ? pack.vocab.filter(word => runtimeWords.includes(word.id)) : pack.vocab;
      generation = nextGeneration;
      words = new Set(vocab.map(word => word.id));
      seen.clear();
      actions.bodyCommitted({vocab});
      transport.report({type:'body-capabilities',figure:body()?.pack,generation,words:[...words],wordSource:reported ? 'renderer' : 'manifest'});
    },
    event(kind, detail) { actions.event(kind, detail); },
    tick(dt) {
      actions.tick(dt);
      speech.tick();
      if (!current) {
        const item = queue.shift();
        if (item) nextBeat(item, item.resume?.beat ?? 0, item.resume);
        return;
      }
      const { item, index, beat, fired } = current;
      const progress = speech.progress(beat);
      if (progress.mode !== 'waiting') {
        current.elapsed += dt;
        const shown = current.shown = Math.max(current.shown,Math.floor(progress.mode === 'audio' ? progress.shown : current.elapsed * 20));
        while (current.fired < beat.anchors.length && beat.anchors[current.fired].at <= shown) {
          actions.enqueue(...beat.anchors[current.fired++].actions);
        }
        if (progress.mode === 'audio' ? progress.done : shown >= beat.text.length) {
          nextBeat(item, index + 1);
          return;
        }
      }
      if (current.fired !== fired || performance.now() >= nextProgress) publishProgress();
    },
    reset() { generation = null; stop('body-changed'); },
    dispose() {
      unsubscribe();
      stop('scene-closed');
      speech.dispose();
      actions.dispose();
      void context?.ctx.close().catch(() => {});
    },
  };
}
