import { openVoiceWindow, holdSpeech } from './helpers/voice-window.ts';
/**
 * Voice input end to end inside the World: PCM frames over the pet socket → segmenter →
 * FunASR or Whisper (a stand-in for sherpa-onnx's recognizer that answers with a set line) →
 * `desktop-live2d-pet.speech` event, with the listen phases the page shows along the way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_PET_DEFAULTS } from '../src/config.ts';
import { DesktopPetWorld } from '../src/world.ts';
import { petText } from '../src/i18n/index.ts';
import type { Language } from 'cortico/core/language.ts';
import type { SherpaModule } from '../src/asr/sherpa.ts';
import type { ModelSpec } from '../src/runtime/store.ts';
import { rmsDb } from '../src/asr/segmenter.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { FakePage } from './helpers/page.ts';
import { fakeSapi } from './helpers/fake-sapi.ts';

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

/** A talk key the test presses; `problem` makes it unreadable. */
async function setup(text: string | ((samples: number) => string), language: Language = 'zh', loadGate?: Promise<void>) {
  const asr = fakeFunAsr(text);
  if (loadGate) asr.beforeLoad = () => loadGate;
  const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
  cfg.asr.enabled = true;
  Object.assign(cfg, { enabled: true, port: 0 });
  cfg.window.enabled = false;
  const dir = mkdtempSync(join(tmpdir(), 'pet-voice-'));
  placeModel(join(dir, 'm'));
  const world = new DesktopPetWorld({
    cfg, timezone: 'Asia/Shanghai', persist: (patch) => merge(cfg as never, patch as never), runtimesRoot: () => join(dir, 'rt'), modelsDir: () => join(dir, 'm'),
    loadSherpa: () => asr.sherpa, funasrModel: modelSpec(), whisperModel: placeWhisper(join(dir, 'm')), language: () => language,
  });
  const host = new FakeHost();
  await world.start(host);
  cleanup.push(() => world.stop());
  const page = await openVoiceWindow(world);
  cleanup.push(() => page.close());
  await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe(loadGate ? 'starting' : 'running');
  return { asr, world, host, page, cfg };
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
    expect(host.events[0]).toMatchObject({ type: 'desktop-live2d-pet.speech', senderKey: 'desktop-live2d-pet.voice', text: '[Live2D] [voice] 伙伴:今天天气怎么样' });
    expect(host.pushOpts[0]).toEqual({ trigger: 'interrupt' });
    expect((await page.next((m) => m.t === 'listen' && m.phase === 'heard')).text).toBe('今天天气怎么样');
    // the last decode is the whole utterance: at least the 900 ms spoken
    expect(asr.decodes.at(-1)).toBeGreaterThanOrEqual(900 * 16);
    expect(asr.configs[0]).toMatchObject({ modelConfig: { senseVoice: { language: 'zh' }, numThreads: 2 } });
  });

  it('a threshold set from the meter applies to the next frame: speech below it is not heard', async () => {
    const { world, host, page } = await setup('不该听见');
    const speech = tone(900, .3);
    const state = await world.webUi().invoke!('voice', 'setThreshold', [rmsDb(speech[0]) + 3]) as { thresholdDb: number };
    expect(state.thresholdDb).toBe(rmsDb(speech[0]) + 3);
    const last = tone(20, .05)[0];
    page.send({ t: 'speak-hold', down: true });
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
    expect(host.events[0].text).toBe('[Live2D] [voice] 伙伴:听清楚了');
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
    expect(host.events[0].text.length).toBeGreaterThan('[Live2D] [voice] 伙伴:'.length + 13);
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
    holdSpeech(page, tone(1500, .002));
    await new Promise((r) => setTimeout(r, 400));
    expect(asr.decodes).toHaveLength(0);
    expect((world.voiceState().counts as { utterances: number }).utterances).toBe(0);
  });
});
