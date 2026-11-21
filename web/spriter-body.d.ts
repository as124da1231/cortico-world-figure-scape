export interface SpriterSprite {
  file: string; width: number; height: number; px: number; py: number;
}
export interface SpriterTransform {
  x: number; y: number; angle: number; sx: number; sy: number; alpha: number;
}
export interface SpriterKey extends SpriterTransform {
  time: number; spin: number; curve: number[] | 'instant'; sprite?: number; px?: number; py?: number;
}
export interface SpriterRef { track: number; key: number; parent: number }
export interface SpriterClip {
  length: number;
  loop: boolean;
  tracks: SpriterKey[][];
  main: Array<{ time: number; bones: SpriterRef[]; parts: SpriterRef[] }>;
}
export interface SpriterModel {
  sprites: SpriterSprite[];
  maps: Record<string, Record<number, number>>;
  clips: Record<string, SpriterClip>;
  modes: Record<string, string>;
}
export function spriterPose(model: Pick<SpriterModel,'sprites'|'maps'>, clip: SpriterClip, elapsed: number, scheme?: string):
  Array<SpriterTransform & { sprite: number; left: number; top: number }>;
