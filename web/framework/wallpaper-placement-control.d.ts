import type { WallpaperPlacement } from './wallpaper-placement.js';
export interface WallpaperComposition { placement: WallpaperPlacement; revision: number }
export interface WallpaperPlacementSource { id: string; title: string; composition: WallpaperComposition }
export function createWallpaperPlacementControl(options: {
  doc: Document;
  text: (zh: string, en: string) => string;
  save: (id: string, value: WallpaperPlacement, revision: number) => Promise<WallpaperComposition>;
  read?: (id: string) => Promise<WallpaperPlacementSource>;
  preview?: (value: WallpaperPlacement | null) => void;
  compact?: boolean;
}): {
  element: HTMLElement;
  sync(source: WallpaperPlacementSource, force?: boolean): void;
  setArt(art?: {wallpaperURL?: string; figureURL?: string; fit?: string; scale?: number; characterScale?: number}): void;
  showGuide(): void;
  deactivate(): void;
};

