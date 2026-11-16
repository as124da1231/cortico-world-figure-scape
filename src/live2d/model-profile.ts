import { rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
// @ts-expect-error Owned native action vocabulary is ESM.
import { FACE_WORDS, MOTION_WORDS } from '../../live2d-runtime/tools/native-catalog.mjs';
// @ts-expect-error Reuse the Figure renderer's existing effect names.
import { EMOTION_EFFECTS, EMOTION_EFFECT_SIZES } from '../../live2d-runtime/tools/emotion-effect.mjs';
// @ts-expect-error Shared with the renderer.
import { visualSettings } from '../../web/body-visual-contract.js';
import type { NativeBinding, WardrobeGroup, ModelProfile } from '../framework/model-contract.ts';
export type { NativeBinding, WardrobeGroup, ModelCrop, ModelProfile } from '../framework/model-contract.ts';
import { readTouchProfile } from '../../web/framework/touch-geometry.js';

export const DEFAULT_MODEL_PROFILE: ModelProfile = {
  version: 1, fit: { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1, autoFit: false },
};
/** Source-owned edit schema. Unknown keys do not become renderer code or arbitrary file paths. */
export function readModelProfile(value: unknown): ModelProfile {
  const v = value as Partial<ModelProfile> | null;
  if (!v || v.version !== 1 || !v.fit || v.fit.mode !== 'contain' || v.fit.anchor !== 'bottom' || v.fit.autoFit !== false) throw Error('Invalid model profile');
  const finite = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  const pair = (v: unknown, min: number, max: number): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(n => finite(n, min, max));
  if (!finite(v.fit.zoom, 0.1, 5) || !pair(v.fit.offset, -2, 2) || !pair(v.fit.padding, 0, 0.45)) throw Error('Invalid fit range');
  let bindings: NativeBinding[] | undefined;
  if (v.bindings !== undefined) {
    if (!Array.isArray(v.bindings) || v.bindings.length > 40) throw Error('Invalid native bindings');
    const words = new Set([...FACE_WORDS, ...MOTION_WORDS]), seen = new Set<string>();
    const resource = (id: unknown) => typeof id === 'string' && /^(motion|expr)-[a-f0-9]{16}$/.test(id);
    bindings = v.bindings.map(b => {
      if (!b || typeof b !== 'object' || Object.keys(b).some(k => !['word','resource','overlays','release','nativeOnly','reason','confidence'].includes(k)) || !words.has(b.word) || seen.has(b.word) || !resource(b.resource)) throw Error('Invalid native binding');
      seen.add(b.word);
      if (b.overlays !== undefined && (!Array.isArray(b.overlays) || b.overlays.length > 7 || b.overlays.some(id => !resource(id)) || new Set([b.resource, ...b.overlays]).size !== b.overlays.length + 1)) throw Error('Invalid expression overlays');
      if (b.release !== undefined && !resource(b.release) || b.nativeOnly !== undefined && typeof b.nativeOnly !== 'boolean') throw Error('Invalid native binding option');
      if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 200) || b.confidence !== undefined && !finite(b.confidence, 0, 1)) throw Error('Invalid native binding metadata');
      return { word: b.word, resource: b.resource, ...(b.overlays ? { overlays: [...b.overlays] } : {}), ...(b.release ? { release: b.release } : {}), ...(b.nativeOnly !== undefined ? { nativeOnly: b.nativeOnly } : {}), ...(b.reason !== undefined ? { reason: b.reason } : {}), ...(b.confidence !== undefined ? { confidence: b.confidence } : {}) };
    });
  }
  let wardrobe: WardrobeGroup[] | undefined;
  if (v.wardrobe !== undefined) {
    if (!Array.isArray(v.wardrobe) || v.wardrobe.length > 16) throw Error('Invalid wardrobe groups');
    const ids = new Set<string>();
    wardrobe = v.wardrobe.map(g => {
      if (!g || typeof g !== 'object' || Object.keys(g).some(k => !['id','name','slot','custom','en','options'].includes(k)) || typeof g.id !== 'string' || !/^[a-z][a-z0-9]{1,24}$/.test(g.id) || ids.has(g.id) || typeof g.name !== 'string' || !g.name.trim() || g.name.length > 40 || !Array.isArray(g.options) || g.options.length > 16) throw Error('Invalid wardrobe group');
      ids.add(g.id);
      if (g.slot !== undefined && !['outfit','parts','accessories'].includes(g.slot) || g.custom !== undefined && typeof g.custom !== 'boolean' || g.en !== undefined && (typeof g.en !== 'string' || g.en.length > 60)) throw Error('Invalid wardrobe metadata');
      const seen = new Set(['default']);
      const options = g.options.map(o => {
        if (!o || typeof o !== 'object' || Object.keys(o).some(k => !['id','name','resource'].includes(k)) || typeof o.id !== 'string' || !/^[a-z0-9]{1,24}$/.test(o.id) || seen.has(o.id) || typeof o.name !== 'string' || !o.name.trim() || o.name.length > 60 || typeof o.resource !== 'string' || !/^(motion|expr)-[a-f0-9]{16}$/.test(o.resource)) throw Error('Invalid wardrobe option');
        seen.add(o.id); return { id: o.id, name: o.name.trim(), resource: o.resource };
      });
      return { id: g.id, name: g.name.trim(), ...(g.slot ? { slot: g.slot } : {}), ...(g.custom !== undefined ? { custom: g.custom } : {}), ...(g.en !== undefined ? { en: g.en } : {}), options };
    });
  }
  if (v.mouth !== undefined && (!v.mouth || typeof v.mouth !== 'object' || Object.keys(v.mouth).some(k => !['mode','targets'].includes(k)) || !['auto','mapped','off'].includes(v.mouth.mode) || !Array.isArray(v.mouth.targets) || v.mouth.targets.length > 8 || v.mouth.targets.some(id => typeof id !== 'string' || !id.length || id.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(id)) || new Set(v.mouth.targets).size !== v.mouth.targets.length || (v.mouth.mode === 'mapped' ? v.mouth.targets.length === 0 : v.mouth.targets.length !== 0))) throw Error('Invalid mouth configuration');
  if (v.crop !== undefined && (!v.crop || typeof v.crop !== 'object' || Object.keys(v.crop).some(k => !['mode','edge','line','curve','feather','transition'].includes(k)) || !['full','upper'].includes(v.crop.mode) || !['flat','round'].includes(v.crop.edge) || !finite(v.crop.line,.2,.95) || !finite(v.crop.curve,0,2) || !finite(v.crop.feather,0,.25) || !finite(v.crop.transition,0,1.2))) throw Error('Invalid crop configuration');
  if (v.motion !== undefined && (!v.motion || typeof v.motion !== 'object' || Object.keys(v.motion).some(k => k !== 'kind') || !['roam','stand'].includes(v.motion.kind))) throw Error('Invalid motion configuration');
  if (v.facing !== undefined && !['fixed','mirror'].includes(v.facing)) throw Error('Invalid facing configuration');
  if (v.gaze !== undefined && (!v.gaze || typeof v.gaze !== 'object' || Object.keys(v.gaze).some(k => !['enabled','speed'].includes(k)) || typeof v.gaze.enabled !== 'boolean' || !finite(v.gaze.speed, .25, 2.5))) throw Error('Invalid gaze configuration');
  if (v.emotionEffect !== undefined && !EMOTION_EFFECTS.includes(v.emotionEffect)) throw Error('Invalid emotion effect');
  if (v.emotionEffectSize !== undefined && !EMOTION_EFFECT_SIZES.includes(v.emotionEffectSize)) throw Error('Invalid emotion effect size');
  if (v.catalogFingerprint !== undefined && (typeof v.catalogFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.catalogFingerprint))) throw Error('Invalid catalog fingerprint');
  const touch = v.touch === undefined ? undefined : readTouchProfile(v.touch);
  return { version: 1, ...(touch ? { touch } : {}), ...(v.mouth !== undefined ? { mouth: { mode: v.mouth.mode, targets: [...v.mouth.targets] } } : {}), ...(v.crop !== undefined ? { crop: { mode:v.crop.mode, edge:v.crop.edge, line:v.crop.line, curve:v.crop.curve, feather:v.crop.feather, transition:v.crop.transition } } : {}), ...(v.motion !== undefined ? { motion: { kind: v.motion.kind } } : {}), ...(v.facing !== undefined ? { facing: v.facing } : {}), ...(v.emotionEffect !== undefined ? { emotionEffect: v.emotionEffect } : {}), ...(v.emotionEffectSize !== undefined ? { emotionEffectSize: v.emotionEffectSize } : {}), ...(bindings !== undefined ? { bindings } : {}), ...(wardrobe !== undefined ? { wardrobe } : {}), ...(v.visual !== undefined ? { visual: visualSettings(v.visual) } : {}), ...(v.gaze !== undefined ? { gaze: { enabled: v.gaze.enabled, speed: v.gaze.speed } } : {}), ...(v.catalogFingerprint ? { catalogFingerprint: v.catalogFingerprint } : {}), fit: { mode: 'contain', anchor: 'bottom', autoFit: false, zoom: v.fit.zoom, offset: [...v.fit.offset], padding: [...v.fit.padding] } };
}
export async function writeModelProfile(file: string, profile: ModelProfile): Promise<void> {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(readModelProfile(profile)), { flag: 'wx' });
  // Same-directory atomic replace. The existing saved profile remains valid if writing fails.
  await rename(temporary, file);
}
