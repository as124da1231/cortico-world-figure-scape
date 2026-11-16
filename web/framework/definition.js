/** Serializable product definition. Factories, DOM, host and sessions are runtime bindings. */
export function definePetDefinition(input) {
  const d = structuredClone(input);
  if (!d.id || d.schemaVersion !== 1) throw new TypeError('Unsupported pet system definition');
  if (typeof d.resources?.model?.implementation !== 'string') throw new TypeError('Missing model resource implementation');
  for (const domain of ['body', 'scene', 'actions', 'input', 'speech']) {
    if (typeof d[domain]?.implementation !== 'string') throw new TypeError(`Missing ${domain} implementation`);
  }
  if (!d.presentations?.[d.defaultPresentation]?.implementation) throw new TypeError('Default presentation is not defined');
  for (const p of Object.values(d.presentations)) if (p.scene !== undefined && typeof p.scene !== 'string') throw new TypeError('Invalid presentation scene override');
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  return freeze(d);
}
export const DESKTOP_PET_DEFINITION = definePetDefinition({
  id: 'desktop-live2d-pet', schemaVersion: 1,
  resources: { model: { implementation: 'direct-live2d' } },
  body: { implementation: 'figure-body' },
  scene: { implementation: 'desktop-space' },
  actions: { implementation: 'body-vocabulary' },
  input: { implementation: 'body-pointer' },
  speech: { implementation: 'speech-playback' },
  presentations: {
    desktop: { implementation: 'desktop-presentation', bodyEffects: {} },
    room: { implementation: 'room-presentation', scene: 'room-space', bodyEffects: {} },
    phone: { implementation: 'phone-presentation', scene: 'phone-space', bodyEffects: {} },
    wallpaper: { implementation: 'wallpaper-presentation', scene: 'wallpaper-space', bodyEffects: {} },
  },
  defaultPresentation: 'desktop',
});
