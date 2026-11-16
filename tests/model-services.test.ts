import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createModelServices } from '../src/framework/model-services.ts';
import { createTtsService } from '../src/speech/tts-service.ts';
import type { TranscriptionApiOptions } from '../src/asr/transcription-api.ts';

const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const folder of folders.splice(0)) await rm(folder,{recursive:true,force:true});
});
async function fixture() {
  const directory = await mkdtemp(resolve('.model-services-test-'));
  folders.push(directory);
  const keys = new Map<string,string>();
  const ports = {
    directory,
    secret: (name:string) => keys.get(name),
    storeSecret: (name:string,value:string) => { keys.set(name,value); },
    voiceProfile: () => ({}),
    changed: vi.fn(),
    transcription: {language: () => 'auto', timeoutMs: () => 500, log: {warn:vi.fn()} as unknown as TranscriptionApiOptions['log']},
  };
  return { directory, ports, service:createModelServices(ports) };
}

it('migrates Live2D settings once, shares a provider and keeps the selected purposes on reload', async () => {
  const { directory, ports, service } = await fixture();
  const common = {name:'QA',protocol:'openai-compatible',endpoint:'https://example.test/v1',key:'fixture-only-key',active:true};
  await service.load(() => [
    {...common,use:'tts',model:'voice'},
    {...common,use:'planner',model:'reason'},
    {...common,use:'asr',model:'transcribe'},
  ]);
  expect(service.state().providers).toHaveLength(1);
  expect(service.state().models).toHaveLength(3);
  expect(service.resolve('planner')).toMatchObject({model:'reason',key:common.key});
  expect(JSON.stringify(service.state())).not.toContain(common.key);
  expect(await readFile(resolve(directory,'model-services.json'),'utf8')).not.toContain(common.key);
  const reloaded=createModelServices(ports);
  await reloaded.load(() => {throw Error('Migration ran again');});
  expect(reloaded.resolve('tts')?.profile.model).toBe('voice');
  expect(reloaded.resolve('asr')?.model).toBe('transcribe');
});

it('filters purposes and scopes saved credentials to the provider origin', async () => {
  const { service } = await fixture();
  await service.load(() => []);
  await service.invoke('services.saveProvider',[{name:'QA',protocol:'openai-compatible',endpoint:'https://one.test/v1',key:'fixture-only-key'}]);
  const provider=service.state().providers[0];
  await service.invoke('services.saveModel',[{providerId:provider.id,model:'word',uses:['planner']}]);
  const model=service.state().models[0];
  await expect(service.invoke('services.select',['tts',model.id])).rejects.toThrow('用途');
  await service.invoke('services.select',['planner',model.id]);
  await expect(service.invoke('services.removeModel',[model.id])).rejects.toThrow('正在使用');
  await service.invoke('services.saveProvider',[{...provider,endpoint:'https://two.test/v1'}]);
  expect(service.resolve('planner')?.key).toBe('');
  expect(service.state().providers[0].hasKey).toBe(false);
  await service.invoke('services.select',['planner',null]);
  expect(service.resolve('planner')).toBeNull();
  await service.invoke('services.removeModel',[model.id]);
  await service.invoke('services.removeProvider',[provider.id]);
  expect(service.state().providers).toEqual([]);
});

it('uses the existing adapter to list and test models and leaves bindings unchanged on failure', async () => {
  const { service } = await fixture();
  await service.load(() => [{name:'QA',protocol:'openai-compatible',endpoint:'https://example.test/v1',key:'fixture-only-key',active:true,use:'planner',model:'chat'}]);
  const [provider] = service.state().providers;
  const [model] = service.state().models;
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({data:[{id:'chat'},{id:'alternate'}]}))
    .mockResolvedValueOnce(Response.json({choices:[{message:{content:'{"action":"nod"}'}}]}))
    .mockResolvedValueOnce(Response.json({}, {status:401}));
  vi.stubGlobal('fetch',fetcher);
  expect(await service.invoke('services.discover',[provider.id])).toEqual(['alternate','chat']);
  expect(await service.invoke('services.test',[model.id,'planner'])).toMatchObject({ok:true});
  expect(await service.invoke('services.test',[model.id,'planner'])).toMatchObject({ok:false});
  expect(service.state().selected.planner).toBe(model.id);
  expect(fetcher.mock.calls[0][0]).toBe('https://example.test/v1/models');
});

it('previews local GPT-SoVITS before selecting it and uses the same WAV adapter for speech', async () => {
  const { directory, ports } = await fixture();
  let services: ReturnType<typeof createModelServices>;
  const tts = createTtsService({
    dataDir: directory, readKey: () => undefined, storeKey: vi.fn(),
    selected: () => true, activeService: () => services.resolve('tts'),
  });
  services = createModelServices({ ...ports, voiceProfile: provider => tts.voiceProfile(provider) });
  const preset = services.state().protocols.find(protocol => protocol.id === 'tts:sovitsLocal')!;
  expect(preset).toMatchObject({ endpoint: 'http://127.0.0.1:9880', modelDefault: true, acceptsKey: false, uses: ['tts'] });
  await services.invoke('services.saveProvider', [{
    name: preset.name, protocol: preset.id, endpoint: 'http://127.0.0.1:9880/audio/speech', key: 'unused-test-key',
  }]);
  const [model] = services.state().models;
  expect(model).toMatchObject({ model: '', uses: ['tts'] });
  expect(services.state().providers[0].hasKey).toBe(false);

  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(36)]);
  const request = vi.fn(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(init.redirect).toBe('error');
    return new Response(wav, { headers: { 'content-type': 'audio/wav' } });
  });
  vi.stubGlobal('fetch', request);
  expect(await services.invoke('services.previewLocalVoice', [model.id, '先试听'])).toEqual({
    $binary: { mime: 'audio/wav', base64: wav.toString('base64') },
  });
  expect(services.resolve('tts')).toBeUndefined();
  expect(JSON.parse(String(request.mock.calls[0][1].body))).toEqual({
    model: 'gpt-sovits', input: '先试听', voice: '', response_format: 'wav', speed: 1,
  });

  await services.invoke('services.select', ['tts', model.id]);
  await tts.save({ provider: 'sovitsLocal', enabled: true, profile: { voice: '示例音色', speed: 1.25 } });
  const clip = tts.stage('正式朗读')!;
  expect(await tts.audio(clip)).toEqual({ bytes: wav, mime: 'audio/wav' });
  expect(JSON.parse(String(request.mock.calls[1][1].body))).toMatchObject({
    input: '正式朗读', voice: '示例音色', speed: 1.25,
  });
  expect(request.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('http://127.0.0.1:9880/audio/speech'));

  request.mockResolvedValueOnce(Response.json({ error: 'model unavailable' }, { status: 503 }));
  expect(await services.invoke('services.test', [model.id, 'tts'])).toMatchObject({ ok: false, message: expect.stringContaining('503') });
  expect(services.state().selected.tts).toBe(model.id);
  const restored = createModelServices(ports);
  await restored.load(() => []);
  expect(restored.resolve('tts')?.provider).toBe('sovitsLocal');
});
