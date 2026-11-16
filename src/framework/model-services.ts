import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PlannerServices, plannerEndpoint } from '../speech/planner/planner-services.ts';
import { TranscriptionApi } from '../asr/transcription-api.ts';
import type { TranscriptionApiOptions } from '../asr/transcription-api.ts';
// @ts-expect-error Existing Figure adapters and field definitions.
import { audioMime, normalizeVoiceProfile, needsVoiceKey, voiceMissingFields, synthesizeVoice } from '../speech/tts/voice-providers.mjs';
// @ts-expect-error Existing adapter catalogue.
import { VOICE_PROVIDERS } from '../speech/tts/voice-catalog.mjs';
// @ts-expect-error Existing adapter catalogue.
import { PLANNER_PROVIDERS } from '../speech/planner/planner-catalog.mjs';

export const modelUses = ['planner', 'tts', 'asr'] as const;
export type ModelUse = typeof modelUses[number];
type Fields = Record<string, string | number>;
type Provider = { id: string; name: string; protocol: string; endpoint: string; fields: Fields };
type Model = { id: string; providerId: string; model: string; uses: ModelUse[] };
type Catalogue = { providers: Provider[]; models: Model[]; selected: Partial<Record<ModelUse, string | null>> };
type Connection = { provider: string; endpoint: string; model: string; profile: Fields; key: string };
type Receipt = { ok: boolean; elapsedMs: number; message?: string };
type Seed = { use: ModelUse; name: string; protocol: string; endpoint: string; model: string; fields?: Fields; key?: string; active?: boolean };
type Ports = {
  directory: string;
  secret(name: string): string | undefined;
  storeSecret(name: string, value: string): void;
  voiceProfile(provider: string): Fields;
  transcription: Omit<TranscriptionApiOptions, 'config' | 'key'>;
  changed(use: ModelUse): Promise<void> | void;
};

const empty = (): Catalogue => ({ providers: [], models: [], selected: {} });
const coreType = 'openai-compatible';
const localSovits = 'tts:sovitsLocal';
const specs = Object.fromEntries(Object.entries(VOICE_PROVIDERS).filter(([id]) => id !== 'openai').map(([id, value]) => [
  'tts:' + id, value,
])) as Record<string, { name: string; auth?: boolean | 'optional'; help?: string; helpEn?: string; fields: Array<{key: string; label: string; value: string | number; type?: string; required?: boolean}> }>;
const connectionFields = new Set(['region', 'appId', 'cluster', 'groupId', 'version', 'modelDir']);
const protocolOptions = [
  { id: coreType, name: 'OpenAI 兼容', uses: modelUses, fields: [] },
  ...Object.entries(PLANNER_PROVIDERS as Record<string, {name: string; endpoint: string; keyRequired: boolean}>)
    .filter(([id]) => id !== 'custom' && id !== 'openai')
    .map(([id, spec]) => ({ id: 'planner:' + id, ...spec, uses: ['planner'] as const, fields: [] })),
  ...Object.entries(specs).map(([id, spec]) => ({
    id, name: spec.name, uses: ['tts'] as const, fields: spec.fields.filter(field => connectionFields.has(field.key)),
    endpoint: spec.fields.find(field => field.key === 'endpoint')?.value,
    keyRequired: spec.auth === true,
    modelDefault: !spec.fields.some(field => field.key === 'model'),
    ...(id === localSovits ? { hint: spec.help, hintEn: spec.helpEn, acceptsKey: false } : {}),
  })),
];
const protocolOf = (id: unknown) => protocolOptions.find(item => item.id === id);

function data(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('配置无效');
  return raw as Record<string, unknown>;
}
function string(raw: unknown, max: number, name: string) {
  if (typeof raw !== 'string' || raw.length > max || /[\u0000-\u001f\u007f]/u.test(raw)) throw Error(name + '无效');
  return raw.trim();
}
function urlOf(raw: unknown, needed: boolean, protocol: string) {
  const value = string(raw ?? '', 2048, '服务地址');
  if (!value && !needed) return '';
  if (protocol.startsWith('planner:')) return plannerEndpoint(value);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('请输入无凭据和查询参数的服务地址');
  return value.replace(/\/+$/u, '');
}
function secretName(provider: Provider) {
  const origin = provider.endpoint ? new URL(provider.endpoint).origin : JSON.stringify(provider.fields);
  return  'SERVICE_' + createHash('sha256').update(provider.id + '|' + provider.protocol + '|' + origin).digest('hex').toUpperCase();
}
const testWave = (() => {
  const pcm = new Int16Array(8000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.floor(1100 * Math.sin(i / 16000 * 880 * Math.PI));
  return pcm;
})();

export function createModelServices(ports: Ports) {
  const file = join(ports.directory, 'model-services.json');
  let catalogue = empty();
  let queue: Promise<unknown> = Promise.resolve();
  const probes = new Map<string, Receipt>();

  const keyOf = (provider: Provider) => ports.secret(secretName(provider)) ?? '';
  const state = () => ({
    protocols: protocolOptions,
    providers: catalogue.providers.map(provider => ({ ...provider, hasKey: !!keyOf(provider) })),
    models: catalogue.models.map(model => ({ ...model, tests: Object.fromEntries(model.uses.map(use => [use, probes.get(model.id + ':' + use) ?? null])) })),
    selected: { ...catalogue.selected },
  });
  function providerById(id: unknown, source = catalogue) {
    const provider = source.providers.find(item => item.id === id);
    if (!provider) throw Error('找不到这个提供商，请重新选择');
    return provider;
  }
  function modelById(id: unknown, source = catalogue) {
    const model = source.models.find(item => item.id === id);
    if (!model) throw Error('找不到这个模型，请重新选择');
    return model;
  }
  async function write(next: Catalogue) {
    const temp = file + '.' + randomUUID() + '.tmp';
    await mkdir(ports.directory, { recursive: true });
    try {
      await writeFile(temp, JSON.stringify(next, null, 2), { flag: 'wx' });
      await rename(temp, file);
      catalogue = next;
    } finally { await rm(temp, { force: true }); }
  }
  function update(change: (next: Catalogue) => Promise<ModelUse[]> | ModelUse[]) {
    const task = queue.then(async () => {
      const next = structuredClone(catalogue);
      const uses = await change(next);
      await write(next);
      for (const use of new Set(uses)) await ports.changed(use);
      return state();
    });
    queue = task.catch(() => {});
    return task;
  }
  function settings(provider: Provider, model: Model, use: ModelUse): Connection {
    const adapter = provider.protocol.startsWith('tts:') ? provider.protocol.slice(4)
      : provider.protocol.startsWith('planner:') ? provider.protocol.slice(8) : 'openai';
    const profile = use === 'tts' ? normalizeVoiceProfile(adapter, {
      ...ports.voiceProfile(adapter), ...provider.fields,
      ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
      ...(model.model ? { model: model.model } : {}),
    }) as Fields : {};
    return { provider: adapter, endpoint: provider.endpoint, model: model.model, profile, key: provider.protocol === localSovits ? '' : keyOf(provider) };
  }
  function resolve(use: ModelUse): Connection | null | undefined {
    const id = catalogue.selected[use];
    if (id === undefined) return undefined;
    if (!id) return null;
    const model = modelById(id);
    return settings(providerById(model.providerId), model, use);
  }

  async function load(seeds: () => Seed[]) {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as Catalogue;
      if (!Array.isArray(saved.providers) || !Array.isArray(saved.models) || !saved.selected) throw Error('模型服务配置文件无效');
      catalogue = saved;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const next = empty();
    for (const seed of seeds()) {
      if (!protocolOf(seed.protocol)) continue;
      const fields = Object.fromEntries(Object.entries(seed.fields ?? {}).filter(([field]) => connectionFields.has(field)));
      let endpoint: string;
      try { endpoint = urlOf(seed.endpoint, false, seed.protocol); } catch { continue; }
      const matched = next.providers.find(provider => provider.protocol === seed.protocol && provider.endpoint === endpoint
        && JSON.stringify(provider.fields) === JSON.stringify(fields) && keyOf(provider) === (seed.key ?? ''));
      const provider = matched ?? { id: randomUUID(), name: seed.name, protocol: seed.protocol, endpoint, fields };
      if (!matched) {
        if (seed.key) ports.storeSecret(secretName(provider), seed.key);
        next.providers.push(provider);
      }
      let model = next.models.find(item => item.providerId === provider.id && item.model === seed.model);
      if (model) {
        if (!model.uses.includes(seed.use)) model.uses.push(seed.use);
      } else {
        model = { id: randomUUID(), providerId: provider.id, model: seed.model, uses: [seed.use] };
        next.models.push(model);
      }
      if (seed.active) next.selected[seed.use] = model.id;
    }
    if (next.providers.length) await write(next);
  }

  function planner(connection: Connection) {
    return new PlannerServices({ config: () => ({}), secret: () => connection.key });
  }
  function plannerInput(connection: Connection) {
    return { provider: connection.provider, endpoint: connection.endpoint, model: connection.model, key: connection.key };
  }
  async function discover(id: unknown) {
    const provider = providerById(id);
    if (provider.protocol !== coreType && !provider.protocol.startsWith('planner:')) {
      throw Error('这个服务未提供统一的模型列表，可手动添加');
    }
    const connection = settings(provider, { id: '', providerId: provider.id, model: '', uses: ['planner'] }, 'planner');
    return planner(connection).models(plannerInput(connection));
  }
  async function sampleVoice(connection: Connection, text: string, timeout: number = 12_000) {
    const missing = voiceMissingFields(connection.provider, connection.profile);
    if (missing.length) throw Error('请补齐语音参数：' + missing.join('、'));
    if (needsVoiceKey(connection.provider, connection.profile) && !connection.key) throw Error('请先填写 API 密钥');
    const sound = await synthesizeVoice(connection.provider, connection.profile, connection.key, text, { signal: AbortSignal.timeout(timeout) });
    if (!sound?.length) throw Error('服务没有返回试听音频');
    return Buffer.from(sound);
  }
  async function test(id: unknown, use: unknown) {
    const model = modelById(id);
    if (!model.uses.includes(use as ModelUse)) throw Error('模型不支持这个用途');
    const purpose = use as ModelUse;
    const connection = settings(providerById(model.providerId), model, purpose);
    const started = Date.now();
    let receipt: Receipt;
    try {
      if (purpose === 'planner') await planner(connection).test(plannerInput(connection));
      if (purpose === 'tts') {
        await sampleVoice(connection, '你好，我在这里。', connection.provider === 'sovitsLocal' ? 30_000 : 12_000);
      }
      if (purpose === 'asr') {
        const probe = new TranscriptionApi({ ...ports.transcription, config: () => ({baseUrl: connection.endpoint, model: connection.model}), key: () => connection.key });
        await probe.start();
        try {
          const result = await probe.transcribe(testWave);
          if (result.error) throw Error(result.error);
        } finally { await probe.stop(); }
      }
      receipt = { ok: true, elapsedMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      receipt = { ok: false, elapsedMs: Date.now() - started, message: (connection.key ? message.replaceAll(connection.key, '••••') : message).slice(0, 400) };
    }
    if (catalogue.models.includes(model)) probes.set(model.id + ':' + purpose, receipt);
    return receipt;
  }

  return { load, resolve, state, async selectLegacy(use: ModelUse, seed: Seed) {
    return update(next => {
      const endpoint = urlOf(seed.endpoint, true, seed.protocol);
      let provider = next.providers.find(item => item.protocol === seed.protocol && item.endpoint === endpoint);
      if (!provider) {
        provider = {id:randomUUID(), protocol:seed.protocol, endpoint, name:seed.name, fields:{}};
        next.providers.push(provider);
      }
      if (seed.key) ports.storeSecret(secretName(provider), seed.key);
      let model = next.models.find(item => item.providerId === provider!.id && item.model === seed.model);
      if (!model) { model = {id:randomUUID(),providerId:provider.id,model:seed.model,uses:[]}; next.models.push(model); }
      if (!model.uses.includes(use)) model.uses.push(use);
      next.selected[use] = model.id;
      return [use];
    });
  }, async invoke(method: string, args: unknown[]) {
    switch (method) {
      case 'services.state': return state();
      case 'services.discover': return discover(args[0]);
      case 'services.test': return test(args[0], args[1]);
      case 'services.previewLocalVoice': {
        const model = modelById(args[0]);
        const provider = providerById(model.providerId);
        if (provider.protocol !== localSovits || !model.uses.includes('tts')) throw Error('请选择本机 GPT-SoVITS 语音服务');
        const text = string(args[1] ?? '', 300, '试听文本');
        if (!text) throw Error('请填写试听文本');
        const sound = await sampleVoice(settings(provider, model, 'tts'), text, 32_000);
        return { $binary: { mime: audioMime(sound), base64: sound.toString('base64') } };
      }
      case 'services.saveProvider': return update(next => {
        const input = data(args[0]), previous = input.id ? providerById(input.id, next) : undefined;
        const protocol = protocolOf(input.protocol);
        if (!protocol || (previous && previous.protocol !== protocol.id)) throw Error('请选择可用的接口类型');
        const name = string(input.name, 96, '提供商名称');
        if (!name) throw Error('请填写提供商名称');
        const fields = Object.fromEntries(protocol.fields.map(field => {
          const values = input.fields && typeof input.fields === 'object' ? data(input.fields) : {};
          return [field.key, string(String(values[field.key] ?? field.value), 1024, field.label)];
        }));
        const endpoint = urlOf(input.endpoint, protocol.id === coreType || ('endpoint' in protocol && Boolean(protocol.endpoint)), protocol.id);
        const provider = { id: previous?.id ?? randomUUID(), name, protocol: protocol.id, endpoint, fields };
        const key = string(input.key ?? '', 4096, 'API 密钥');
        if (key && provider.protocol !== localSovits) ports.storeSecret(secretName(provider), key);
        next.providers = [...next.providers.filter(item => item.id !== provider.id), provider];
        if (!previous && provider.protocol === localSovits) {
          next.models.push({ id: randomUUID(), providerId: provider.id, model: '', uses: ['tts'] });
        }
        const models = next.models.filter(model => model.providerId === provider.id);
        for (const model of models) for (const use of model.uses) probes.delete(model.id + ':' + use);
        return modelUses.filter(use => models.some(model => model.id === next.selected[use]));
      });
      case 'services.removeProvider': return update(next => {
        const provider = providerById(args[0], next);
        if (next.models.some(model => model.providerId === provider.id)) throw Error('请先移除这个提供商下的模型');
        next.providers = next.providers.filter(item => item.id !== provider.id);
        return [];
      });
      case 'services.saveModel': return update(next => {
        const input = data(args[0]), provider = providerById(input.providerId, next);
        const previous = input.id ? modelById(input.id, next) : undefined;
        if (previous && previous.providerId !== provider.id) throw Error('模型所属提供商无法更换');
        const spec = protocolOf(provider.protocol)!;
        const model = 'modelDefault' in spec && spec.modelDefault ? '' : string(input.model, 240, '模型 ID');
        if (!model && !('modelDefault' in spec && spec.modelDefault)) throw Error('请填写模型 ID');
        const requestedUses = Array.isArray(input.uses) ? input.uses : [];
        const uses = modelUses.filter(use => requestedUses.includes(use) && (spec.uses as readonly string[]).includes(use));
        if (!uses.length) throw Error('请选择模型支持的用途');
        if (next.models.some(item => item.id !== previous?.id && item.providerId === provider.id && item.model === model)) throw Error('这个提供商下已添加同名模型');
        const id = previous?.id ?? randomUUID();
        const selected = modelUses.filter(use => next.selected[use] === id);
        if (selected.some(use => !uses.includes(use))) throw Error('请先在对应功能中替换或解除模型绑定');
        next.models = [...next.models.filter(item => item.id !== id), { id, providerId: provider.id, model, uses }];
        for (const use of modelUses) probes.delete(id + ':' + use);
        return selected;
      });
      case 'services.removeModel': return update(next => {
        const model = modelById(args[0], next);
        if (modelUses.some(use => next.selected[use] === model.id)) throw Error('模型正在使用，请先替换或解除绑定');
        next.models = next.models.filter(item => item.id !== model.id);
        for (const use of modelUses) probes.delete(model.id + ':' + use);
        return [];
      });
      case 'services.select': return update(next => {
        const use = modelUses.find(value => value === args[0]);
        if (!use) throw Error('未知服务用途');
        const id = args[1];
        if (id !== null && !modelById(id, next).uses.includes(use)) throw Error('模型不支持这个用途');
        next.selected[use] = id as string | null;
        return [use];
      });
      default: throw Error('未知模型服务操作');
    }
  } };
}
