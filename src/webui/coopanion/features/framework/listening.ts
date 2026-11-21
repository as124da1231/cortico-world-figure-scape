import type { PageContext } from '../../base/page.ts';
import { invokePanel } from '../../base/api.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';

const P = 'world:desktop-live2d-pet';
type Mode = 'hold' | 'toggle' | 'always';
const FLOOR = -80, CEILING = 0;
const clampDb = (db: number) => Math.min(CEILING, Math.max(FLOOR, db));
const positionDb = (db: number) => (clampDb(db) - FLOOR) / (CEILING - FLOOR) * 100;
const isTesting = (phase?: string) => phase === 'opening' || phase === 'recording' || phase === 'decoding';
const instructions: Record<Mode, [string, string]> = {
  hold: ['按住桌宠麦克风说话，松开发送。', 'Hold the pet microphone to talk. Release it to send.'],
  toggle: ['点一下桌宠麦克风开始录音，再点一次结束并发送。', 'Click the pet microphone to start recording. Click again to stop and send.'],
  always: ['说话超过门槛时开始录音，停顿后发送。点桌宠上的麦克风可暂停或恢复。', 'Speech above the threshold starts recording and sends after a pause. Click the pet microphone to pause or resume.'],
};
type Voice = {
  enabled: boolean; engine: string; engineSetting: string; systemSupported: boolean; windowVisible: boolean;
  server: { phase: string; detail: string | null } | null;
  model: { phase: string; done: number; total: number | null; detail: string | null; reused: boolean };
  api: { model: string };
  mic: { state: string; detail: string | null };
  input: { mode: Mode; hint: string; openOnPress: boolean; deviceId: string; devices: Array<{ id: string; label: string }> };
  test: { phase: string; text?: string };
  level: number; thresholdDb: number;
  recent: Array<{ text: string; dropped?: boolean }>;
};

const modes: Array<[Mode, string, string]> = [
  ['hold', '按住说话', 'Hold to talk'],
  ['toggle', '点按录音', 'Click to record'],
  ['always', '自动检测', 'Detect speech'],
];

export function listening(ctx: PageContext, showPet: () => void, windowFeedback?: HTMLElement) {
  const c = studioControls(ctx);
  const on = { signal: ctx.signal };
  const element = c.node('div', '', 'studio-voice-input');
  let state: Voice | undefined, reading = false, busy = false, mutation = 0;
  let startingTest = false, cancelAfterStart = false;
  let deviceKey = '', recentKey = '';

  function choice(values: Array<[string, string]>, label: string) {
    const select = c.node('select');
    select.setAttribute('aria-label', label);
    for (const [value, name] of values) {
      const option = c.node('option', name);
      option.value = value;
      select.append(option);
    }
    return select;
  }

  const enabled = c.node('input');
  enabled.type = 'checkbox';
  enabled.setAttribute('role', 'switch');
  enabled.setAttribute('aria-label', t('启用语音输入', 'Enable voice input'));
  const summary = c.node('span', t('正在读取…', 'Reading…'), 'studio-voice-summary');

  const setup = c.node('div', '', 'studio-voice-setup');
  const mode = c.node('div', '', 'studio-voice-modes');
  mode.setAttribute('role', 'group');
  mode.setAttribute('aria-label', t('说话方式', 'Speaking mode'));
  const modeButtons = modes.map(([value, cn, en]) => {
    const button = c.button(t(cn, en), () => void call('setMic', [{ mode: value }]));
    button.dataset.mode = value;
    button.setAttribute('aria-pressed', String(value === 'hold'));
    mode.append(button);
    return button;
  });
  const modeHint = c.node('p', '', 'studio-voice-copy');
  const device = choice([], t('麦克风', 'Microphone'));
  const engine = choice([['', t('自动选择', 'Automatic')], ['funasr', 'FunASR · SenseVoice'], ['whisper', 'Whisper'],
    ['system', t('Windows 系统识别', 'Windows speech recognition')], ['api', t('在线转写', 'Online transcription')]], t('识别引擎', 'Recognition engine'));
  const engineDescription = c.node('p', '', 'studio-voice-copy');
  const download = c.button(t('下载识别模型', 'Download model'), () => void call('install'), true);
  const start = c.button(t('启动识别', 'Start recognition'), () => void call('start'));
  const service = c.link(t('配置转写服务', 'Configure transcription service'), 'services');
  const progress = c.node('progress');
  progress.setAttribute('aria-label', t('模型下载进度', 'Model download progress'));
  const engineActions = c.node('div', '', 'studio-inline studio-recognition-actions');
  engineActions.append(download, start, service);
  const engineNotice = c.node('div', '', 'studio-voice-engine');
  engineNotice.append(engineDescription, progress, engineActions);
  const warm = c.node('input');
  warm.type = 'checkbox';
  warm.setAttribute('role', 'switch');
  const warmRow = c.field(t('提前打开麦克风', 'Keep microphone ready'), warm,
    t('用于按住说话，减少开口前的等待。', 'Reduces microphone startup time in hold-to-talk mode.'));
  const devices = c.node('div', '', 'studio-voice-devices');
  devices.append(c.field(t('麦克风', 'Microphone'), device), c.field(t('识别引擎', 'Recognition engine'), engine));
  setup.append(devices, engineNotice);
  const modeBar = c.node('div', '', 'studio-voice-mode-bar');
  modeBar.append(mode, modeHint);

  const test = c.node('section', '', 'studio-voice-test');
  const testHead = c.node('div', '', 'studio-voice-test-head');
  const status = c.node('span', t('正在读取…', 'Reading…'), 'studio-mic-state');
  testHead.append(c.node('h3', t('麦克风试录', 'Mic test')), status);
  const testNote = c.node('p', t('最多录 8 秒。试录转写仅在此显示。', 'Record up to 8 seconds. Test transcripts appear here only.'), 'studio-voice-copy');
  const meter = c.node('meter');
  meter.min = FLOOR;
  meter.max = CEILING;
  meter.value = FLOOR;
  meter.setAttribute('aria-label', t('麦克风电平', 'Microphone level'));
  const db = c.node('span', '—', 'studio-voice-db');
  const meterTrack = c.node('span', '', 'studio-mic-meter-track');
  meterTrack.dir = 'ltr';
  const thresholdMark = c.node('span', '', 'studio-mic-threshold-mark');
  thresholdMark.setAttribute('role', 'slider');
  thresholdMark.setAttribute('aria-label', t('检测门槛', 'Speech threshold'));
  thresholdMark.setAttribute('aria-valuemin', String(FLOOR));
  thresholdMark.setAttribute('aria-valuemax', String(CEILING));
  thresholdMark.hidden = true;
  meterTrack.append(meter, thresholdMark);
  const monitoring = c.node('div', '', 'studio-mic-monitor');
  const levelLabel = c.node('span', t('实时电平', 'Level'));
  const levelHeading = c.node('div', '', 'studio-mic-labels');
  levelHeading.append(levelLabel, db);
  const thresholdLabel = c.node('span', '', 'studio-mic-threshold-label');
  const thresholdHint = c.node('p', '', 'studio-mic-threshold-hint');
  thresholdLabel.hidden = true;
  levelHeading.append(thresholdLabel);
  monitoring.append(levelHeading, meterTrack, thresholdHint);
  let drag: { id: number; db: number } | null = null;
  let markerDb = FLOOR;
  function placeThreshold(value: number) {
    markerDb = clampDb(Math.round(value));
    thresholdMark.style.left = positionDb(markerDb) + '%';
    thresholdMark.setAttribute('aria-valuenow', String(markerDb));
    thresholdMark.setAttribute('aria-valuetext', markerDb + ' dBFS');
    thresholdLabel.textContent = t('门槛 ', 'Threshold ') + markerDb + ' dBFS';
  }
  function dbAt(clientX: number) {
    const {left, width} = meterTrack.getBoundingClientRect();
    return width > 0 ? clampDb(Math.round(FLOOR + (clientX - left) / width * (CEILING - FLOOR))) : markerDb;
  }
  function thresholdEditable() {
    return state?.input.mode === 'always' && state.test.phase !== 'decoding' && !busy;
  }
  function restoreThreshold() {
    drag = null;
    if (state) placeThreshold(state.thresholdDb);
  }
  meterTrack.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !thresholdEditable() || drag) return;
    event.preventDefault();
    thresholdMark.focus({ preventScroll: true });
    meterTrack.setPointerCapture?.(event.pointerId);
    drag = { id: event.pointerId, db: dbAt(event.clientX) };
    placeThreshold(drag.db);
  }, on);
  meterTrack.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    drag.db = dbAt(event.clientX);
    placeThreshold(drag.db);
  }, on);
  meterTrack.addEventListener('pointerup', event => {
    if (drag?.id !== event.pointerId) return;
    const value = dbAt(event.clientX);
    drag = null;
    if (thresholdEditable()) void call('setThreshold', [value]);
    else restoreThreshold();
  }, on);
  for (const type of ['pointercancel', 'lostpointercapture']) {
    meterTrack.addEventListener(type, event => {
      if (drag?.id === (event as PointerEvent).pointerId) restoreThreshold();
    }, on);
  }
  thresholdMark.addEventListener('keydown', event => {
    if (!thresholdEditable() || drag) return;
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
    const move = moves[event.key];
    if (move === undefined && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const value = event.key === 'Home' ? FLOOR : event.key === 'End' ? CEILING : clampDb(markerDb + move);
    placeThreshold(value);
    void call('setThreshold', [value]);
  }, on);
  const result = c.status('studio-voice-test-result');
  const transcript = c.node('div', '', 'studio-voice-test-transcript');
  transcript.append(c.node('span', t('试录结果', 'Test result')), result);
  if (windowFeedback) transcript.append(windowFeedback);
  const actions = c.node('div', '', 'studio-inline studio-voice-test-actions');
  const tryMic = c.button(t('开始试录', 'Start test'), () => {
    if (state && !state.windowVisible) { showPet(); return; }
    void call(state?.test.phase === 'recording' ? 'testFinish' : 'testStart');
  }, true);
  const cancel = c.button(t('取消', 'Cancel'), () => {
    if (startingTest) cancelTest();
    else void call('testCancel');
  });
  actions.append(tryMic, cancel);
  const testFooter = c.node('div', '', 'studio-voice-test-footer');
  testFooter.append(transcript, actions);
  test.append(testHead, testNote, monitoring, testFooter);
  const recent = c.node('div', '', 'studio-transcripts');
  const emptyHistory = c.node('div', '', 'studio-empty-transcripts');
  emptyHistory.append(c.node('strong', t('还没有语音记录', 'No voice transcripts yet')),
    c.node('p', t('用桌宠麦克风说话后，可以在这里查看转写。', 'Transcripts from the pet microphone will appear here.')));
  recent.append(emptyHistory);
  element.append(modeBar, test, setup);
  const settings = [device, engine, download, start, ...modeButtons];
  let failure = '';

  function lock() {
    const phase = state?.test.phase;
    const testing = isTesting(phase);
    enabled.disabled = busy || !state || testing;
    const editable = thresholdEditable();
    thresholdMark.tabIndex = editable ? 0 : -1;
    thresholdMark.setAttribute('aria-disabled', String(!editable));
    meterTrack.dataset.adjustable = String(editable);
    for (const control of settings) control.disabled = busy || !state || testing;
    warm.disabled = busy || state?.input.mode !== 'hold' || testing;
    tryMic.disabled = busy || !state || phase === 'opening' || phase === 'decoding';
    cancel.disabled = busy && (!startingTest || cancelAfterStart);
  }
  lock();
  cancel.hidden = download.hidden = start.hidden = service.hidden = progress.hidden = true;

  async function call(method: string, args: unknown[] = []) {
    if (busy || ctx.signal.aborted) return;
    busy = true;
    startingTest = method === 'testStart';
    mutation++;
    failure = '';
    if (startingTest && state) render({ ...state, test: { phase: 'opening' } });
    else lock();
    try {
      // Keep the start receipt alive long enough to cancel in order if the user leaves the page.
      const options = startingTest ? { keepalive: true, signal: AbortSignal.timeout(10_000) } : on;
      const next = await invokePanel<Voice>(P, 'voice', method, args, options);
      if (ctx.signal.aborted || cancelAfterStart) return;
      mutation++;
      state = next;
      render(next);
    } catch (error) {
      if (!ctx.signal.aborted && !cancelAfterStart) {
        failure = errorText(error);
        if (state) render(state);
      }
    } finally {
      if (cancelAfterStart) {
        try {
          const next = await requestTestCancel();
          if (!ctx.signal.aborted) {
            state = next;
            render(next);
          }
        } catch (error) {
          if (!ctx.signal.aborted) {
            failure = errorText(error);
            if (state) render(state);
          }
        }
      }
      startingTest = cancelAfterStart = busy = false;
      lock();
    }
  }

  function render(next: Voice) {
    test.dataset.windowVisible = String(next.windowVisible);
    enabled.checked = next.enabled;
    modeHint.textContent = t(...(instructions[next.input.mode] ?? instructions.hold));
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === next.input.mode));
    warm.checked = !next.input.openOnPress;
    const automatic = next.input.mode === 'always';
    thresholdMark.hidden = thresholdLabel.hidden = !automatic;
    thresholdHint.textContent = automatic
      ? t('拖动门槛线，试录时让说话的电平越过它。', 'Drag the threshold line. During the test, speak above it.')
      : t('试录时说一句话，观察麦克风电平。', 'Say a sentence during the test to see the microphone level.');
    if (!automatic) drag = null;
    if (!drag) placeThreshold(next.thresholdDb);

    const devicesKey = JSON.stringify([next.input.deviceId, next.input.devices]);
    if (deviceKey !== devicesKey) {
      deviceKey = devicesKey;
      const devices: Array<[string, string]> = [['', t('系统默认', 'System default')], ...next.input.devices.filter(slot => slot.id)
        .map((slot, index): [string, string] => [slot.id, slot.label || t('麦克风 ', 'Microphone ') + (index + 1)])];
      if (next.input.deviceId && !devices.some(([id]) => id === next.input.deviceId)) {
        devices.push([next.input.deviceId, t('已选麦克风（尚未检测到）', 'Selected microphone (not detected)')]);
      }
      device.replaceChildren(...choice(devices, '').options);
    }
    if (device.ownerDocument.activeElement !== device || busy) device.value = next.input.deviceId;
    if (engine.ownerDocument.activeElement !== engine || busy) engine.value = next.engineSetting;
    engine.querySelector<HTMLOptionElement>('[value=system]')!.hidden = !next.systemSupported;
    const local = next.engine === 'funasr' || next.engine === 'whisper';
    const resolved = engine.value === '' ? [...engine.options].find(option => option.value === next.engine)?.textContent : '';
    const modelStatus: Record<string, string> = {
      absent: t('需要下载模型', 'Model download required'),
      working: t('正在下载模型…', 'Downloading model…'),
      ready: next.model.reused ? t('已复用 Coo 的本地模型', 'Using the model installed by Coo') : t('本地模型已就绪', 'Local model ready'),
      error: next.model.detail || t('模型下载失败', 'Model download failed'),
    };
    const backend = next.server?.phase;
    const backendStatus = backend === 'running' ? t('识别就绪', 'Ready to transcribe')
      : backend === 'starting' ? t('正在启动识别…', 'Starting recognition…')
      : backend === 'error' && (!local || next.model.phase === 'ready') ? next.server?.detail || t('识别启动失败', 'Recognition failed to start') : '';
    const apiStatus = next.engine === 'api' ? next.api.model || t('请选择转写模型', 'Select a transcription model') : '';
    engineDescription.textContent = [resolved, local && modelStatus[next.model.phase], apiStatus, backendStatus].filter(Boolean).join(' · ');
    download.hidden = !local || ['ready', 'working'].includes(next.model.phase);
    download.textContent = next.model.phase === 'error' ? t('重试下载', 'Retry download') : t('下载识别模型', 'Download model');
    start.hidden = !next.windowVisible || !next.enabled || (local && next.model.phase !== 'ready')
      || (next.engine === 'api' && !next.api.model) || backend === 'running' || backend === 'starting';
    service.hidden = next.engine !== 'api';
    progress.hidden = !local || next.model.phase !== 'working';
    if (next.model.total) { progress.max = next.model.total; progress.value = next.model.done; }
    else progress.removeAttribute('value');

    const phase = next.test.phase;
    const testing = isTesting(phase);
    const connected = (next.enabled || testing) && next.windowVisible && next.mic.state === 'on';
    const micLabels: Record<string, string> = {
      on: t('麦克风已接通', 'Connected'), off: t('麦克风待命', 'Standby'),
      opening: t('正在连接', 'Connecting'), denied: t('权限未开启', 'Permission denied'), error: t('设备不可用', 'Microphone unavailable'),
    };
    status.dataset.live = String(connected);
    status.textContent = !next.windowVisible ? t('桌宠未显示', 'Pet hidden')
      : !next.enabled && !testing ? t('待试录', 'Ready to test') : micLabels[next.mic.state] ?? '';
    const autoLive = automatic && connected && backend === 'running' && !testing;
    summary.dataset.state = testing || autoLive ? 'live' : next.enabled ? 'ready' : 'off';
    summary.textContent = testing ? t('试录中', 'Testing')
      : !next.enabled ? (automatic ? t('已暂停', 'Paused') : t('已关闭', 'Off'))
      : autoLive ? t('自动监听中', 'Listening') : automatic ? t('等待麦克风', 'Waiting')
      : t('已启用', 'Enabled');
    const currentDb = connected ? clampDb(next.level) : FLOOR;
    meter.value = currentDb;
    meterTrack.dataset.live = String(connected);
    meterTrack.dataset.above = String(automatic && connected && currentDb >= next.thresholdDb);
    db.textContent = connected ? Math.round(currentDb) + ' dBFS' : '—';
    const tip = !next.windowVisible ? t('显示桌宠后即可试录。', 'Show the pet to test the microphone.')
      : local && next.model.phase !== 'ready' ? t('可以先测收音。识别模型就绪后会显示转写。', 'You can test the microphone now. Transcripts require a ready recognition model.')
      : next.engine === 'api' ? t('试录音频由所选转写服务处理。', 'Your selected transcription service processes test audio.')
      : t('开始试录后说一句话，转写会显示在这里。', 'Start the test and say a sentence to see the transcript here.');
    const testingCopy: Record<string, string> = {
      opening: t('正在等待麦克风音频。接通后开始计时。', 'Waiting for microphone audio. The timer starts when audio arrives.'),
      recording: t('正在试录，可以说话。最长 8 秒。', 'Recording. Speak now, up to 8 seconds.'),
      decoding: t('正在转写试录音频…', 'Transcribing the test recording…'),
    };
    const resultCopy = failure || next.test.text || testingCopy[phase] || (['denied', 'error'].includes(next.mic.state) ? next.mic.detail : '') || tip;
    if (result.textContent !== resultCopy) result.textContent = resultCopy;
    result.dataset.phase = failure ? 'error' : phase;
    tryMic.textContent = !next.windowVisible ? t('显示桌宠', 'Show pet')
      : phase === 'opening' ? t('正在连接…', 'Connecting…') : phase === 'recording' ? t('结束试录', 'Finish test')
      : phase === 'done' || phase === 'error' ? t('再试一次', 'Test again') : t('开始试录', 'Start test');
    cancel.hidden = !isTesting(phase);

    const historyKey = JSON.stringify(next.recent);
    if (recentKey !== historyKey) {
      recentKey = historyKey;
      recent.replaceChildren(...next.recent.slice(-8).reverse().map(item => c.node('p', item.text + (item.dropped ? t(' · 未投递', ' · Not delivered') : ''))));
      if (!next.recent.length) recent.append(emptyHistory);
    }
    lock();
  }

  async function refresh() {
    if (reading || busy || ctx.signal.aborted) return;
    reading = true;
    const issued = mutation;
    try {
      const next = await invokePanel<Voice>(P, 'voice', 'state', [], on);
      if (!ctx.signal.aborted && issued === mutation && next?.input && next.test) {
        state = next;
        render(next);
      }
    } catch (error) {
      if (!ctx.signal.aborted && !state) {
        result.textContent = errorText(error);
        result.dataset.phase = 'error';
      }
    } finally { reading = false; }
  }

  enabled.addEventListener('change', () => void call('setEnabled', [enabled.checked]), on);
  device.addEventListener('change', () => void call('setMic', [{ deviceId: device.value }]), on);
  engine.addEventListener('change', () => void call('setEngine', [engine.value]), on);
  warm.addEventListener('change', () => void call('setMic', [{ openOnPress: !warm.checked }]), on);
  ctx.lifecycle.interval(() => { if (state?.enabled || isTesting(state?.test.phase)) void refresh(); }, 250);
  function requestTestCancel() {
    return invokePanel<Voice>(P, 'voice', 'testCancel', [], { keepalive: true, signal: AbortSignal.timeout(5000) });
  }
  function cancelTest() {
    if (startingTest) { cancelAfterStart = true; lock(); return; }
    if (isTesting(state?.test.phase)) void requestTestCancel().catch(() => {});
  }
  ctx.signal.addEventListener('abort', cancelTest, { once: true });
  return { element, refresh, enabled, recent, summary, advanced: warmRow, cancelTest };
}
