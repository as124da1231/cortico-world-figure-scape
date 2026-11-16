export const WALLPAPER_PLACEMENT_DEFAULT = Object.freeze({ x: .63, groundY: .88 });
export const WALLPAPER_PLACEMENT_LIMITS = Object.freeze({
  x: Object.freeze({ min: .08, max: .92 }),
  groundY: Object.freeze({ min: .32, max: .96 }),
});

function coordinate(value, fallback, {min,max}) {
  return Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value)) * 1000) / 1000 : fallback;
}

export function wallpaperPlacement(value) {
  return {
    x: coordinate(value?.x, WALLPAPER_PLACEMENT_DEFAULT.x, WALLPAPER_PLACEMENT_LIMITS.x),
    groundY: coordinate(value?.groundY, WALLPAPER_PLACEMENT_DEFAULT.groundY, WALLPAPER_PLACEMENT_LIMITS.groundY),
  };
}

export function sameWallpaperPlacement(left, right) {
  return left.x === right.x && left.groundY === right.groundY;
}

