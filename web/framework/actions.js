/** Discrete execution, not a per-parameter writer. Existing body remains motion executor. */
export function createBodyActions({ body, scene, receipt, onWordReceipt }) {
  let queue = [], active = null, now = 0, sequence = 0, epoch = 0, disposed = false;
  let vocabulary = new Map(), bound = false;
  const walks = new Map(), history = [];
  let receiptError = null;
  function deliver(value) { try { receipt(value); } catch (error) { receiptError = String(error); } }
  function record(action, status, detail = {}) {
    const row = { ...action, status, ...detail }; history.push(row); if (history.length > 32) history.shift();
    if (row.kind === 'word' && row.requestId && onWordReceipt) {
      try { onWordReceipt(row); } catch (error) { receiptError = String(error); }
    }
    return row;
  }
  function finishWord(status, detail) {
    if (!active) return;
    const { action } = active;
    active = null;
    record(action, status, detail);
  }
  function startWord(action, target) {
    const dispatch = active = { action, until: null, done: false };
    function accepted(ok) {
      if (active !== dispatch) return;
      if (ok === false) { finishWord('failed', { reason: 'body-declined' }); return; }
      // A sandboxed body reports the rendered frame asynchronously.
      const frameGrace = action.requestId && target.dispatchWord ? 0.12 : 0;
      dispatch.until = now + (vocabulary.get(action.word)?.seconds ?? 1) + frameGrace;
      target.set({ hold: 15 });
      record(action, 'running');
      if (dispatch.done) finishWord('completed', { completion: 'body-event' });
    }
    function failed(error) {
      if (active === dispatch) finishWord('failed', { reason: String(error?.message ?? error) });
    }
    try {
      if (action.requestId && target.dispatchWord) void target.dispatchWord(action.word, action.id).then(accepted, failed).catch(failed);
      else accepted(target.do(action.word));
    } catch (error) { failed(error); }
  }
  function interrupt(reason) {
    epoch++;
    finishWord('interrupted', { reason });
    for (const a of queue) record(a, 'interrupted', { reason });
    queue = [];
    interruptWalks(reason);
  }
  function interruptWalks(reason) {
    for (const [id, a] of walks) {
      walks.delete(id);
      body.body?.stopWalk(id);
      record(a, 'interrupted', { reason });
      if (a.sceneOrder) deliver({ t: 'scene-result', id, status: 'cancelled', reason });
      deliver({ t: 'interrupted', walkId: id, ...scene.normalize(body.body?.layout ?? { x: 0 }), by: reason });
    }
    walks.clear();
  }
  return {
    enqueue(...words) { this.enqueueRequest(null, ...words); },
    enqueueRequest(requestId, ...words) {
      if (disposed) return;
      for (const word of words) { const a = { id: ++sequence, requestId, kind: 'word', word, epoch }; record(a, 'accepted'); queue.push(a); }
    },
    rejectRequest(requestId, words, reason) {
      if (disposed) return;
      for (const word of words ?? []) record({id:++sequence,requestId,kind:'word',word,epoch},'failed',{reason});
    },
    tick(dt) {
      if (disposed) return; now += dt;
      if (active?.until != null && now >= active.until) finishWord('completed', { completion: 'duration' });
      if (active || !queue.length || !body.body?.layout || body.body.layout.busy) return;
      const a = queue.shift();
      if (!vocabulary.has(a.word)) { record(a, 'failed', { reason: 'unsupported-word' }); return; }
      startWord(a, body.body);
    },
    walk(command, cursor) {
      if (disposed) return;
      const a = { id: command.id, kind: command.t, epoch, sceneOrder: command.sceneOrder === true }; record(a, 'accepted');
      if (!body.body) {
        record(a, 'failed', { reason: 'no-body' });
        if (a.sceneOrder) deliver({ t: 'scene-result', id: a.id, status: 'failed', reason: 'no-body' });
        else deliver({ t: 'interrupted', walkId: command.id, x: .5, by: 'none' });
        return;
      }
      walks.set(command.id, a);
      try {
        body.body.set({ hold: 20 });
        if (command.t === 'move') body.body.move(command.move, command.id);
        else body.body.walk(scene.target(command.to, cursor), !!command.run, command.id);
        record(a, 'running');
      } catch (error) {
        walks.delete(command.id);
        record(a, 'failed', { reason: String(error) });
        if (a.sceneOrder) deliver({ t: 'scene-result', id: a.id, status: 'failed', reason: String(error) });
        else deliver({ t: 'interrupted', walkId: command.id, ...scene.normalize(body.body.layout ?? { x: 0 }), by: 'failed' });
      }
    },
    local(command) {
      if (disposed || !body.body) return;
      const a = { id: ++sequence, kind: command.kind, source: 'local', epoch };
      record(a, 'accepted');
      try {
        if (command.kind === 'word') body.body.do(command.word);
        else if (command.kind === 'walk') body.body.walk(command.x, !!command.run, 0);
        else throw new TypeError('Unsupported local action');
        record(a, 'running');
      } catch (error) { record(a, 'failed', { reason: String(error) }); }
    },
    stopWalk(id) { body.body?.stopWalk(id); },
    event(kind, detail) {
      if (disposed) return;
      if (kind === 'done' && active?.action.word === detail.word) {
        if (active.until === null) active.done = true;
        else finishWord('completed', { completion: 'body-event' });
      }
      if (kind !== 'arrived' && kind !== 'interrupted') return;
      const a = walks.get(detail.walkId); if (!a || a.epoch !== epoch) return;
      walks.delete(detail.walkId); record(a, kind === 'arrived' ? 'completed' : 'interrupted');
      const layout = body.body?.layout;
      if (a.sceneOrder) deliver({ t: 'scene-result', id: a.id, status: kind === 'arrived' ? 'completed' : 'cancelled', reason: detail.by });
      deliver({ t: kind, walkId: detail.walkId, ...scene.normalize({ x: typeof detail.x === 'number' ? detail.x : layout?.x ?? 0, y: typeof detail.y === 'number' ? detail.y : layout?.y }), by: detail.by });
    },
    bodyCommitted(pack) { if (bound) interrupt('body-replaced'); bound = true; vocabulary = new Map((pack?.vocab ?? []).map(w => [w.id, w])); },
    configurationApplied(vocab,bindingsChanged) {
      if(bindingsChanged){
        for(const action of queue)record(action,'interrupted',{reason:'bindings-changed'});
        queue=[];
      }
      // The running word keeps its original completion deadline; ongoing walks
      // retain their owner and receipt. Only future dispatch uses this vocabulary.
      vocabulary=new Map(vocab.map(word=>[word.id,word]));
    },
    interrupt, interruptWalks,
    snapshot: () => ({ implementation: 'body-vocabulary', status: disposed ? 'disposed' : 'mounted', queued: queue.length, active: active && { ...active.action, until: active.until }, pendingWalks: walks.size, epoch, receiptError, recent: history.map(a => ({ ...a })) }),
    dispose() { if (!disposed) { interrupt('disposed'); disposed = true; } },
  };
}
