import { createMediaSpeech } from './media-speech.js';

/** Coordinates each utterance's audio, presentation progress and body contribution. */
export function createSpeechPresentation({ audio, onUnit, onRelease, bodySpeech, onMediaLevel, onMediaReport, onMediaPlan, createPlayer = createMediaSpeech }) {
  let current = null, disposed = false, lastPreview = null;
  const media = createPlayer({ audio, level: onMediaLevel, report: onMediaReport, plan: onMediaPlan });

  function stop(reason = 'stopped') {
    media.stop(reason);
    current = null;
    onRelease?.();
  }

  return {
    start(owner, { clip, cues, wantsPlan, face, text, offset }) {
      if (disposed) return;
      stop('replaced');
      const boundaries = [];
      let end = 0;
      for (const character of text) boundaries.push(end += character.length);
      current = { owner, boundaries, clip: clip ? media.play(clip, cues, wantsPlan, face, offset) : null };
    },
    take(owner) {
      const clip = current?.owner === owner ? current.clip : null;
      const position = clip ? media.take(clip.id) : null;
      current = null;
      onRelease?.();
      return position;
    },
    position(owner) {
      const clip = current?.owner === owner ? current.clip : null;
      return clip && ['preparing', 'scheduled', 'started'].includes(clip.state) ? clip.position : null;
    },
    progress(owner) {
      if (current?.owner !== owner) return { mode: 'text' };
      const { clip, boundaries } = current;
      if (!clip || clip.state === 'failed' || clip.state === 'cancelled') return { mode: 'text' };
      if (clip.state === 'preparing' || clip.state === 'scheduled') return { mode: 'waiting' };
      const done = clip.state === 'finished';
      const count = done ? boundaries.length : Math.ceil(boundaries.length * Math.min(1, clip.position / clip.duration));
      return { mode: 'audio', shown: boundaries[count - 1] ?? 0, done };
    },
    preview(kind, requestId) {
      if (disposed || ['preparing', 'started'].includes(media.snapshot()?.status)) return;
      if (kind === 'pulse') onUnit?.({ source: 'preview', clock: 'command' });
      else if (kind === 'release') onRelease?.();
      else throw new TypeError('Unknown speech contribution command');
      lastPreview = { requestId, kind };
    },
    audition(id) { if (!disposed) { stop('replaced'); media.play(id); } },
    tick: media.tick,
    stop,
    snapshot() {
      const body = bodySpeech?.();
      return { implementation: 'speech-playback', status: disposed ? 'disposed' : 'mounted', mode: 'audio-clock',
        capabilities: { mouthPulse: true, amplitudeStream: body?.supported?.level === true, seekableMediaClock: true,
          immediateMouthReset: false, releaseSpeechContribution: body?.supported?.release === true },
        media: media.snapshot(), body, lastPreview: lastPreview && { ...lastPreview } };
    },
    dispose() { if (!disposed) { stop('disposed'); disposed = true; } },
  };
}
