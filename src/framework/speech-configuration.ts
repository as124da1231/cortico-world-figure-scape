import { speechFor, SPEECH_LEVELS, SPEECH_PITCH_MIN, SPEECH_PITCH_MAX, SPEECH_RATE_MIN, SPEECH_RATE_MAX, type SpeechSettings } from '../config.ts';

/** Configuration of the existing syllable player. Does not claim TTS or waveform lip sync. */
export function createSpeechConfiguration(adapter: {
  read: () => SpeechSettings;
  persist: (patch: { speech: SpeechSettings }) => void;
  apply: () => void;
}) {
  const fields = [
    { key: 'enabled', type: 'boolean' },
    { key: 'pitch', type: 'enum', options: [...SPEECH_LEVELS] },
    { key: 'pitchHz', type: 'number', min: SPEECH_PITCH_MIN, max: SPEECH_PITCH_MAX, enabledWhen: { pitch: 'custom' } },
    { key: 'speed', type: 'enum', options: [...SPEECH_LEVELS] },
    { key: 'unitsPerSecond', type: 'number', min: SPEECH_RATE_MIN, max: SPEECH_RATE_MAX, enabledWhen: { speed: 'custom' } },
  ].map(field => ({ ...field, owner: 'speech', writableBy: 'user' }));
  return {
    effective: () => speechFor(adapter.read()),
    read(observed: unknown = null) {
      return { fields, desired: { ...adapter.read() }, effective: speechFor(adapter.read()), observed,
        capability: { implementation: 'coo-syllable', mode: 'syllable-pulse', waveformLipSync: false, mediaTimeline: false } };
    },
    patch(raw: unknown) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('speech must be an object');
      const patch = raw as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        const field = fields.find(field => field.key === key);
        if (!field || (field.type === 'boolean' ? typeof value !== 'boolean' : field.type === 'enum'
          ? typeof value !== 'string' || !field.options!.includes(value as typeof SPEECH_LEVELS[number])
          : typeof value !== 'number' || !Number.isFinite(value) || value < field.min! || value > field.max!)) {
          throw new TypeError(`Invalid speech setting: ${key}`);
        }
      }
      if (Object.keys(patch).length) {
        adapter.persist({ speech: { ...adapter.read(), ...patch } });
        adapter.apply();
      }
      return this.read();
    },
  };
}
