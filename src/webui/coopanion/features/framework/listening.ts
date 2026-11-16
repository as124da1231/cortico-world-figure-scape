import type { PageContext } from '../../base/page.ts';
import { invokePanel } from '../../base/api.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';

const P = 'world:desktop-live2d-pet';
type Voice = {
  enabled: boolean; engine: string; engineSetting?: string; systemSupported: boolean;
  server: { phase: string; detail: string | null } | null;
  model: { phase: string; done: number; total: number | null; detail: string | null };
  api: { model: string };
  mic: { state: string; detail: string | null };
  input: {
    deviceId: string; devices: Array<{ id: string; label: string }>;
  };
  level: number; recent: Array<{ text: string; dropped?: boolean }>;
};

export function listening(ctx: PageContext, advanced: HTMLElement, openRecent: () => void, notify: (value: string, kind?: 'pending' | 'success') => void, inlineDevice=false) {
  const c = studioControls(ctx);
  const element = c.node('div', '', 'studio-sound-panel');
  const summary = c.status('studio-settings-summary');
  let state: Voice | undefined, reading = false, busy = false, mutation = 0;
  let deviceKey = '', recentKey = '';

  function choice(values: Array<[string, string]>, label?: string) {
    const list = c.node('select');
    if (label) list.setAttribute('aria-label', label);
    for (const [value, name] of values) {
      const option = c.node('option', name);
      option.value = value;
      list.append(option);
    }
    return list;
  }

  const enabled = c.node('input');
  enabled.type = 'checkbox';
  enabled.setAttribute('role', 'switch');
  const feedback = c.status('studio-sound-message');
  const status = c.node('span', t('正在读取…', 'Reading…'), 'studio-mic-state');
  const meter = c.node('meter');
  meter.min = -60;
  meter.max = 0;
  meter.value = -60;
  meter.setAttribute('aria-label', t('麦克风电平', 'Microphone level'));
  const monitoring = c.node('div', '', 'studio-mic-monitor');
  monitoring.append(status, meter);
  const top = c.node('div', '', 'studio-sound-subsection');
  top.append(monitoring);
  enabled.setAttribute('aria-label', t('启用语音输入', 'Enable voice input'));

  const device = choice([],t('麦克风', 'Microphone'));
  const input = c.node('div', '', 'studio-sound-subsection');
  input.append(c.field(t('麦克风', 'Microphone'), device, t('在 Live2D 窗口按住麦克风按钮说话，松开发送。', 'Hold the microphone button in Live2D to speak. Release to send.')));

  const engine = choice([['', t('自动选择', 'Automatic')], ['funasr','FunASR'], ['whisper','Whisper'], ['system', t('系统识别', 'System recognition')], ['api', t('在线转写', 'Online transcription')]]);
  const engineDescription = c.node('small');
  const engineRow = c.field(t('识别引擎', 'Recognition engine'), engine);
  engineRow.firstElementChild!.append(engineDescription);
  const download = c.button(t('下载模型', 'Download model'), () => void call('install'));
  const start = c.button(t('启动识别', 'Start recognition'), () => void call('start'));
  const stop = c.button(t('停止识别', 'Stop recognition'), () => void call('stop'));
  const service = c.link(t('管理转写模型', 'Manage transcription model'), 'services');
  const progress = c.node('progress');
  progress.setAttribute('aria-label', t('模型下载进度', 'Model download progress'));
  const serviceActions = c.node('div', '', 'studio-inline studio-recognition-actions');
  serviceActions.append(progress, download, start, stop, service);

  const recent = c.node('div', '', 'studio-transcripts');
  const records = c.button(t('最近识别', 'Recent recognition'), openRecent);
  const utilities = c.node('div', '', 'studio-inline studio-sound-actions');
  utilities.append(records, advanced);
  const recognition = c.node('div', '', 'studio-sound-subsection');
  recognition.append(engineRow, serviceActions);
  const quick = c.node('div','','studio-mic-quick');
  if(inlineDevice){quick.append(input,top,feedback);element.append(recognition,utilities);}
  else element.append(top, input, recognition, utilities, feedback);

  const controls = [enabled, device, engine, download, start, stop];
  function lock() {
    for (const control of controls) control.disabled = busy || !state;
    if (!busy && state) download.disabled = state.model.phase === 'working';
  }
  for (const control of [download, start, stop, service, progress]) control.hidden = true;
  lock();

  async function call(method: string, args: unknown[] = []) {
    if (busy || ctx.signal.aborted) return;
    busy = true;
    mutation++;
    lock();
    if (method === 'setEnabled') notify(t('正在保存…', 'Saving…'), 'pending');
    feedback.textContent = method === 'install' ? t('正在下载识别模型…', 'Downloading recognition model…') : t('正在保存…', 'Saving…');
    try {
      const result = await invokePanel<Voice>(P, 'voice', method, args, { signal: ctx.signal });
      mutation++;
      if (ctx.signal.aborted) return;
      state = result;
      render(state);
      if (method === 'setEnabled') notify(t('已保存。', 'Saved.'), 'success');
      feedback.textContent = method === 'install' && state.model.phase === 'error'
        ? state.model.detail ?? t('下载失败，可重试。', 'Download failed. Try again.') : '';
    } catch (error) {
      if (!ctx.signal.aborted) {
        feedback.textContent = errorText(error);
        if (method === 'setEnabled') notify(errorText(error));
        if (state) render(state);
      }
    } finally { busy = false; lock(); }
  }

  function render(next: Voice) {
    const micLabels: Record<string, string> = {
      off: t('麦克风待命', 'Microphone on standby'), on: t('麦克风已接通', 'Microphone connected'),
      opening: t('正在打开麦克风', 'Opening microphone'), denied: t('无法访问麦克风', 'Microphone access denied'),
      error: t('麦克风不可用', 'Microphone unavailable'),
    };
    enabled.checked = next.enabled;
    status.textContent = next.enabled ? micLabels[next.mic.state] ?? t('等待麦克风连接', 'Waiting for microphone')
      : t('语音输入已关闭', 'Voice input is off');
    status.dataset.live = String(next.enabled && next.mic.state === 'on');
    status.title = next.enabled ? next.mic.detail ?? '' : '';
    meter.value = next.enabled && next.mic.state === 'on' ? Math.max(-60, Math.min(0, next.level || -60)) : -60;
    const devicesKey = JSON.stringify([next.input.deviceId, next.input.devices]);
    if (deviceKey !== devicesKey) {
      deviceKey = devicesKey;
      const devices = [{ id: '', label: t('系统默认', 'System default') }, ...next.input.devices.filter(slot => slot.id)];
      if (next.input.deviceId && !devices.some(slot => slot.id === next.input.deviceId)) {
        devices.push({ id: next.input.deviceId, label: t('原设备未连接', 'Saved device disconnected') });
      }
      device.replaceChildren(...choice(devices.map(slot => [slot.id, slot.label])).options);
    }
    device.value = next.input.deviceId;
    engine.value = next.engineSetting ?? next.engine;
    summary.textContent = next.enabled ? t('按住说话', 'Hold to talk') : t('已关闭', 'Off');
    engine.querySelector<HTMLOptionElement>('[value=system]')!.disabled = !next.systemSupported;
    const local = next.engine === 'funasr' || next.engine === 'whisper';
    const phases: Record<string, string> = {
      absent: t('尚未下载', 'Not downloaded'), working: t('正在下载', 'Downloading'),
      ready: t('模型已就绪', 'Model ready'), error: t('下载失败', 'Download failed'),
    };
    const engineState = local ? next.server?.phase === 'running' ? t('正在运行', 'Running')
      : phases[next.model.phase] ?? '' : next.engine === 'api' ? next.api.model || t('未选择转写模型', 'No transcription model selected') : '';
    const activeEngine = engine.value === '' ? [...engine.options].find(option => option.value === next.engine)?.textContent : '';
    engineDescription.textContent = [activeEngine, engineState].filter(Boolean).join(' · ');
    engineDescription.title = next.server?.detail ?? next.model.detail ?? '';
    download.hidden = !local || ['ready', 'working'].includes(next.model.phase);
    start.hidden = !local || next.model.phase !== 'ready' || next.server?.phase === 'running';
    stop.hidden = !local || next.server?.phase !== 'running';
    service.hidden = next.engine !== 'api';
    progress.hidden = !local || next.model.phase !== 'working';
    if (next.model.total) { progress.max = next.model.total; progress.value = next.model.done; }
    else progress.removeAttribute('value');

    const historyKey = JSON.stringify(next.recent);
    if (recentKey !== historyKey) {
      recentKey = historyKey;
      recent.replaceChildren(...next.recent.slice(-8).reverse().map(item => c.node('p', item.text + (item.dropped ? t(' · 未投递', ' · Not delivered') : ''))));
      if (!next.recent.length) recent.append(c.node('p', t('还没有识别记录。', 'No recognition history yet.'), 'studio-help'));
    }
    lock();
  }

  async function refresh() {
    if (reading || ctx.signal.aborted) return;
    reading = true;
    const issued = mutation;
    try {
      const next = await invokePanel<Voice>(P, 'voice', 'state', [], { signal: ctx.signal });
      if (!ctx.signal.aborted && issued === mutation && (!busy || next.model.phase === 'working')) {
        state = next;
        render(next);
      }
    } catch (error) {
      if (!ctx.signal.aborted && !state) {
        feedback.textContent = errorText(error);
        summary.textContent = t('无法读取语音输入状态', 'Could not read voice input status');
      }
    }
    finally { reading = false; }
  }

  const on = { signal: ctx.signal };
  enabled.addEventListener('change', () => void call('setEnabled', [enabled.checked]), on);
  device.addEventListener('change', () => void call('setMic', [{ deviceId: device.value }]), on);
  engine.addEventListener('change', () => void call('setEngine', [engine.value]), on);
  summary.textContent = t('正在读取…', 'Reading…');
  return { element, refresh, enabled, summary, recent, quick };
}
