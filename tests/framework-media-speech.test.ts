import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTtsService } from '../src/speech/tts-service.ts';
import { createSpeechPlanner, type SpeechPlannerConfig } from '../src/speech/speech-planner.ts';
// @ts-expect-error Renderer module uses browser Web Audio.
import { createMediaSpeech } from '../web/framework/media-speech.js';

describe('desktop media speech', () => {
  it('pauses at the audio clock and starts the same clip at the captured offset', async () => {
    const node = () => ({ buffer:null,onended:null,connect:vi.fn(),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn() });
    const first = node(), second = node();
    const output = { currentTime:10, state:'running', decodeAudioData:async () => ({duration:4}),
      createBufferSource:vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) };
    const report = vi.fn(), plan = vi.fn();
    const media = createMediaSpeech({audio:{speechOutput:()=>({ctx:output,master:{}})},
      read:async () => new Response(new Uint8Array(8)),sampler:async () => null,report,plan});
    const source = media.play('same');
    await vi.waitFor(()=>expect(source.state).toBe('scheduled'));
    output.currentTime = 11.25;
    media.tick();
    output.currentTime = 11.625;
    expect(media.take('same')).toBeCloseTo(1.625);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(report).toHaveBeenLastCalledWith({id:'same',status:'paused',reason:'scene-handoff'});
    output.currentTime = 20;
    const resumed = media.play('same',[],false,undefined,1.625);
    await vi.waitFor(()=>expect(resumed.state).toBe('scheduled'));
    expect(second.start).toHaveBeenCalledWith(20,1.625);
    output.currentTime = 20.125;
    media.tick();
    expect(resumed.position).toBeCloseTo(1.75);
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({kind:'start',id:'same',position:1.625}));
    media.stop();
  });
  it('uses the existing voice adapter and only the selected body can request its clip', async () => {
    const data = await mkdtemp(join(tmpdir(), 'tts-service-'));
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(36)]);
    const server = createServer((request, reply) => {
      expect(request.url).toBe('/v1/audio/speech');
      reply.writeHead(200, { 'content-type': 'audio/wav' }).end(wav);
    });
    let selected = true;
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const service = createTtsService({ dataDir: data, readKey: () => undefined, storeKey: () => {}, selected: () => selected });
      await service.save({ enabled: true, provider: 'openai', profile: { endpoint: `http://127.0.0.1:${port}/v1` } });
      const clip = service.stage('Testing playback')!;
      expect(clip).toBeTypeOf('string');
      selected = false;
      expect(await service.audio(clip)).toBeNull();
      selected = true;
      expect(await service.audio(clip)).toEqual({ mime: 'audio/wav', bytes: wav });
      service.report({ id: clip, status: 'started', duration: 1 });
      expect(service.remaining()).toBeGreaterThan(0);
      service.report({ id: clip, status: 'finished' });
      expect(service.remaining()).toBe(0);
      expect(await service.audio(clip)).toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(data, { recursive: true, force: true });
    }
  });

  it('acknowledges playback after the audio clock advances and releases its level when stopped', async () => {
    const node = { buffer: null, onended: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const context = { currentTime: 1, state: 'running', decodeAudioData: async () => ({ duration: 2 }), createBufferSource: () => node };
    const report = vi.fn(), level = vi.fn(), plan = vi.fn();
    const cues = [{ at: .5, duration: .5, face: 'happy' }];
    let resolvePlan!: (response: Response) => void;
    const speech = createMediaSpeech({
      audio: { speechOutput: () => ({ ctx: context, master: {} }) },
      read: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
      readPlan: () => new Promise<Response>(resolve => { resolvePlan = resolve; }),
      sampler: async () => () => .45,
      report, level, plan,
    });
    const clip = speech.play('clip', undefined, true);
    await vi.waitFor(() => expect(clip.state).toBe('scheduled'));
    speech.tick();
    expect(report).toHaveBeenCalledExactlyOnceWith({ id: 'clip', status: 'preparing' });
    expect(plan).not.toHaveBeenCalled();
    context.currentTime = 1.1;
    speech.tick();
    expect(report).toHaveBeenCalledWith({ id: 'clip', status: 'started', duration: 2 });
    expect(level).toHaveBeenCalledWith(.45);
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ kind: 'start', id: 'clip', duration: 2, cues: [] }));
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ kind: 'advance', id: 'clip' }));
    resolvePlan(Response.json(cues));
    await vi.waitFor(() => expect(clip.cues).toEqual(cues));
    context.currentTime = 1.2;
    speech.tick();
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cues', id: 'clip', cues }));
    speech.stop('body-changed');
    expect(node.disconnect).toHaveBeenCalledOnce();
    expect(level).toHaveBeenLastCalledWith(null);
    expect(plan).toHaveBeenLastCalledWith({ kind: 'stop', id: 'clip' });
    expect(report).toHaveBeenLastCalledWith({ id: 'clip', status: 'cancelled', reason: 'body-changed' });
  });

  it('releases the text fallback if the audio context stays suspended', async () => {
    vi.useFakeTimers();
    try {
      const context = {
        state: 'suspended',
        decodeAudioData: async () => ({ duration: 2 }),
        resume: vi.fn(() => new Promise<void>(() => {})),
      };
      const report = vi.fn();
      const speech = createMediaSpeech({
        audio: { speechOutput: () => ({ ctx: context, master: {} }) },
        read: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
        sampler: async () => null,
        report,
      });
      const clip = speech.play('clip');
      await vi.advanceTimersByTimeAsync(0);
      expect(context.resume).toHaveBeenCalledOnce();
      expect(clip.state).toBe('preparing');
      await vi.advanceTimersByTimeAsync(12_000);
      expect(clip.state).toBe('failed');
      expect(clip.controller.signal.aborted).toBe(true);
      expect(report).toHaveBeenLastCalledWith({ id: 'clip', status: 'failed', reason: 'Speech preparation timed out' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses the two-stage SoulLink planner and keeps mouth and wardrobe channels out of its plan', async () => {
    let config: SpeechPlannerConfig = {};
    const usage = vi.fn();
    const planner = createSpeechPlanner({
      config: () => config, persist: patch => { config = { ...config, ...patch }; },
      secret: () => undefined, storeSecret: () => {}, reportUsage: usage,
    });
    const endpoint = 'http://127.0.0.1:18081/v1';
    const service = { provider: 'custom', endpoint, model: 'test-planner', select: true };
    await planner.invoke('audio.savePlanner', [service]);
    await planner.invoke('audio.configurePlanner', [true]);
    expect(planner.state().ready).toBe(true);
    const calls: Array<Record<string, unknown>> = [];
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      const prompt = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content);
      calls.push(prompt);
      const times = Array.from({ length: prompt.frameCount }, (_, index) => index);
      const content = prompt.motionPlan
        ? { parameterPlan: times.map(time => ({ time, duration: 1, parameters: { ParamAngleX: .6, ParamMouthOpenY: .5, ParamCustom: .9 } })) }
        : { motionPlan: times.map(frameIndex => ({ frameIndex, action: 'nod' })) };
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 18, completion_tokens: 10 } });
    });
    try {
      const resources = [
        { id: 'move', title: 'Nod', kind: 'motion', classification: 'motion', seconds: 1,
          parameters: [{ id: 'ParamAngleX' }, { id: 'ParamMouthOpenY' }, { id: 'ParamCustom' }] },
        { id: 'wear', title: 'Accessory', kind: 'expression', classification: 'appearance', seconds: 0,
          parameters: [{ id: 'ParamCustom' }] },
      ];
      const plan = await planner.plan('请看这里', 'happy', resources, {}, AbortSignal.timeout(1000)) as Array<{ pose: Record<string, number> }>;
      expect(calls).toHaveLength(2);
      expect(JSON.stringify(calls)).not.toMatch(/ParamMouthOpenY|ParamCustom/);
      expect(plan.length).toBeGreaterThan(0);
      expect(plan.every(cue => Object.keys(cue.pose).join(',') === 'ParamAngleX')).toBe(true);
      expect(planner.state().last?.status).toBe('planned');
      await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(2));
      await planner.invoke('audio.configurePlanner', [false]);
      expect(await planner.plan('请看这里', 'happy', resources, {}, AbortSignal.timeout(1000))).toBeUndefined();
      expect(calls).toHaveLength(2);
    } finally { network.mockRestore(); }
  });

});
