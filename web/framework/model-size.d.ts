export type SceneMode = 'desktop' | 'room' | 'phone' | 'wallpaper';
export const SCALE_MIN: number;
export const SCALE_MAX: number;
export const SCENE_SIZE_LIMITS: Readonly<Record<SceneMode, Readonly<{min: number; max: number}>>>;
export function sceneScale(mode: SceneMode, value?: number): number;
export function sceneSizePosition(mode: SceneMode, scale: number): number;
export function sceneScales(desktop: number, saved?: Partial<Record<SceneMode, number>>, legacy?: number): Record<SceneMode, number>;
export function createModelSizeControl(options: {
  doc: Document;
  text: (zh: string, en: string) => string;
  mode: () => SceneMode;
  label?: (mode: SceneMode) => string;
  read: (mode: SceneMode) => number;
  preview: (mode: SceneMode, scale: number | null) => void;
  save: (mode: SceneMode, scale: number) => Promise<void>;
  report: (error: string, kind: 'error') => void;
  signal?: AbortSignal;
}): {
  element: HTMLDivElement;
  sync(): void;
  stopPreview(): void;
};

