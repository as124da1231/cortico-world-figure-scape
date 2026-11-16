/** Shared between the browser settings and the Live2D World. */
export const GLOW_DEFAULT = 7;
export const SELF_KEYS = ['figure', 'scheme', 'roam', 'snoreSeconds', 'sound', 'scale', 'bubbleSize', 'fontSize', 'theme', 'hoverButtons', 'user'] as const;
export type SelfKey = typeof SELF_KEYS[number];
/** Items allowed immediately by the default scope. The rest require user confirmation. */
export const SELF_DEFAULT: Readonly<Record<SelfKey, boolean>> = {
  figure:true, scheme:true, roam:true, snoreSeconds:true, sound:false, scale:false,
  bubbleSize:false, fontSize:false, theme:false, hoverButtons:false, user:false,
};
