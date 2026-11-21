/** A media clip shares the desktop audio output and the actual Web Audio clock. */
export function createMediaSpeech({ audio, report = () => {}, level = () => {}, plan = () => {},
  read = (id, signal) => fetch('/api/speech/clip/' + encodeURIComponent(id), { signal, cache: 'no-store' }),
  readPlan = (id, signal) => fetch('/api/speech/clip/' + encodeURIComponent(id) + '?part=plan', { signal, cache: 'no-store' }),
  sampler = () => import('/model-runtime/backends/voice-playback.js').then(module => module.voiceLevel).catch(() => null),
}) {
  let active = null, latest = null;
  function finish(clip, status, reason) {
    if (active !== clip) return;
    active = null;
    clearTimeout(clip.preparation);
    clip.controller.abort();
    if (clip.node) {
      clip.node.onended = null;
      try { clip.node.stop(); } catch { /* already ended */ }
      clip.node.disconnect();
    }
    clip.state = status;
    latest = { id: clip.id, status, ...(reason ? { reason } : {}) };
    level(null);
    if (clip.started) plan({ kind: 'stop', id: clip.id });
    report(latest);
  }
  return {
    play(id, cues, wantsPlan = false, face, offset = 0) {
      if (active) finish(active, 'cancelled', 'replaced');
      const clip = { id, cues, face, offset, state: 'preparing', controller: new AbortController(), position: offset, duration: 0 };
      active = clip;
      clip.preparation = setTimeout(() => finish(clip, 'failed', 'Speech preparation timed out'), 12_000);
      latest = { id, status: 'preparing' };
      report(latest);
      if (wantsPlan && !cues?.length) {
        void (async () => {
          const response = await readPlan(id, clip.controller.signal);
          if (!response.ok) return;
          const next = await response.json();
          if (active === clip && Array.isArray(next) && next.length) {
            clip.cues = next;
            clip.cuesChanged = true;
          }
        })().catch(() => {});
      }
      void (async () => {
        const output = audio.speechOutput();
        if (!output) throw Error('Desktop audio is unavailable');
        const signal = clip.controller.signal;
        const response = await read(id, signal);
        if (!response.ok) throw Error('Speech synthesis failed');
        const bytes = await response.arrayBuffer();
        const [buffer, sample] = await Promise.all([output.ctx.decodeAudioData(bytes), sampler()]);
        signal.throwIfAborted();
        if (active !== clip) return;
        if (output.ctx.state === 'suspended') await output.ctx.resume();
        signal.throwIfAborted();
        if (active !== clip) return;
        if (output.ctx.state !== 'running' || !buffer.duration || buffer.duration > 120) throw Error('Speech audio cannot play');
        if (offset >= buffer.duration) {
          clip.position = clip.duration = buffer.duration;
          finish(clip, 'finished');
          return;
        }
        const node = output.ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(output.master);
        clip.node = node; clip.context = output.ctx; clip.sample = sample;
        clip.duration = buffer.duration; clip.start = output.ctx.currentTime - offset;
        node.onended = () => {
          if (clip.state === 'scheduled') markStarted(clip);
          finish(clip, 'finished');
        };
        if (offset) node.start(clip.start + offset, offset);
        else node.start(clip.start);
        clip.state = 'scheduled';
      })().catch(error => finish(clip, 'failed', error?.message ?? String(error)));
      return clip;
    },
    tick() {
      if (!active?.context || active.context.state !== 'running') return;
      const clip = active;
      clip.position = Math.min(clip.duration, clip.context.currentTime - clip.start);
      if (clip.position <= 0) return;
      if (clip.state === 'scheduled') {
        markStarted(clip);
      } else if (clip.cuesChanged) {
        clip.cuesChanged = false;
        plan({ kind: 'cues', id: clip.id, position: clip.position, cues: clip.cues });
      }
      if (clip.position - (clip.lastSample ?? -1) >= .033) {
        clip.lastSample = clip.position;
        if (clip.sample) level(clip.sample(clip.node.buffer, clip.position));
        plan({ kind: 'advance', id: clip.id, position: clip.position });
      }
    },
    stop(reason = 'stopped') { if (active) finish(active, 'cancelled', reason); },
    take(id) {
      const clip = active;
      if (!clip || clip.id !== id) return null;
      const position = clip.context ? Math.min(clip.duration, Math.max(clip.position, clip.context.currentTime - clip.start)) : clip.position;
      finish(clip, 'paused', 'scene-handoff');
      return position;
    },
    snapshot: () => latest && { ...latest },
  };

  function markStarted(clip) {
    clearTimeout(clip.preparation);
    clip.state = 'started';
    clip.started = true;
    const seek = clip.offset ? { position: clip.offset } : {};
    latest = { id: clip.id, status: 'started', duration: clip.duration, ...seek };
    report(latest);
    plan({ kind: 'start', id: clip.id, duration: clip.duration, cues: clip.cues ?? [], face: clip.face, ...seek });
    clip.cuesChanged = false;
  }
}
