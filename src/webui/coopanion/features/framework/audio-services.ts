import type { PageContext } from '../../base/page.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';
import { serviceLabel, type ServiceState } from './model-services.ts';

type VoiceField = { key: string; label: string; value: string | number; type?: string; min?: number; max?: number; step?: number; required?: boolean };
type Voice = {
  enabled: boolean;
  provider: string;
  profiles: Record<string, Record<string, string | number>>;
  providers: Record<string, { fields: VoiceField[]; help?: string; helpEn?: string }>;
  playback: { id: string; status: string; reason?: string } | null;
};
type Planner = { enabled: boolean; ready: boolean; last?: { status: string } };

export function voiceService(ctx: PageContext) {
  const c = studioControls(ctx);
  const element = c.node('section', '', 'studio-voice-service');
  const title = c.node('small', '', 'studio-voice-state');
  const enabled = c.node('input'); enabled.type = 'checkbox'; enabled.setAttribute('role', 'switch');
  const profile = c.node('div', '', 'studio-service-fields');
  const input = c.node('input'); input.value = t('你好，我在这里。', 'Hello, I’m here.'); input.maxLength = 1500;
  const status = c.status('studio-sound-message'), playback = c.status('studio-sound-message');
  const actions = c.node('div', '', 'studio-inline studio-voice-actions');
  const play = c.button(t('试听', 'Preview'), () => void preview());
  const stop = c.button(t('停止', 'Stop'), () => void stopPreview());
  const manage = c.link(t('管理合成模型', 'Manage synthesis model'), 'services');
  actions.append(play, stop, manage);
  const enabledRow = c.field(t('启用语音合成', 'Enable speech synthesis'), enabled);
  enabledRow.firstElementChild!.append(title);
  const notices = c.node('div', '', 'studio-voice-notices');
  notices.append(status, playback);
  const previewFooter = c.node('div', '', 'studio-voice-preview-footer');
  previewFooter.append(actions, notices);
  element.append(enabledRow, profile, c.field(t('试听文本', 'Preview text'), input), previewFooter);

  let state: Voice | undefined, services: ServiceState | undefined, request: string | undefined, busy = false, starting = false;
  let reading: Promise<void> | undefined;
  const fields = new Map<string, HTMLInputElement>();
  const statuses: Record<string, string> = {
    preparing: t('正在合成…', 'Synthesizing…'), started: t('正在播放', 'Playing'),
    finished: t('试听完成', 'Preview finished'), failed: t('试听失败', 'Preview failed'), cancelled: t('已停止', 'Stopped'),
  };
  function render() {
    if (!state) return;
    title.textContent = state.enabled
      ? services ? serviceLabel(services, 'tts') : t('正在读取模型', 'Reading model')
      : t('仅显示文字', 'Text only');
    const receipt = request && state.playback?.id === request ? state.playback : null;
    if (receipt) playback.textContent = (statuses[receipt.status] ?? receipt.status) + (receipt.reason ? ' · ' + receipt.reason : '');
    const playing = receipt?.status === 'preparing' || receipt?.status === 'started';
    enabled.disabled = busy;
    for (const control of fields.values()) control.disabled = busy;
    play.disabled = busy || starting || playing || !services?.selected?.tts;
    stop.disabled = !request || !!receipt && !playing;
  }
  function read() {
    reading ??= Promise.all([c.call<Voice>('audio.ttsState'), c.call<ServiceState>('services.state')]).then(([voice, bindings]) => {
      if (ctx.signal.aborted) return;
      if (busy) return;
      const previous = state;
      state = voice; services = bindings;
      if (!previous) prepare();
      render();
    }).catch(error => {
      if (ctx.signal.aborted) return;
      status.textContent = errorText(error);
      if (!state) title.textContent = t('无法读取说话声设置', 'Could not read speech settings');
    }).finally(() => { reading = undefined; });
    return reading;
  }
  function prepare() {
    if (!state || busy) return;
    enabled.checked = state.enabled;
    profile.replaceChildren();
    fields.clear();
    const spec = state.providers?.[state.provider];
    if (spec?.help) profile.append(c.node('p', t(spec.help, spec.helpEn ?? spec.help), 'studio-help'));
    const connection = new Set(['endpoint','model','region','appId','cluster','groupId','version','modelDir']);
    for (const field of spec?.fields ?? []) {
      if (connection.has(field.key)) continue;
      const control = c.node('input');
      const value = String(state.profiles?.[state.provider]?.[field.key] ?? field.value);
      fields.set(field.key, control);
      if (field.type === 'number' && field.min !== undefined && field.max !== undefined) {
        const unit = field.label.includes('%') ? '%' : field.label.includes('Hz') ? ' Hz' : field.key === 'speed' ? '×' : '';
        const slider = c.range(control, field.min, field.max, String(field.step ?? 'any'), value => value + unit);
        control.value = value;
        slider.sync();
        profile.append(c.field(field.label, slider.element));
      } else {
        control.type = field.type === 'number' ? 'number' : 'text';
        control.value = value;
        profile.append(c.field(field.label, control));
      }
      control.addEventListener('change', () => { void persist(); }, { signal: ctx.signal });
    }
    status.textContent = '';
    render();
    playback.textContent = '';
  }
  async function persist() {
    if (busy || !state) return false;
    if ([...fields.values()].some(field => !field.reportValidity() || field.type === 'number' && !field.value)) return false;
    busy = true; render(); status.textContent = t('正在保存…', 'Saving…');
    try {
      const values = Object.fromEntries([...fields].map(([key, field]) => [key, field.type === 'number' || field.type === 'range' ? field.valueAsNumber : field.value]));
      state = await c.call<Voice>('audio.setTts', [{ enabled: enabled.checked, provider: state.provider,
        profile: { ...state.profiles?.[state.provider], ...values } }]);
      status.textContent = t('已保存', 'Saved'); return true;
    } catch (error) { status.textContent = errorText(error); return false; }
    finally { busy = false; render(); }
  }
  async function stopPreview() {
    if (!request) return;
    const id = request;
    request = undefined;
    try {
      await c.call('audio.stopTts', [id]);
      if (!ctx.signal.aborted) playback.textContent = t('已停止', 'Stopped');
    } catch (error) { if (!ctx.signal.aborted) playback.textContent = errorText(error); }
    render();
  }
  async function preview() {
    if (starting) return;
    starting = true;
    try {
      if (!await persist() || !element.isConnected) return;
      playback.textContent = t('正在准备试听…', 'Preparing preview…');
      const result = await c.call<{id: string}>('audio.previewTts', [input.value]);
      request = result.id;
      if (!element.isConnected) await stopPreview();
      else await read();
    } catch (error) { playback.textContent = errorText(error); }
    finally { starting = false; render(); }
  }
  enabled.addEventListener('change', () => { void persist(); }, { signal: ctx.signal });
  ctx.lifecycle.add(() => { if (request) c.keepalive('audio.stopTts', [request]); });
  play.disabled = stop.disabled = true;
  render();
  return { element, read, prepare };
}

export function plannerSwitch(ctx: PageContext) {
  const c = studioControls(ctx);
  const element = c.node('div', '', 'studio-speech-planner');
  const enabled = c.node('input'); enabled.type = 'checkbox'; enabled.setAttribute('role', 'switch');
  const status = c.node('small');
  const field = c.field(t('说话时编排动作', 'Choreograph speech'), enabled);
  field.firstElementChild!.append(status);
  element.append(field, c.link(t('管理编排模型', 'Manage choreography model'), 'services'));
  let reading: Promise<void> | undefined;
  const read = () => reading ??= Promise.all([c.call<Planner>('audio.plannerState'), c.call<ServiceState>('services.state')]).then(([state, services]) => {
    if (ctx.signal.aborted || enabled.disabled) return;
    enabled.checked = state.enabled;
    status.textContent = serviceLabel(services, 'planner') + ' · ' + (state.enabled ? state.ready ? t('已就绪', 'Ready') : t('待配置', 'Needs setup') : t('已关闭', 'Off'));
  }).catch(error => { if (!ctx.signal.aborted) status.textContent = errorText(error); }).finally(() => { reading = undefined; });
  enabled.addEventListener('change', () => {
    enabled.disabled = true;
    void c.call('audio.configurePlanner', [enabled.checked]).then(() => {
      enabled.disabled = false;
      return read();
    }).catch(error => { enabled.disabled = false; status.textContent = errorText(error); });
  }, { signal: ctx.signal });
  return { element, read };
}
