/** The pages' round buttons: icons (24 units, currentColor) and the theme switch. */
import { t } from './i18n.js';
import { ICONS } from './icons.js';
export { ICONS } from './icons.js';

export const f = n => Math.round(n * 10) / 10;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * The http(s) addresses written out in `text`, as [start, end) pairs. An address runs to the first
 * space or non-ASCII character, so one written straight into Chinese prose ends there; a sentence's
 * closing punctuation is left out. Only written-out addresses become links: the text of a link is
 * where it goes.
 */
export function urlRanges(text) {
  const out = [];
  for (const m of text.matchAll(/https?:\/\/[!-~]+/g)) {
    let url = m[0];
    // a closing bracket stays when the address opened it, as in a wiki title
    while (/[.,;:!?'"]$/.test(url) || (/[)\]}>]$/.test(url) && count(url, OPENERS[url.at(-1)]) < count(url, url.at(-1)))) url = url.slice(0, -1);
    try { new URL(url); } catch { continue; }
    out.push([m.index, m.index + url.length]);
  }
  return out;
}
const OPENERS = { ')': '(', ']': '[', '}': '{', '>': '<' };
const count = (s, c) => s.split(c).length - 1;

/** The first `n` characters of `text` as nodes of `doc`; an address typed out in full is a link that opens outside the window. */
export function linked(text, n = text.length, doc = document) {
  const frag = doc.createDocumentFragment();
  let at = 0;
  for (const [start, end] of urlRanges(text)) {
    if (end > n) break;
    const a = Object.assign(doc.createElement('a'), { href: text.slice(start, end), target: '_blank', rel: 'noopener noreferrer' });
    a.textContent = text.slice(start, end);
    frag.append(text.slice(at, start), a);
    at = end;
  }
  frag.append(text.slice(at, n));
  return frag;
}


/** Sets `theme` ('dark' | 'light') on the page; `button`, when given, shows the mode a click switches to. */
export function applyTheme(theme, button) {
  document.documentElement.dataset.theme = theme;
  if (button) themeButton(theme, button);
}
/** Draws `button` as the switch away from `theme`, without changing the page's theme. */
export function themeButton(theme, button) {
  const toLight = theme === 'dark';
  button.innerHTML = toLight ? ICONS.sun : ICONS.moon;
  button.title = t(toLight ? 'theme.toLight' : 'theme.toDark');
  button.setAttribute('aria-label', button.title);
}
