export const PET_ACTIONS = ['chat', 'voice', 'roam', 'theme', 'sound', 'hide', 'dress', 'worlds'] as const;
export type PetAction = typeof PET_ACTIONS[number];
export const MAX_HOVER_BUTTONS = 6;
