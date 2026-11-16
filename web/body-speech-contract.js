/** Body-owned speech contribution, never the final expression/native mouth parameter. */
export function readSpeechReport(report) {
  const pulse = report?.state?.pulse;
  return { supported: { pulse: report?.supported?.pulse === true, release: report?.supported?.release === true,
    ...(report?.supported?.level === true ? { level: true } : {}) },
    state: Number.isFinite(pulse) && pulse >= 0 && pulse <= 1 ? { pulse } : {} };
}
export function bodySpeechReport(body) {
  const explicit = typeof body?.speech === 'function';
  return readSpeechReport({ supported: {
    pulse: (explicit && body?.capabilities?.speech?.pulse === true) || typeof body?.talk === 'function',
    release: explicit && body?.capabilities?.speech?.release === true,
    level: typeof body?.speechLevel === 'function',
  }, state: body?.speechState });
}
export function speechCommand(command) {
  if (!command || !['pulse', 'release'].includes(command.kind) || Object.keys(command).some(key => key !== 'kind')) throw new TypeError('Invalid body speech command');
  return { kind: command.kind };
}
export function speechOutcome(command, report) {
  const clean = readSpeechReport(report);
  const value = clean.state.pulse;
  return { ...clean, status: !clean.supported[command.kind] ? 'unsupported'
    : value === undefined ? 'dispatched'
    : value === (command.kind === 'release' ? 0 : 1) ? 'applied' : 'mismatch' };
}
export function applyBodySpeech(body, raw, seq) {
  const command = speechCommand(raw), before = bodySpeechReport(body);
  let error = null;
  if (before.supported[command.kind]) {
    try {
      if (typeof body?.speech === 'function' && body.capabilities?.speech?.[command.kind] === true) body.speech(command);
      else if (command.kind === 'pulse') body.talk();
    } catch (caught) { error = String(caught); }
  }
  const outcome = speechOutcome(command, bodySpeechReport(body));
  return { t: 'body-speech', seq, command, ...outcome, ...(error ? { status: 'failed', error } : {}) };
}

/** Correlates the latest command only; previous frame/body receipts cannot acknowledge it. */
export function createSpeechReceiptState(post, { timeoutMs = 2000 } = {}) {
  let seq = 0, timer = null, disposed = false;
  let state = { ...readSpeechReport(null), status: 'unknown', seq: 0, command: null };
  const snapshot = () => structuredClone(state);
  return {
    snapshot,
    ready(report) { if (!disposed) state = { ...readSpeechReport(report), status: 'reported', seq, command: null }; },
    send(raw, mapping) {
      const command = speechCommand(raw);
      clearTimeout(timer);
      state = { ...readSpeechReport(state), seq: ++seq, command, status: disposed ? 'disposed' : state.supported[command.kind] ? 'pending' : 'unsupported' };
      if (state.status === 'pending') {
        timer = setTimeout(() => { state = { ...state, status: 'timeout' }; }, timeoutMs);
        post({ t: 'body-speech', command, seq, ...(mapping === undefined ? {} : { mapping }) });
      }
      return snapshot();
    },
    receive(receipt) {
      if (disposed || !seq || receipt?.seq !== seq || receipt.command?.kind !== state.command?.kind || state.status !== 'pending') return;
      clearTimeout(timer);
      const outcome = speechOutcome(state.command, receipt);
      state = { ...state, ...outcome, ...(receipt.status === 'failed' ? { status: 'failed', error: String(receipt.error ?? 'Body speech failed') } : {}) };
    },
    dispose() { disposed = true; clearTimeout(timer); state = { ...state, status: 'disposed' }; },
  };
}
