import { ParameterPlanSequencer } from '../vendor/soullink/chunk-OPVA6SRP.js';
import { createNativeActions } from './native-actions.js';
import { PERFORMANCE_FACES, parsePerformanceCues } from './performance-plan.js';

const bounded = (value, min, max) => Math.max(min, Math.min(max, value));
class QuietSequencer extends ParameterPlanSequencer {
  logActiveBeatChange() {}
}

export function createPerformancePlayback({ model, paramIndex, protectedIds }) {
  let active, disposed = false;
  const used = new Map();
  const accepted = id => paramIndex.has(id) && !protectedIds.has(id);
  function collect(order) {
    if (disposed || !order || used.has(order.ticket) || order.expiresAt <= Date.now()) return false;
    const speechMs = Number.isFinite(order.speechMs) && order.speechMs > 0 && order.speechMs <= 18000 ? order.speechMs : 0;
    let cues, beats, clips;
    if (Array.isArray(order.beats)) {
      beats = order.beats.slice(0, 24).flatMap(beat => {
        if (!beat || !Number.isFinite(beat.time) || !Number.isFinite(beat.duration) || beat.time < 0 || beat.duration <= 0 || beat.time + beat.duration > 18) return [];
        const entries = Object.entries(beat.parameters ?? {}).slice(0, 96).filter(([id,value]) => accepted(id) && Number.isFinite(value) && value >= -1 && value <= 1);
        return entries.length ? [{ time: beat.time, duration: beat.duration, parameters: Object.fromEntries(entries) }] : [];
      });
      if (!beats.length) return false;
    } else if (order.cues?.length) {
      cues = parsePerformanceCues(order.cues);
      if (cues.some(cue => cue.pose && Object.keys(cue.pose).some(id => !accepted(id)))) return false;
      if (cues.some(cue => cue.resource)) {
        clips = createNativeActions({ bindings: [], resources: Array.isArray(order.resources) ? order.resources : [] });
        const available = clips.resources();
        if (cues.some(cue => cue.resource && !available.includes(cue.resource))) return false;
      }
    } else if (!speechMs) return false;
    used.set(order.ticket, order.expiresAt);
    const activated = Date.now() / 1000;
    const start = order.startedAt ? order.startedAt / 1000 : activated;
    const duration = beats ? Math.max(...beats.map(beat => beat.time + beat.duration))
      : Math.max(speechMs / 1000, ...(cues ?? []).map(cue => cue.at + cue.duration));
    active = { start, activated, duration, cues, beats, clips, face: order.face, speechMs, until: order.expiresAt };
    return true;
  }
  const normalized = id => {
    const index = paramIndex.get(id);
    const baseline = model.getParameterDefaultValue(index);
    const current = model.getParameterValueByIndex(index);
    const span = current >= baseline ? model.getParameterMaximumValue(index) - baseline : baseline - model.getParameterMinimumValue(index);
    return span > 0 ? bounded((current - baseline) / span, -1, 1) : 0;
  };
  const toTrack = ([id, value], weight) => {
    const index = paramIndex.get(id);
    const baseline = model.getParameterDefaultValue(index);
    const span = value >= 0 ? model.getParameterMaximumValue(index) - baseline : baseline - model.getParameterMinimumValue(index);
    return { id, target: 'Parameter', blend: 'Overwrite', value: baseline + value * span, weight };
  };
  function frame() {
    if (!active) return null;
    const now = active.media ? active.start + active.position : Date.now() / 1000;
    const elapsed = now - active.start;
    if (elapsed > active.duration + .2 || Date.now() > active.until) { active = undefined; return null; }
    if (elapsed < 0) return null;
    const weight = Math.min(bounded((now - active.activated) / .18, 0, 1), bounded((active.duration + .2 - elapsed) / .2, 0, 1));
    const speech = elapsed * 1000 < active.speechMs ? {
      id: active.start, elapsed, durationMs: active.speechMs,
      face: PERFORMANCE_FACES.includes(active.face) ? active.face : undefined,
    } : undefined;
    if (active.beats) {
      if (!active.sequence) {
        const ids = new Set(active.beats.flatMap(beat => Object.keys(beat.parameters)));
        active.sequence = new QuietSequencer();
        active.sequence.start(active.beats, active.start, Object.fromEntries([...ids].map(id => [id, normalized(id)])));
      }
      const tracks = Object.entries(active.sequence.evaluate(now)).map(entry => toTrack(entry, weight));
      return { tracks, speech };
    }
    const cues = (active.cues ?? []).filter(cue => cue.at <= elapsed && cue.at + cue.duration + .2 >= elapsed);
    const emotion = cues.findLast(cue => cue.face || cue.vad || cue.facs || cue.actionUnits);
    const resource = cues.findLast(cue => cue.resource);
    const pose = cues.findLast(cue => cue.pose);
    const blend = cue => {
      const time = elapsed - cue.at;
      return Math.min(bounded(time / .15, 0, 1), bounded((cue.duration + .2 - time) / .2, 0, 1));
    };
    const tracks = new Map();
    if (pose) {
      if (!active.sequence) {
        const poses = active.cues.filter(item => item.pose);
        const ids = new Set(poses.flatMap(item => Object.keys(item.pose)));
        const initial = Object.fromEntries([...ids].map(id => [id, normalized(id)]));
        let current = initial;
        const segments = poses.map(item => ({
          time: item.at, duration: item.duration, parameters: current = { ...current, ...item.pose },
        }));
        active.sequence = new QuietSequencer();
        active.sequence.start(segments, active.start, initial);
      }
      for (const entry of Object.entries(active.sequence.evaluate(now))) tracks.set(entry[0], toTrack(entry, weight));
    }
    if (resource) {
      active.clips.sample(resource.resource, elapsed - resource.at);
      for (const track of active.clips.update()) {
        if (track.target === 'Parameter' && accepted(track.id)) tracks.set(track.id, { ...track, weight: blend(resource) });
      }
    }
    if (!cues.length && !speech) return null;
    return { face: emotion?.face, tracks: [...tracks.values()], emotion, strength: emotion ? blend(emotion) : 0, speech };
  }
  return {
    frame,
    media(command, resources) {
      if (disposed || !command || typeof command.id !== 'string') return;
      if (command.kind === 'start') {
        const duration = Math.min(120, Number(command.duration));
        if (!(duration > 0)) return;
        const startedAt = Date.now();
        for (const [ticket, expiry] of used) if (expiry <= startedAt) used.delete(ticket);
        if (collect({ ticket: 'media-' + command.id, startedAt, expiresAt: startedAt + (duration + 1) * 1000,
          cues: command.cues, resources, face: command.face, speechMs: duration * 1000 })) {
          active.media = command.id;
          active.position = 0;
        }
      } else if (active?.media === command.id) {
        if (command.kind === 'stop') active = undefined;
        if (command.kind === 'advance' && Number.isFinite(command.position)) active.position = Math.max(active.position, command.position);
        if (command.kind === 'cues' && Number.isFinite(command.position)) {
          const cues = parsePerformanceCues(command.cues).filter(cue => cue.at >= command.position);
          if (cues.some(cue => cue.pose && Object.keys(cue.pose).some(id => !accepted(id)))) return;
          // The online planner supplies parameter poses. Native clips belong to the validated start command.
          if (cues.some(cue => cue.resource)) return;
          active.cues = cues;
          active.position = Math.max(active.position, command.position);
        }
      }
    },
    dispose() { disposed = true; active = undefined; used.clear(); },
  };
}
