/** Appearance choices saved for imported models. */
export const fetchLooks = () => fetch('/api/looks').then((r) => (r.ok ? r.json() : [])).then((l) => (Array.isArray(l) ? l : [])).catch(() => []);

export function normalizeSkin(raw) {
  return {
    figure: typeof raw?.figure === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.figure) && raw.figure !== 'coo' ? raw.figure : undefined,
    scheme: typeof raw?.scheme === 'string' && /^[a-z0-9-]*$/.test(raw.scheme) ? raw.scheme : '',
  };
}

export const sameLook = (a, b) => {
  const first = normalizeSkin(a), second = normalizeSkin(b);
  return first.figure === second.figure && first.scheme === second.scheme;
};

const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const lookAvailable = (skin, models) => models?.some(model => model.id === normalizeSkin(skin).figure) ?? false;

export function lookPicture(skin, models) {
  const model = models?.find(m => m.id === normalizeSkin(skin).figure);
  return model ? '<span aria-hidden="true">' + escAttr(Array.from(model.title || model.id)[0] ?? '') + '</span>' : '';
}
