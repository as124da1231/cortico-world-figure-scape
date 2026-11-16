export type WallpaperPlacement = { x: number; groundY: number };
export const WALLPAPER_PLACEMENT_DEFAULT: Readonly<WallpaperPlacement>;
export const WALLPAPER_PLACEMENT_LIMITS: Readonly<Record<keyof WallpaperPlacement, Readonly<{min:number;max:number}>>>;
export function wallpaperPlacement(value?: unknown): WallpaperPlacement;
export function sameWallpaperPlacement(left: WallpaperPlacement, right: WallpaperPlacement): boolean;

