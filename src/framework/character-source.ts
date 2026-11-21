import type { FigurePack } from '../packs.ts';
import type { CharacterEditorSource, CharacterTask } from './model-contract.ts';

export function live2dCharacter(id: string, sourceId: string): CharacterEditorSource {
  return { id, sourceId, kind: 'live2d-model', origin: 'live2d-model', tasks: ['framing', 'bindings', 'wardrobe', 'touch', 'behavior', 'mouth'] };
}

export function packagedCharacter({ id, manifest, builtin }: FigurePack): CharacterEditorSource & { kind: 'figure-pack' } {
  const tasks: CharacterTask[] = ['framing'];
  if (manifest.vocab.length) tasks.push('bindings');
  if (manifest.axes.length || manifest.presets.length) tasks.push('wardrobe');
  tasks.push('touch', 'source');
  return { id, sourceId: id, kind: 'figure-pack', origin: manifest.source ?? 'figure-pack', ...(builtin ? { builtin } : {}), tasks };
}

export function characterEditorTask(source: CharacterEditorSource, requested: unknown): CharacterTask {
  const task = requested === 'visual' ? 'framing' : requested;
  return source.tasks.find(id => id === task) ?? source.tasks[0] ?? 'framing';
}

const labels = {
  'live2d-model': ['原始 Live2D', 'Raw Live2D'],
  'figure-pack': ['Coo 形象包', 'Coo figure pack'],
  spriter: ['Spriter', 'Spriter'],
  'cabin-world': ['小屋世界', 'Cabin World'],
};
export function characterOriginLabel(source: Partial<Pick<CharacterEditorSource, 'origin' | 'builtin' | 'kind'>>, english: boolean) {
  const names = source.builtin ? ['内置形象包', 'Built-in figure'] : labels[source.origin ?? source.kind ?? 'figure-pack'];
  return names[english ? 1 : 0];
}
