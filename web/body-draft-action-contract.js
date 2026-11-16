import { bindingsValue } from './model-configuration-contract.js';

/** A temporary draft contribution, addressed to one mounted body. */
export function draftActionCommand(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !['play', 'stop'].includes(raw.kind)
    || typeof raw.owner !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(raw.owner)
    || Object.keys(raw).some(key => key !== 'kind' && key !== 'owner' && !(raw.kind === 'play' && (key === 'binding' || key === 'mode')))
    || (raw.mode !== undefined && raw.mode !== 'native' && raw.mode !== 'full')) {
    throw Error('Invalid draft action command');
  }
  return raw.kind === 'play'
    ? { kind: 'play', owner: raw.owner, binding: bindingsValue([raw.binding])[0], ...(raw.mode ? { mode: raw.mode } : {}) }
    : { kind: 'stop', owner: raw.owner };
}

export function draftActionReport(body) {
  return {
    supported: typeof body?.draftAction === 'function',
    ...(body?.draftActionState ?? { status: 'idle', requestId: null, owner: null }),
  };
}

export function applyDraftAction(body, raw, requestId, seq) {
  try {
    if (typeof body?.draftAction !== 'function') throw Error('The active body does not support native draft preview');
    body.draftAction(draftActionCommand(raw), requestId);
    return { t: 'body-draft-action', seq, ok: true, report: draftActionReport(body) };
  } catch (error) {
    return { t: 'body-draft-action', seq, ok: false, reason: String(error?.message ?? error) };
  }
}

/** Tracks requests separately from unsolicited playback progress. */
export function createDraftActionTransport(post, { timeoutMs = 2500 } = {}) {
  let state = { supported: false, status: 'idle', requestId: null, owner: null };
  let seq = 0, pending = null, disposed = false;
  function fail(error) {
    if (!pending) return;
    const { timer, reject } = pending;
    pending = null;
    clearTimeout(timer);
    reject(error);
  }
  return {
    snapshot: () => ({ ...state }),
    observe(report) {
      if (!disposed && !pending && report && ['idle', 'playing', 'finished', 'stopped'].includes(report.status)) {
        state = { supported: report.supported === true, status: report.status,
          requestId: typeof report.requestId === 'string' ? report.requestId : null,
          owner: typeof report.owner === 'string' ? report.owner : null };
      }
    },
    send(raw, requestId) {
      if (disposed || !state.supported) return Promise.reject(Error('The active body does not support native draft preview'));
      let command;
      try { command = draftActionCommand(raw); } catch (error) { return Promise.reject(error); }
      fail(Error('A newer draft preview superseded the request'));
      return new Promise((resolve, reject) => {
        const ticket = ++seq;
        pending = { ticket, command, requestId, resolve, reject,
          timer: setTimeout(() => fail(Error('Draft action acknowledgement timed out')), timeoutMs) };
        try { post({ t: 'body-draft-action', seq: ticket, command, requestId }); } catch (error) { fail(error); }
      });
    },
    receive(receipt) {
      if (!pending || receipt?.seq !== pending.ticket) return;
      if (receipt.ok !== true) {
        fail(Error(String(receipt.reason || 'Draft action preview failed').slice(0, 400)));
        return;
      }
      const { report } = receipt;
      const { command, requestId, timer, resolve } = pending;
      const expected = command.kind === 'play' ? 'playing' : 'stopped';
      if (report?.supported !== true || report.requestId !== requestId || report.owner !== command.owner || report.status !== expected) return;
      clearTimeout(timer);
      pending = null;
      state = { supported: true, status: expected, requestId, owner: command.owner };
      resolve({ ...state });
    },
    clear(owner) {
      if (owner && (pending?.command.owner ?? state.owner) !== owner) return false;
      fail(Error('Draft action preview was released'));
      state = { supported: state.supported, status: 'idle', requestId: null, owner: null };
      return true;
    },
    dispose() {
      disposed = true;
      fail(Error('The body changed before acknowledging draft preview'));
    },
  };
}
