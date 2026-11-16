export const DEFAULT_VISUAL = Object.freeze({ hue: 0, brightness: 1 });
export function visualSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['hue', 'brightness'].includes(key))
    || !Number.isFinite(value.hue) || value.hue < -180 || value.hue > 180
    || !Number.isFinite(value.brightness) || value.brightness < .5 || value.brightness > 1.5) {
    throw Error('Invalid model visual settings');
  }
  return { hue: value.hue, brightness: value.brightness };
}
