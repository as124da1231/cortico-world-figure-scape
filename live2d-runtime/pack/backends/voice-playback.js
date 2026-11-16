// DSH Live2D Body uses the same Web Audio output clock and 20 ms RMS sampling.
export function voiceLevel(buffer, position) {
  if (position < 0 || position >= buffer.duration) return 0;
  const first = Math.floor(position * buffer.sampleRate);
  const last = Math.min(buffer.length, first + Math.ceil(buffer.sampleRate * 0.02));
  let energy = 0, count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let index = first; index < last; index += 4) {
      energy += samples[index] ** 2;
      count++;
    }
  }
  return count ? Math.min(1, Math.sqrt(energy / count) * 4.2) : 0;
}

const MOUTH_NOISE_FLOOR = 0.035;
const MOUTH_ATTACK = 0.045;
const MOUTH_RELEASE = 0.13;

/** Follow measured audio, then hand the mouth back to the model's current pose. */
export function createVoiceMouthEnvelope() {
  let open = 0, ownership = 0;
  return {
    update(level, gain, dt) {
      if (Number.isFinite(level)) {
        const target = Math.max(0, (Math.min(1, level) - MOUTH_NOISE_FLOOR) / (1 - MOUTH_NOISE_FLOOR));
        const time = target > open ? MOUTH_ATTACK : MOUTH_RELEASE;
        const blend = -Math.expm1(-dt / time);
        open += (target - open) * blend;
        ownership = Math.min(1, ownership + dt / MOUTH_ATTACK);
      } else {
        ownership = Math.max(0, ownership - dt / MOUTH_RELEASE);
        if (ownership === 0) {
          open = 0;
          return null;
        }
      }
      return {
        open: Math.max(0, Math.min(1, open * gain)),
        weight: ownership ** 2 * (3 - 2 * ownership),
      };
    },
  };
}
