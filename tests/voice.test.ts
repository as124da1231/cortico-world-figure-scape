import { openVoiceWindow, holdSpeech } from './helpers/voice-window.ts';
/**
 * Voice input end to end inside the World: PCM frames over the pet socket → segmenter →
 * FunASR or Whisper (a stand-in for sherpa-onnx's recognizer that answers with a set line) →
 * `desktop-live2d-pet.speech` event, with the listen phases the page shows along the way.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_PET_DEFAULTS } from '../src/config.ts';
import { DesktopPetWorld } from '../src/world.ts';
import { petText } from '../src/i18n/index.ts';
import type { Language } from 'cortico/core/language.ts';
import { loadSherpa, type SherpaModule } from '../src/asr/sherpa.ts';
import type { ModelSpec } from '../src/runtime/store.ts';
import { rmsDb } from '../src/asr/segmenter.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { FakePage } from './helpers/page.ts';
import { fakeSapi } from './helpers/fake-sapi.ts';

it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('reports a missing local ONNX DLL before running Sherpa native code', () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-native-asr-'));
  const wrapper = join(root, 'node_modules', 'sherpa-onnx-node');
  const native = join(root, 'node_modules', 'sherpa-onnx-win-x64');
  mkdirSync(wrapper, {recursive:true});
  mkdirSync(native, {recursive:true});
  writeFileSync(join(wrapper, 'index.js'), 'throw Error("Sherpa loaded")');
  writeFileSync(join(native, 'sherpa-onnx.node'), '');
  const require = createRequire(join(root, 'audit.cjs'));
  expect(() => loadSherpa(require)).toThrow('missing onnxruntime.dll');
});

/** A recognizer that answers `reply(samples)`; `decodes` lists how many samples each decode got. */
interface FakeFunAsr { sherpa: SherpaModule; decodes: number[]; audio: Float32Array[]; configs: Array<Record<string, unknown>>; reply: (samples: number) => string; beforeLoad?: () => Promise<void> }

function fakeFunAsr(text: string | ((samples: number) => string)): FakeFunAsr {
  const fake = { decodes: [] as number[], audio: [] as Float32Array[], configs: [] as Array<Record<string, unknown>>, reply: typeof text === 'string' ? () => text : text } as FakeFunAsr;
  fake.sherpa = {
    OfflineRecognizer: {
      createAsync: async (config) => {
        fake.configs.push(config);
        await fake.beforeLoad?.();
        return {
          createStream: () => {
            const stream = {
              samples: 0, audio: new Float32Array(),
              acceptWaveform: (w: { samples: Float32Array }) => {
                const audio = new Float32Array(stream.samples + w.samples.length);
                audio.set(stream.audio); audio.set(w.samples, stream.samples);
                stream.audio = audio;
                stream.samples += w.samples.length;
              },
            };
            return stream;
          },
          decodeAsync: async (stream) => {
            const { samples: n, audio } = stream as { samples: number; audio: Float32Array };
            fake.decodes.push(n);
            fake.audio.push(audio);
            return { text: fake.reply(n) };
          },
        };
      },
    },
  };
  return fake;
}

const MODEL = Buffer.from('model');
const TOKENS = Buffer.from('tokens');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** A small stand-in for the FunASR model, fetched from `url` when not placed beforehand. */
const modelSpec = (url = 'http://127.0.0.1:9'): ModelSpec => ({
  id: 'test-model',
  files: [{ role: 'model', name: 'model.int8.onnx', bytes: MODEL.length, sha256: sha(MODEL) }, { role: 'tokens', name: 'tokens.txt', bytes: TOKENS.length, sha256: sha(TOKENS) }],
  sources: [(f) => `${url}/${f}`],
});
function placeModel(modelsDir: string): void {
  mkdirSync(join(modelsDir, 'test-model'), { recursive: true });
  writeFileSync(join(modelsDir, 'test-model', 'model.int8.onnx'), MODEL);
  writeFileSync(join(modelsDir, 'test-model', 'tokens.txt'), TOKENS);
}
/** A small stand-in for the Whisper model, placed in `modelsDir`. */
function placeWhisper(modelsDir: string): ModelSpec {
  const files = ['encoder', 'decoder', 'tokens'].map((role) => ({ role, name: `${role}.bin`, body: Buffer.from(role) }));
  mkdirSync(join(modelsDir, 'test-whisper'), { recursive: true });
  for (const file of files) writeFileSync(join(modelsDir, 'test-whisper', file.name), file.body);
  return { id: 'test-whisper', files: files.map(({ role, name, body }) => ({ role, name, bytes: body.length, sha256: sha(body) })), sources: [] };
}

const tone = (ms: number, amp: number) => {
  const frames: Int16Array[] = [];
  for (let f = 0; f < ms / 20; f++) {
    const fr = new Int16Array(320);
    for (let i = 0; i < 320; i++) fr[i] = Math.round(amp * 32767 * Math.sin(2 * Math.PI * 440 * (f * 320 + i) / 16000));
    frames.push(fr);
  }
  return frames;
};

const floatAudio = (frames: Int16Array[]) => Float32Array.from(frames.flatMap((frame) => [...frame]), (sample) => sample / 32768);

async function sendAudio(world: DesktopPetWorld, page: FakePage, frames: Int16Array[]): Promise<void> {
  for (const frame of frames) page.audio(frame);
  await expect.poll(() => world.voiceState().level).toBe(rmsDb(frames.at(-1)!));
}

/** Writes a config patch into the live section, as Core does with a World's persist. */
const merge = (to: Record<string, unknown>, patch: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) merge(to[k] as Record<string, unknown>, v as Record<string, unknown>);
    else to[k] = v;
  }
};

const platform = process.platform;
let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  Object.defineProperty(process, 'platform', { value: platform });
  cleanup = [];
});

async function setup(text: string | ((samples: number) => string), language: Language = 'zh', loadGate?: Promise<void>, reuseModel = false) {
  const asr = fakeFunAsr(text);
  if (loadGate) asr.beforeLoad = () => loadGate;
  const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
  cfg.asr.enabled = true;
  Object.assign(cfg, { enabled: true, port: 0 });
  cfg.window.enabled = false;
  const dir = mkdtempSync(join(tmpdir(), 'pet-voice-'));
  const modelRoot = join(dir, reuseModel ? 'native' : 'm');
  placeModel(modelRoot);
  const world = new DesktopPetWorld({
    cfg, timezone: 'Asia/Shanghai', persist: (patch) => merge(cfg as never, patch as never), runtimesRoot: () => join(dir, 'rt'), modelsDir: () => join(dir, 'm'),
    reuseModelsDir: () => join(dir, 'native'),
    loadSherpa: () => asr.sherpa, funasrModel: modelSpec(), whisperModel: placeWhisper(join(dir, 'm')), language: () => language,
  });
  const host = new FakeHost();
  await world.start(host);
  cleanup.push(() => world.stop());
  const page = await openVoiceWindow(world);
  cleanup.push(() => page.close());
  await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe(loadGate ? 'starting' : 'running');
  return { asr, world, host, page, cfg, modelRoot };
}

describe('voice input', () => {
  it.each(['zh', 'fr'] as Language[])('unloads the %s recognition model when disabled and reloads it when enabled', async (language) => {
    const { cfg, world, page, asr } = await setup('hello', language);
    cfg.asr.enabled = false;
    await page.next((m) => m.t === 'prefs' && m.mic === false);
    await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('stopped');
    cfg.asr.enabled = true;
    await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('running');
    expect(asr.configs).toHaveLength(2);
  });

  it('stops the active engine when the configured engine changes before the stop request', async () => {
    const { cfg, world } = await setup('hello');
    cfg.asr.engine = 'whisper';
    await world.webUi().invoke!('voice', 'stop', []);
    cfg.asr.engine = 'funasr';
    expect((world.voiceState().server as { phase: string }).phase).toBe('stopped');
  });

  it('finishes unloading a pending model before a rapid disable and enable starts it again', async () => {
    let loaded!: () => void;
    const loadGate = new Promise<void>((resolve) => { loaded = resolve; });
    const { cfg, world, page, asr } = await setup('hello', 'zh', loadGate);
    try {
      cfg.asr.enabled = false;
      await page.next((m) => m.t === 'prefs' && (m.voice as { enabled?: boolean })?.enabled === false);
      cfg.asr.enabled = true;
      const restarted = world.startVoiceBackend();
      loaded();
      await restarted;
      expect((world.voiceState().server as { phase: string }).phase).toBe('running');
      expect(asr.configs).toHaveLength(2);
    } finally { loaded(); }
  });

  it('closes the system helper when voice input is disabled', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
    cfg.asr.enabled = true;
    Object.assign(cfg, { enabled: true, port: 0 });
    cfg.window.enabled = false;
    cfg.asr.engine = 'system';
    const { spawnImpl, spawned } = fakeSapi({ final: () => 'hello' });
    const dir = mkdtempSync(join(tmpdir(), 'pet-voice-'));
    const world = new DesktopPetWorld({ cfg, timezone: 'Asia/Shanghai', persist: () => {}, runtimesRoot: () => join(dir, 'rt'), modelsDir: () => join(dir, 'm'), spawnSystemRecognizer: spawnImpl });
    await world.start(new FakeHost());
    cleanup.push(() => world.stop());
    const page = await openVoiceWindow(world);
    cleanup.push(() => page.close());
    await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('running');
    cfg.asr.enabled = false;
    await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('stopped');
    expect(spawned[0].child.exitCode).toBe(0);
    expect(world.voiceState().server).toMatchObject({ pid: null });
  });

  it('delivers one utterance from the local microphone button on release', async () => {
    const { asr, host, page } = await setup('今天天气怎么样');
    holdSpeech(page, tone(900, .3));
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]).toMatchObject({ type: 'desktop-live2d-pet.speech', senderKey: 'desktop-live2d-pet.voice', text: expect.stringContaining('[voice] 伙伴:今天天气怎么样') });
    expect(host.pushOpts[0]).toEqual({ trigger: 'interrupt' });
    expect((await page.next((m) => m.t === 'listen' && m.phase === 'heard')).text).toBe('今天天气怎么样');
    // the last decode is the whole utterance: at least the 900 ms spoken
    expect(asr.decodes.at(-1)).toBeGreaterThanOrEqual(900 * 16);
    expect(asr.configs[0]).toMatchObject({ modelConfig: { senseVoice: { language: 'zh' }, numThreads: 2 } });
  });

  it('a threshold set from the meter applies to the next frame: speech below it is not heard', async () => {
    const { world, host, page } = await setup('不该听见');
    await world.webUi().invoke!('voice', 'setMic', [{ mode: 'always' }]);
    const speech = tone(900, .3);
    const state = await world.webUi().invoke!('voice', 'setThreshold', [rmsDb(speech[0]) + 3]) as { thresholdDb: number };
    expect(state.thresholdDb).toBe(rmsDb(speech[0]) + 3);
    const last = tone(20, .05)[0];
    for (const fr of [...speech, ...tone(900, 0), last]) page.audio(fr);
    await expect.poll(() => world.voiceState().level).toBe(rmsDb(last));
    expect((world.voiceState().counts as { utterances: number }).utterances).toBe(0);
    expect(host.events).toHaveLength(0);
  });

  it('drops a known hallucination and tells the page nothing was heard', async () => {
    const { host, page } = await setup('谢谢观看');
    holdSpeech(page, tone(900, .3));
    await page.next((m) => m.t === 'listen' && m.phase === 'none');
    expect(host.events).toHaveLength(0);
  });

  it('opens the microphone only during a hold and discards audio on hide', async () => {
    const { asr, host, page, world } = await setup('未发送');
    expect(page.init.mic).toBe(false);
    for (const frame of tone(500, .3)) page.audio(frame);
    expect(asr.decodes).toHaveLength(0);
    page.send({ t: 'speak-hold', down: true });
    await page.next(msg => msg.t === 'speech-stop' && msg.reason === 'voice-input');
    await page.next(msg => msg.t === 'prefs' && msg.mic === true);
    for (const frame of tone(500, .3)) page.audio(frame);
    page.send({ t: 'visibility', hidden: true });
    await page.next(msg => msg.t === 'desktop-release');
    page.send({ t: 'speak-hold', down: false });
    await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('stopped');
    expect(host.events.filter(event => event.type === 'desktop-live2d-pet.speech')).toHaveLength(0);
  });

  it('system engine: the bubble shows the sentence while it is spoken, then the event carries the final text', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
    cfg.asr.enabled = true;
    Object.assign(cfg, { enabled: true, port: 0 });
    cfg.window.enabled = false;
    cfg.asr.engine = 'system';
    // one character per 100 ms of audio heard so far; the final text settles on the whole sentence
    const { spawnImpl, spawned } = fakeSapi({ partial: (n) => '听'.repeat(Math.floor(n / 3200)) || null, final: () => '听清楚了' });
    const dir = mkdtempSync(join(tmpdir(), 'pet-voice-'));
    const world = new DesktopPetWorld({ cfg, timezone: 'Asia/Shanghai', persist: () => {}, runtimesRoot: () => join(dir, 'rt'), modelsDir: () => join(dir, 'm'), spawnSystemRecognizer: spawnImpl });
    const host = new FakeHost();
    await world.start(host);
    cleanup.push(() => world.stop());
    const page = await openVoiceWindow(world);
    cleanup.push(() => page.close());
    await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('running');

    page.send({ t: 'speak-hold', down: true });
    for (const fr of tone(600, .3)) page.audio(fr);
    const live = await page.next((m) => m.t === 'listen' && m.phase === 'partial' && typeof m.interim === 'string' && m.interim.length >= 3);
    expect(live.text).toBe('');
    expect(host.events).toHaveLength(0);
    page.send({ t: 'speak-hold', down: false });
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0].text).toContain('[voice] 伙伴:听清楚了');
    expect((await page.next((m) => m.t === 'listen' && m.phase === 'heard')).text).toBe('听清楚了');
    // one streamed sentence, not a second pass over the finished audio
    expect(spawned[0].lines.filter((l) => l.startsWith('B '))).toHaveLength(1);
  });

  it('funasr: the bubble shows what is heard while the sentence is spoken', async () => {
    // one character per 100 ms of audio decoded so far
    const { host, page } = await setup((n) => '听'.repeat(Math.floor(n / 1600)));
    page.send({ t: 'speak-hold', down: true });
    for (const fr of tone(1400, .3)) page.audio(fr);
    const live = await page.next((m) => m.t === 'listen' && m.phase === 'partial' && typeof m.interim === 'string' && m.interim.length >= 3);
    expect(live.text).toBe('');
    expect(host.events).toHaveLength(0);
    page.send({ t: 'speak-hold', down: false });
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(String(host.events[0].meta?.text).length).toBeGreaterThan(13);
  });

  it('whisper: an app language SenseVoice does not hear goes to Whisper in that language, decoded once when the sentence ends', async () => {
    const { asr, host, page } = await setup('Quelle heure est-il ?', 'fr');
    page.send({ t: 'speak-hold', down: true });
    for (const fr of tone(1400, .3)) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    await new Promise((r) => setTimeout(r, 300));
    expect(asr.decodes).toHaveLength(0);
    page.send({ t: 'speak-hold', down: false });
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0].text).toContain('Quelle heure est-il ?');
    expect(asr.decodes).toHaveLength(1);
    expect(asr.configs[0]).toMatchObject({ modelConfig: { whisper: { language: 'fr', task: 'transcribe' } } });
  });

  it('funasr without its model says so, and the download starts it', async () => {
    const MODEL_FILES: Record<string, Buffer> = { 'model.int8.onnx': Buffer.from('model'), 'tokens.txt': Buffer.from('tokens') };
    const server = createServer((req, res) => {
      const body = MODEL_FILES[(req.url ?? '').slice(1)];
      if (!body) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-length': String(body.length) }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanup.push(() => new Promise((r) => server.close(() => r())));
    const asr = fakeFunAsr('你好');
    const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
    cfg.asr.enabled = true;
    Object.assign(cfg, { enabled: true, port: 0 });
    cfg.window.enabled = false;
    const dir = mkdtempSync(join(tmpdir(), 'pet-voice-'));
    const world = new DesktopPetWorld({
      cfg, timezone: 'Asia/Shanghai', persist: () => {}, runtimesRoot: () => join(dir, 'rt'), modelsDir: () => join(dir, 'm'),
      loadSherpa: () => asr.sherpa, funasrModel: modelSpec(`http://127.0.0.1:${(server.address() as { port: number }).port}`),
    });
    await world.start(new FakeHost());
    cleanup.push(() => world.stop());
    const page = await openVoiceWindow(world);
    cleanup.push(() => page.close());
    await expect.poll(() => (world.voiceState().server as { detail: string | null }).detail).toContain(petText('zh').voice.modelMissing(0));
    expect((world.voiceState().server as { phase: string }).phase).toBe('stopped');
    expect((world.voiceState().model as { phase: string }).phase).toBe('absent');
    await world.installVoice();
    expect((world.voiceState().model as { phase: string }).phase).toBe('ready');
    expect((world.voiceState().server as { phase: string }).phase).toBe('running');
    expect(asr.configs).toHaveLength(1);
  });

  it('ignores quiet input', async () => {
    const { asr, page, world } = await setup('x');
    await world.webUi().invoke!('voice', 'setMic', [{ mode: 'always' }]);
    for (const frame of tone(1500, .002)) page.audio(frame);
    await new Promise((r) => setTimeout(r, 400));
    expect(asr.decodes).toHaveLength(0);
    expect((world.voiceState().counts as { utterances: number }).utterances).toBe(0);
  });

  it('recognizes short quiet speech in hold mode and reuses the native model without downloading', async () => {
    const { world, page, host, asr, modelRoot } = await setup('听见了', 'zh', undefined, true);
    expect(world.voiceState().model).toMatchObject({ phase: 'ready', reused: true, path: join(modelRoot, 'test-model') });
    expect(asr.configs[0]).toMatchObject({ modelConfig: { senseVoice: { model: join(modelRoot, 'test-model', 'model.int8.onnx') } } });
    holdSpeech(page, tone(240, .004));
    await expect.poll(() => host.events.length).toBe(1);
  });

  it('preserves the hold warm-up option and uses a closed idle mic in click mode', async () => {
    const { world, page, host, asr } = await setup('录音已收到');
    const invoke = world.webUi().invoke!;
    await invoke('voice', 'setMic', [{ mode: 'hold', openOnPress: false }]);
    await page.next(msg => msg.t === 'prefs' && msg.mic === true);
    for (const frame of tone(500, .3)) page.audio(frame);
    expect(host.events).toHaveLength(0);

    await invoke('voice', 'setMic', [{ mode: 'toggle' }]);
    await invoke('voice', 'setThreshold', [-5]);
    await page.next(msg => msg.t === 'prefs' && msg.mic === false
      && (msg.voice as {mode?: string})?.mode === 'toggle');
    page.send({ t: 'speak-toggle' });
    const recording = await page.next(msg => msg.t === 'prefs' && msg.mic === true
      && (msg.voice as {recording?: boolean})?.recording === true);
    expect(recording.voice).toMatchObject({hint: expect.stringContaining('结束并发送')});
    await sendAudio(world, page, [...tone(240, .004), ...tone(1200, 0), ...tone(240, .008)]);
    expect(host.events).toHaveLength(0);
    // A streaming recognizer can show draft text, but the silence cannot end or send the recording.
    expect((world.voiceState().counts as { utterances: number }).utterances).toBe(0);
    page.send({ t: 'speak-toggle' });
    await page.next(msg => msg.t === 'prefs' && msg.mic === false
      && (msg.voice as {processing?: boolean})?.processing === true);
    await expect.poll(() => host.events.length).toBe(1);
    expect(asr.decodes.at(-1)).toBe(1680 * 16);
    const ready = await page.next(msg => msg.t === 'prefs' && msg.mic === undefined
      && (msg.voice as {processing?: boolean})?.processing === false
      && String((msg.voice as {hint?: string})?.hint).includes('开始录音'));
    expect(ready.voice).toMatchObject({recording: false, mode: 'toggle'});
  });

  it.each(['hold', 'toggle'] as const)('an activation click only enables the configured manual mode (%s)', async mode => {
    const { world, page, host, cfg, asr } = await setup('按选择的方式说');
    const invoke = world.webUi().invoke!;
    await invoke('voice', 'setMic', [{ mode }]);
    await invoke('voice', 'setEnabled', [false]);
    await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('stopped');
    page.messages.length = 0;
    page.send({ t: 'speak-activate' });
    await expect.poll(() => cfg.asr.enabled).toBe(true);
    await page.next(msg => { const voice = msg.voice as { mode?: string; ready?: boolean; activating?: boolean; recording?: boolean } | undefined;
      return msg.t === 'prefs' && voice?.mode === mode && voice?.ready === true && voice.activating === false && voice.recording === false && msg.mic === false;
    });
    expect(cfg.asr.enabled).toBe(true);
    await sendAudio(world, page, tone(500, .3));
    expect(asr.decodes).toHaveLength(0);
    expect(host.events).toHaveLength(0);
    if (mode === 'hold') holdSpeech(page,tone(500,.3));
    else {
      page.send({ t: 'speak-toggle' });
      await sendAudio(world, page, tone(500, .2));
      page.send({ t: 'speak-toggle' });
    }
    await expect.poll(() => host.events.length).toBe(1);
    expect(cfg.asr.mic.mode).toBe(mode);
  });

  it('pauses automatic listening, discards unfinished speech and resumes in the same mode', async () => {
    const { world, page, host, cfg } = await setup('恢复监听后才发送');
    await world.webUi().invoke!('voice', 'setMic', [{ mode: 'always' }]);
    await sendAudio(world, page, tone(500, .3));
    await page.next(msg => msg.t === 'listen' && msg.phase === 'start');
    await world.webUi().invoke!('voice', 'testStart', []);
    page.send({ t: 'speak-pause' });
    await sendAudio(world, page, tone(500, .3));
    expect(cfg.asr.enabled).toBe(true);
    await world.webUi().invoke!('voice', 'testCancel', []);
    await sendAudio(world, page, tone(500, .3));
    page.send({ t: 'speak-pause' });
    await expect.poll(() => cfg.asr.enabled).toBe(false);
    await page.next(msg => msg.t === 'prefs' && msg.mic === false);
    for (const frame of tone(900, 0)) page.audio(frame);
    page.send({ t: 'mic', state: 'off' });
    await expect.poll(() => world.voiceState().mic).toMatchObject({ state: 'off' });
    expect(world.voiceState().input).toMatchObject({ open: false, mode: 'always' });
    expect(host.events).toHaveLength(0);
    page.send({ t: 'speak-activate' });
    await expect.poll(() => (world.voiceState().server as {phase: string}).phase).toBe('running');
    await sendAudio(world, page, tone(500, .3));
    await sendAudio(world, page, tone(900, 0));
    await expect.poll(() => host.events.length).toBe(1);
    expect(cfg.asr.mic.mode).toBe('always');
  });

  it('ignores a manual toggle in automatic mode without flushing the utterance', async () => {
    const { world, page, host } = await setup('自动监听发出');
    await world.webUi().invoke!('voice', 'setMic', [{ mode: 'always' }]);
    await sendAudio(world, page, tone(500, .3));
    page.send({ t: 'speak-toggle' });
    await sendAudio(world, page, tone(20, .4));
    expect((world.voiceState().counts as { utterances: number }).utterances).toBe(0);
    expect(host.events).toHaveLength(0);
    await sendAudio(world, page, tone(900, 0));
    await expect.poll(() => host.events.length).toBe(1);
  });

  it('cancels click recording on mode change rather than sending it', async () => {
    const { world, page, host } = await setup('不应发送');
    const invoke = world.webUi().invoke!;
    await invoke('voice', 'setMic', [{ mode: 'toggle' }]);
    page.send({ t: 'speak-toggle' });
    await sendAudio(world, page, tone(500, .3));
    await invoke('voice', 'setMic', [{ mode: 'hold' }]);
    page.send({ t: 'speak-toggle' });
    await sendAudio(world, page, tone(20, .2));
    expect(host.events).toHaveLength(0);
    expect((world.voiceState().counts as { utterances: number }).utterances).toBe(0);
  });

  it('closes the microphone in the cancellation message and never sends the tap recording', async () => {
    const { world, page, host } = await setup('不应发送');
    await world.webUi().invoke!('voice', 'setMic', [{ mode: 'toggle' }]);
    page.send({ t: 'speak-toggle' });
    await page.next(msg => msg.t === 'prefs' && msg.mic === true);
    await sendAudio(world, page, tone(500, .3));
    page.messages.length = 0;

    page.send({ t: 'cancel' });
    await page.next(msg => msg.t === 'listen' && msg.phase === 'none');
    const cancelled = await page.next(msg => msg.t === 'prefs'
      && (msg.voice as { mode?: string; recording?: boolean })?.mode === 'toggle'
      && (msg.voice as { recording?: boolean })?.recording === false);
    expect(cancelled.mic).toBe(false);
    expect((world.voiceState().counts as { utterances: number }).utterances).toBe(0);
    expect(host.events).toHaveLength(0);
  });

  it('discards a recording after microphone denial and records on the next click', async () => {
    const { world, page, host } = await setup('重试后听到了');
    await world.webUi().invoke!('voice', 'setMic', [{ mode: 'toggle' }]);
    page.send({ t:'speak-toggle' });
    await page.next(msg => msg.t === 'prefs' && msg.mic === true);
    page.send({ t:'mic', state:'denied', detail:'Permission denied' });
    await page.next(msg => msg.t === 'mic-error' && msg.state === 'denied');
    expect(host.events).toHaveLength(0);
    page.send({ t:'speak-toggle' });
    await sendAudio(world, page, tone(500, .3));
    page.send({ t:'speak-toggle' });
    await expect.poll(() => host.events.length).toBe(1);
  });

  it('uses the selected recognizer for a test even in automatic mode without sending anything to Coo', async () => {
    const { world, page, host, asr } = await setup('试录成功');
    const invoke = world.webUi().invoke!;
    await invoke('voice', 'setMic', [{ mode: 'always' }]);
    await invoke('voice', 'setThreshold', [-5]);
    await invoke('voice', 'testStart', []);
    await sendAudio(world, page, tone(500, .2));
    await invoke('voice', 'testFinish', []);
    expect(world.voiceState().test).toMatchObject({ phase: 'error', text: expect.stringContaining('门槛') });
    expect(asr.decodes).toHaveLength(0);
    await invoke('voice', 'testStart', []);
    await sendAudio(world, page, tone(500, .2));
    await invoke('voice', 'setThreshold', [-42]);
    await sendAudio(world, page, tone(500, .3));
    await invoke('voice', 'testFinish', []);
    await expect.poll(() => world.voiceState().test).toEqual({ phase: 'done', text: '试录成功' });
    expect(asr.decodes).toHaveLength(1);
    expect(host.events).toHaveLength(0);
  });

  it('tests with live voice input paused, then releases the test microphone without submitting', async () => {
    const { world, page, host, cfg } = await setup('这句话仅用于试录');
    const invoke = (method: string, args: unknown[] = []) => world.webUi().invoke!('voice', method, args);
    await invoke('setMic', [{ mode: 'always' }]);
    await invoke('setEnabled', [false]);
    await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('stopped');
    page.messages.length = 0;
    await invoke('testStart');
    await page.next(msg => msg.t === 'prefs' && msg.mic === true);
    await sendAudio(world, page, tone(620, .35));
    await invoke('testFinish');
    await expect.poll(() => world.voiceState().test).toEqual({ phase: 'done', text: '这句话仅用于试录' });
    await page.next(msg => msg.t === 'prefs' && msg.mic === false);
    await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('stopped');
    expect(cfg.asr.enabled).toBe(false);
    expect(host.events).toHaveLength(0);
  });

  it('counts the full recording time from the first audio frame and releases a cancelled or timed-out capture', async () => {
    const { world, host, asr } = await setup('试录成功');
    const invoke = (method: string) => world.webUi().invoke!('framework', 'voice.' + method, []);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await expect(invoke('testStart')).resolves.toMatchObject({ test: { phase: 'opening' } });
      vi.advanceTimersByTime(9000);
      expect(world.voiceState().test).toEqual({ phase: 'opening' });
      await invoke('testStart');
      world['onAudio'](new Int16Array(320));
      expect(world.voiceState().test).toEqual({ phase: 'recording' });
      vi.advanceTimersByTime(7999);
      expect(world.voiceState().test).toEqual({ phase: 'recording' });
      vi.advanceTimersByTime(1);
      expect(world.voiceState().test).toMatchObject({ phase: 'error', text: expect.stringContaining('已接通') });

      await invoke('testStart');
      await invoke('testCancel');
      vi.advanceTimersByTime(12_000);
      expect(world.voiceState().test).toEqual({ phase: 'idle' });

      await invoke('testStart');
      vi.advanceTimersByTime(12_000);
      expect(world.voiceState().test).toMatchObject({ phase: 'error', text: expect.stringContaining('未收到麦克风音频') });
      expect(asr.decodes).toHaveLength(0);
      expect(host.events).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('reopens a failed microphone when the user retries a test in automatic mode', async () => {
    const { world, page } = await setup('试录成功');
    const invoke = world.webUi().invoke!;
    await invoke('voice', 'setMic', [{ mode: 'always' }]);
    await invoke('voice', 'testStart', []);
    await page.next(msg => msg.t === 'prefs' && msg.mic === true);
    page.send({ t: 'mic', state: 'denied', detail: 'Permission denied' });
    await expect.poll(() => world.voiceState().test).toEqual({ phase: 'error', text: 'Permission denied' });
    page.messages.length = 0;
    await invoke('voice', 'testStart', []);
    const reset = await page.next(msg => msg.t === 'prefs' && msg.mic === false);
    const reopened = await page.next(msg => msg.t === 'prefs' && msg.mic === true);
    expect(reset.mic).toBe(false);
    expect(reopened.mic).toBe(true);
    await sendAudio(world, page, tone(500, .3));
    await invoke('voice', 'testFinish', []);
    await expect.poll(() => world.voiceState().test).toEqual({ phase: 'done', text: '试录成功' });
  });
});
