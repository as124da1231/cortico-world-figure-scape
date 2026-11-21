export const APPEARANCE_PRESETS = [
  { id: 'rose', name: ['暖玫瑰', 'Warm Rose'], description: ['暖白纸面与深玫红', 'Warm paper and deep rose'] },
  { id: 'mint', name: ['Coo 经典', 'Coo Classic'], description: ['Coo 的冷白、暖灰与薄荷绿', 'Coo’s cool white, warm gray and mint green'] },
  { id: 'blue', name: ['雾蓝', 'Mist Blue'], description: ['雾蓝底色与水洗靛蓝', 'Blue mist and washed indigo'] },
  { id: 'amber', name: ['琥珀', 'Amber'], description: ['浅砂色与烘焙焦糖', 'Pale sand and toasted caramel'] },
] as const;

export type AppearancePreset = typeof APPEARANCE_PRESETS[number]['id'];
export const DEFAULT_APPEARANCE: AppearancePreset = 'rose';

export function isAppearancePreset(value: unknown): value is AppearancePreset {
  return APPEARANCE_PRESETS.some(preset => preset.id === value);
}

export function appearancePreset(value: unknown): AppearancePreset {
  return isAppearancePreset(value) ? value : DEFAULT_APPEARANCE;
}
