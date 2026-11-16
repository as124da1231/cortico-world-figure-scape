const f = n => Math.round(n * 10) / 10;

const icon = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
// eight flat teeth around a hub
const gear = icon(`<path d="${Array.from({ length: 32 }, (_, i) => {
  const a = (i - .5) * Math.PI / 16, r = i % 4 < 2 ? 9.6 : 7.2;
  return `${i ? 'L' : 'M'}${f(12 + r * Math.cos(a))} ${f(12 + r * Math.sin(a))}`;
}).join('')}Z"/><circle cx="12" cy="12" r="3"/>`);
export const ICONS = {
  back: icon('<path d="m14 6-6 6 6 6"/>'),
  scale: icon('<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5M4 4l5 5m11-5-5 5M4 20l5-5m11 5-5-5"/>'),
  apps: icon('<rect x="4" y="4" width="6" height="6" rx="1.2"/><rect x="14" y="4" width="6" height="6" rx="1.2"/><rect x="4" y="14" width="6" height="6" rx="1.2"/><rect x="14" y="14" width="6" height="6" rx="1.2"/>'),
  chat: icon('<path d="M6 4.5h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-6l-4.5 3.5v-3.5H6a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3z"/>'),
  moon: icon('<path d="M20 14.6A8.2 8.2 0 1 1 9.4 4a6.6 6.6 0 0 0 10.6 10.6z"/>'),
  sun: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2.8v1.6M12 19.6v1.6M2.8 12h1.6M19.6 12h1.6M5.5 5.5l1.1 1.1M17.4 17.4l1.1 1.1M5.5 18.5l1.1-1.1M17.4 6.6l1.1-1.1"/>'),
  play: icon('<path d="M8 5.5v13l10.5-6.5z"/>'),
  pause: icon('<path d="M9 5.5v13M15 5.5v13"/>'),
  settings: gear,
  more: icon('<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>'),
  close: icon('<path d="m6 6 12 12M18 6 6 18"/>'),
  desktop: icon('<rect x="3" y="4.5" width="18" height="12.5" rx="2"/><path d="M12 17v3m-4 0h8"/>'),
  room: icon('<path d="m3.5 11 8.5-7 8.5 7M5 10v10h14V10m-9 10v-5h4v5"/>'),
  phone: icon('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>'),
  wallpaper: icon('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m4 16 5-5 4 4 2-2 5 4"/><circle cx="15.5" cy="9" r="1"/>'),
  cursor: icon('<path d="m5 3 14 9-7 1.5L9 20 5 3Z"/>'),
  swap: icon('<path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4"/>'),
  power: icon('<path d="M12 3.5v8M7.2 6.3a8 8 0 1 0 9.6 0"/>'),
  mic: icon('<rect x="8.5" y="3" width="7" height="11.5" rx="3.5"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  // the same microphone struck through
  micOff: icon('<rect x="8.5" y="3" width="7" height="11.5" rx="3.5"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/>'),
  sound: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  soundOff: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  // a T-shirt: the dressing page
  shirt: icon('<path d="M8.5 3.5 4 6l-1.5 4.5L6 12v8.5h12V12l3.5-1.5L20 6l-4.5-2.5a3.5 3.5 0 0 1-7 0z"/>'),
  eye: icon('<path d="M3 12s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="3"/>'),
  // the chat page: the typing box's button that carries the draft there, and the mark on what was sent from it
  expand: icon('<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>'),
  // a page that opens in the browser
  external: icon('<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'),
  // three stacked layers: the list of Worlds
  boxes: icon('<path d="m12 4 7 4-7 4-7-4 7-4Z"/><path d="m5 12 7 4 7-4"/><path d="m5 16 7 4 7-4"/>'),
  eyeOff: icon('<path d="M3 12s3.2-6 9-6c1.6 0 3 .4 4.2 1M21 12s-3.2 6-9 6c-1.6 0-3-.4-4.2-1"/><path d="M9.9 14.1a3 3 0 0 1 4.2-4.2M4 4l16 16"/>'),
  // how much the pet walks on its own, as a gauge: low, middle, high
  roam_off: icon('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16 7 13.2"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/>'),
  roam_calm: icon('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16V10"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/>'),
  roam_free: icon('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l5-2.8"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/><path d="M19.5 6.5l1.5-1.5M21 10h1.5"/>'),
  // the personas the introduction offers (pet.css gives each its move when picked): a magnifier, a goblet, a hammer,
  // a heart, a snowflake, the whale with its spout
  persona_coo: icon('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>'),
  persona_grail: icon('<path d="M6.5 4h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 13v6M8 20h8"/>'),
  persona_forge: icon('<path d="M12.5 5.5l3-3 5 5-3 3z"/><path d="M14 9l-9.5 9.5"/>'),
  persona_heart: icon('<path d="M12 19.5s-7-4.3-7-9.6a3.9 3.9 0 0 1 7-2.4 3.9 3.9 0 0 1 7 2.4c0 5.3-7 9.6-7 9.6z"/>'),
  persona_winter: icon('<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.5 4.5L12 6l2.5-1.5M9.5 19.5L12 18l2.5 1.5"/>'),
  persona_whale: icon('<path d="M3 13c0-3 2.6-5 6.5-5 3.3 0 5.4 1.6 7 3.3.8.8 1.6 1.2 2.5 1.2"/><path d="M3 13c0 3.1 3 5 7.5 5 4.4 0 7.5-2.2 8.5-5.5"/><path d="M19 12.5c.2-1.8 1-3.2 2.5-4-1.6-.2-2.8.3-3.6 1.4-.4-1.4-1.4-2.2-3-2.4"/><path class="spout" d="M8 5.5V3.5M6.3 4.3 8 5.5l1.7-1.2"/><circle cx="7" cy="12" r=".6" fill="currentColor"/>'),
  // activity above the pet; separate parts let each small icon move in its own way
  status_think: icon('<circle cx="4" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="20" cy="12" r="1.5"/>'),
  status_read: icon('<path d="M6 3h9l4 4v14H6zM14 3v5h5"/><path class="scan" d="M9 11h7"/>'),
  status_browse: icon('<path d="M3 19V5h7l2 3h9v11"/><path class="flap" d="M3 19 5 10h17l-3 9z"/>'),
  status_search: icon('<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>'),
  status_write: icon('<path d="m5 15 11-11 4 4L9 19l-5 1zM13 7l4 4M5 15l4 4"/>'),
  status_delete: icon('<path d="m6 8 1 13h10l1-13M10 11v6M14 11v6"/><path class="lid" d="M4 6h16M9 6V3h6v3"/>'),
  status_save: icon('<path d="M4 15v6h16v-6"/><path class="arrow" d="M12 3v12m-4-4 4 4 4-4"/>'),
  status_look: icon('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle class="pupil" cx="12" cy="12" r="2.5"/>'),
  status_click: icon('<path d="m5 3 3 17 4-6 7-2z"/><path class="ripple" d="M3 7H1M8 2V1M2 2l1 1"/>'),
  status_scroll: icon('<rect x="5" y="2" width="14" height="20" rx="7"/><path class="wheel" d="M12 6v5m-2-3 2-2 2 2"/>'),
  status_type: icon('<path d="M3 20h18"/><g class="keycap"><rect x="5" y="4" width="14" height="12" rx="3"/><path d="M9 8h6m-3 0v5"/></g>'),
  status_wait: icon('<path d="M5 3h14M5 21h14M7 3v4l10 10v4M17 3v4L7 17v4M9 6h6M9 19h6"/>'),
  status_alarm: icon('<circle cx="12" cy="13" r="7"/><path d="M12 9v4l3 2M3 5l3-3M18 2l3 3M7 20l-2 2M17 20l2 2"/>'),
  status_work: gear,
  pencil: icon('<path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5zM13.5 7l3 3"/>'),
  /** A five-pointed star: save the look worn as a new one. */
  addLook: icon('<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z"/>'),
  /** A floppy disk: save the changes to the look picked. */
  saveLook: icon('<path d="M5 3.5h11l3 3V20.5H5z"/><path d="M8.5 3.5v5h6v-5M8 20.5v-6.5h8v6.5"/>'),
  trash: icon('<path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l1 13.5h9l1-13.5M10 10.5v6M14 10.5v6"/>'),
};
