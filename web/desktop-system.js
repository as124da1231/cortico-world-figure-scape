import { loadBody } from './body-host.js';
import { createSpeechPresentation } from './framework/speech.js';
import { DESKTOP_PET_DEFINITION } from './framework/definition.js';
import { createPetRuntime } from './framework/runtime.js';
import { createDesktopSpace, createDesktopPresentation, createBodyInput } from './framework/desktop-space.js';
import { createRoomSpace, createPhoneSpace } from './framework/room-space.js';
import { createRoomPresentation } from './framework/room-presentation.js';
import { createWallpaperPresentation, createWallpaperSpace } from './framework/wallpaper-presentation.js';
import { createBodyActions } from './framework/actions.js';

/** Product assembly. Dependencies live here, not inside domain contracts or the settings page. */
export function createDesktopSystem(ports) {
  return createPetRuntime(DESKTOP_PET_DEFINITION, {
    body: { 'figure-body': loadBody },
    scene: { 'desktop-space': createDesktopSpace, 'room-space': createRoomSpace, 'phone-space': createPhoneSpace, 'wallpaper-space':createWallpaperSpace },
    presentation: { 'desktop-presentation': createDesktopPresentation, 'room-presentation': createRoomPresentation, 'phone-presentation': createRoomPresentation, 'wallpaper-presentation':createWallpaperPresentation },
    actions: { 'body-vocabulary': createBodyActions },
    input: { 'body-pointer': createBodyInput },
    speech: { 'speech-playback': createSpeechPresentation },
  }, ports);
}
