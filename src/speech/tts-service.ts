import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// @ts-expect-error Figure's existing voice provider adapters.
import { audioMime, needsVoiceKey, normalizeVoiceProfile, providerSpec, synthesizeVoice, voiceMissingFields } from './tts/voice-providers.mjs';
// @ts-expect-error Figure's existing provider catalogue.
import { VOICE_PROVIDERS } from './tts/voice-catalog.mjs';

type Profile = Record<string, string | number>;
interface VoiceSettings { enabled: boolean; provider: string; profiles: Record<string, Profile> }
interface Clip {
  id: string; expires: number; text: string; provider: string; profile: Profile;
  controller: AbortController;
  key?: string;
  plan?: (signal: AbortSignal) => Promise<unknown[] | undefined>;
  audio?: Promise<{ bytes: Buffer; mime: string }>;
  planned?: Promise<unknown[] | undefined>;
}
const EMPTY: VoiceSettings = { enabled: false, provider: 'openai', profiles: {} };
const CLIP_LIFETIME = 5 * 60_000;

export function createTtsService(ports: {
  dataDir: string;
  readKey: (provider: string) => string | undefined;
  storeKey: (provider: string, key: string) => void;
  selected: () => boolean;
  activeService?: () => { provider: string; profile: Profile; key: string } | null | undefined;
}) {
  const directory = join(ports.dataDir, 'desktop-live2d-pet');
  const file = join(directory, 'tts.json');
  let settings: VoiceSettings = structuredClone(EMPTY);
  let writing = false;
  const clips = new Map<string, Clip>();
  let playback: { id: string; status: string; duration?: number; startedAt?: number; reason?: string } | null = null;

  function stop(id: string) {
    const clip = clips.get(id);
    if (!clip) return;
    clips.delete(id);
    clip.controller.abort();
  }
  function stopAll() {
    for (const id of clips.keys()) stop(id);
    if (playback?.status === 'started' || playback?.status === 'preparing') playback = { ...playback, status: 'cancelled' };
  }
  const state = () => {
    const active = ports.activeService?.();
    const provider = active?.provider ?? settings.provider;
    return { ...structuredClone(settings), provider, providers: VOICE_PROVIDERS,
      hasKey: Boolean(active ? active.key : ports.readKey(provider)), playback: playback && { ...playback } };
  };

  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8'));
        providerSpec(raw.provider);
        const profiles = Object.fromEntries(Object.entries(raw.profiles ?? {}).map(([id, value]) => [id, normalizeVoiceProfile(id, value)]));
        settings = { enabled: raw.enabled === true, provider: raw.provider, profiles };
      } catch { settings = structuredClone(EMPTY); }
    },
    state,
    savedSettings: () => structuredClone(settings),
    voiceProfile: (provider: string) => ({ ...settings.profiles[provider] }),
    async save(raw: unknown) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid voice settings');
      if (writing) throw Error('Voice settings are already being saved');
      const value = raw as Record<string, unknown>;
      const provider = typeof value.provider === 'string' ? value.provider : settings.provider;
      providerSpec(provider);
      const profile = normalizeVoiceProfile(provider, value.profile ?? settings.profiles[provider] ?? {});
      if (value.key !== undefined && (typeof value.key !== 'string' || value.key.length > 4096)) throw Error('Invalid voice key');
      const next = { enabled: value.enabled === undefined ? settings.enabled : value.enabled === true, provider,
        profiles: { ...settings.profiles, [provider]: profile } };
      writing = true;
      const staging = file + '.' + randomUUID() + '.tmp';
      try {
        await mkdir(directory, { recursive: true });
        if (typeof value.key === 'string' && value.key.trim()) ports.storeKey(provider, value.key.trim());
        await writeFile(staging, JSON.stringify(next), { flag: 'wx' });
        await rename(staging, file);
        settings = next;
        return state();
      } finally {
        writing = false;
        await rm(staging, { force: true }).catch(() => {});
      }
    },
    stage(text: string, audition = false, plan?: Clip['plan']) {
      if ((!settings.enabled && !audition) || !ports.selected() || !text.trim() || text.length > 1500) return null;
      const active = ports.activeService?.();
      if (active === null) return null;
      const provider = active?.provider ?? settings.provider;
      const profile = active?.profile ?? settings.profiles[provider] ?? normalizeVoiceProfile(provider, {});
      const key = active ? active.key : ports.readKey(provider);
      if (voiceMissingFields(provider, profile).length || (needsVoiceKey(provider, profile) && !key)) return null;
      for (const clip of clips.values()) if (clip.expires < Date.now()) stop(clip.id);
      if (clips.size >= 32) return null;
      const id = randomUUID();
      clips.set(id, { id, text, provider, profile, key, plan, expires: Date.now() + CLIP_LIFETIME, controller: new AbortController() });
      return id;
    },
    async audio(id: string) {
      const clip = clips.get(id);
      if (!clip || !ports.selected() || clip.expires < Date.now()) return null;
      if (clip.audio) return clip.audio;
      const signal = clip.controller.signal;
      const synthesis: Promise<Uint8Array> = synthesizeVoice(clip.provider, clip.profile, clip.key, clip.text, { signal });
      const task: NonNullable<Clip['audio']> = synthesis
        .then(data => {
          signal.throwIfAborted();
          const bytes = Buffer.from(data), mime = audioMime(bytes);
          if (!mime) throw Error('Unsupported speech audio format');
          return { bytes, mime };
        });
      clip.audio = task;
      return task;
    },
    async plan(id: string) {
      const clip = clips.get(id);
      if (!clip?.plan || !ports.selected() || clip.expires < Date.now()) return null;
      const signal = AbortSignal.any([clip.controller.signal, AbortSignal.timeout(5000)]);
      clip.planned ??= Promise.resolve().then(() => clip.plan?.(signal)).catch(() => undefined);
      const cues = await clip.planned;
      return !signal.aborted && clips.get(id) === clip && ports.selected() ? cues ?? [] : null;
    },
    report(message: Record<string, unknown>) {
      const id = typeof message.id === 'string' ? message.id : '';
      if (!clips.has(id)) return;
      const status = message.status;
      if (status === 'preparing') {
        playback = { id, status, duration: 12, startedAt: Date.now() };
      } else if (status === 'started' && Number.isFinite(message.duration) && (message.duration as number) > 0) {
        playback = { id, status, duration: Math.min(message.duration as number, 120), startedAt: Date.now() };
      } else if (status === 'finished' || status === 'failed' || status === 'cancelled') {
        playback = { id, status, ...(typeof message.reason === 'string' ? { reason: message.reason.slice(0, 200) } : {}) };
        stop(id);
      }
    },
    remaining() {
      return playback && (playback.status === 'started' || playback.status === 'preparing') ? Math.max(0, (playback.duration ?? 0) * 1000 - (Date.now() - (playback.startedAt ?? 0))) : 0;
    },
    stopAll,
    stop,
  };
}
