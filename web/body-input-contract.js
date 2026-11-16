/** Physical held-input transport. Reports contain counts only, never key values. */
export function heldInputSnapshot(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !['keys', 'primary', 'secondary'].includes(key))
    || !Array.isArray(raw.keys) || raw.keys.length > 32
    || raw.keys.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key))
    || typeof raw.primary !== 'boolean' || typeof raw.secondary !== 'boolean') throw new TypeError('Invalid held-input snapshot');
  return { keys: [...new Set(raw.keys)], primary: raw.primary, secondary: raw.secondary };
}
export function heldInputSummary(snapshot) {
  return { keyCount: snapshot?.keys.length ?? 0, primary: snapshot?.primary ?? false, secondary: snapshot?.secondary ?? false };
}
function readState(state) {
  return Number.isSafeInteger(state?.keyCount) && state.keyCount >= 0 && state.keyCount <= 32
    && typeof state.primary === 'boolean' && typeof state.secondary === 'boolean'
    ? { keyCount: state.keyCount, primary: state.primary, secondary: state.secondary } : {};
}
export function readInputReport(report) {
  return { supported: { held: report?.supported?.held === true }, state: readState(report?.state) };
}
export function bodyInputReport(body) {
  return readInputReport({ supported: { held: typeof body?.input === 'function' && body?.capabilities?.input?.held === true }, state: body?.inputState });
}
export function inputOutcome(requested, report) {
  const clean = readInputReport(report);
  return { ...clean, status: !clean.supported.held ? 'unsupported'
    : clean.state.keyCount === undefined ? 'dispatched'
    : ['keyCount', 'primary', 'secondary'].every(key => clean.state[key] === requested[key]) ? 'applied' : 'mismatch' };
}
export function applyBodyInput(body, raw, seq) {
  const snapshot = heldInputSnapshot(raw), requested = heldInputSummary(snapshot);
  let failed = false;
  if (bodyInputReport(body).supported.held) {
    try { body.input(snapshot); } catch { failed = true; }
  }
  return { t: 'body-input', seq, requested, ...inputOutcome(requested, bodyInputReport(body)),
    ...(failed ? { status: 'failed', error: 'Body held-input failed' } : {}) };
}
export function createInputReceiptState(post, { timeoutMs = 2000 } = {}) {
  let seq = 0, timer = null, disposed = false;
  let state = { ...readInputReport(null), status: 'unknown', seq: 0, requested: null };
  const snapshot = () => structuredClone(state);
  return {
    snapshot,
    ready(report) { if (!disposed) state = { ...readInputReport(report), status: 'reported', seq, requested: null }; },
    send(raw) {
      const input = heldInputSnapshot(raw), requested = heldInputSummary(input);
      clearTimeout(timer);
      state = { ...readInputReport(state), requested, seq: ++seq, status: disposed ? 'disposed' : state.supported.held ? 'pending' : 'unsupported' };
      if (state.status === 'pending') {
        timer = setTimeout(() => { state = { ...state, status: 'timeout' }; }, timeoutMs);
        post({ t: 'body-input', input, seq });
      }
      return snapshot();
    },
    receive(receipt) {
      if (disposed || !seq || receipt?.seq !== seq || state.status !== 'pending'
        || !['keyCount', 'primary', 'secondary'].every(key => receipt.requested?.[key] === state.requested?.[key])) return;
      clearTimeout(timer);
      state = { ...state, ...inputOutcome(state.requested, receipt),
        ...(receipt.status === 'failed' ? { status: 'failed', error: 'Body held-input failed' } : {}) };
    },
    dispose() { disposed = true; clearTimeout(timer); state = { ...state, status: 'disposed' }; },
  };
}
