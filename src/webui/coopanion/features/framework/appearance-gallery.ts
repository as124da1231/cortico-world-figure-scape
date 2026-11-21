import type { PageContext } from '../../base/page.ts';
import { APPEARANCE_PRESETS, appearancePreset, type AppearancePreset } from '../../../../framework/appearance.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';

export function appearanceGallery(ctx: PageContext, applyAppearance: (preset: AppearancePreset) => void) {
  const c = studioControls(ctx);
  const element = c.node('section', '', 'studio-appearance');
  const heading = c.node('h2', t('桌宠界面配色', 'Pet interface palette'));
  const description = c.node('p', t('用于桌宠窗口和浏览器角色编辑台。Coo 内的面板跟随 Coo 外观。', 'Applies to the pet window and browser character editor. Panels in Coo follow the Coo theme.'));
  const settings = c.node('header', '', 'studio-appearance-heading');
  const title = c.node('div');
  title.append(heading, description);
  const schemes = c.node('div', '', 'studio-appearance-schemes');
  schemes.setAttribute('role', 'group');
  schemes.setAttribute('aria-label', t('预览明暗', 'Preview color mode'));
  const cards = c.node('fieldset', '', 'studio-appearance-cards');
  cards.setAttribute('aria-label', t('界面配色', 'Interface palette'));
  const status = c.status('studio-appearance-status');
  const selected = new Map<AppearancePreset, { input: HTMLInputElement; art: HTMLElement; marker: HTMLElement }>();
  let current: AppearancePreset | undefined;
  let pending: AppearancePreset | undefined;
  let saving = false;
  let scheme = 'light';

  const apply = c.button(t('应用外观', 'Apply appearance'), () => void save(), true);
  const footer = c.node('footer', '', 'studio-appearance-footer');
  footer.append(status, apply);
  const light = c.button(t('浅色预览', 'Light preview'), () => { scheme = 'light'; render(); });
  const dark = c.button(t('深色预览', 'Dark preview'), () => { scheme = 'dark'; render(); });
  schemes.append(light, dark);
  settings.append(title, schemes);
  element.append(settings, cards, footer);

  for (const preset of APPEARANCE_PRESETS) {
    const nameText = t(preset.name[0], preset.name[1]);
    const card = c.node('label', '', 'studio-appearance-card');
    const input = c.node('input');
    input.type = 'radio';
    input.name = 'studio-appearance-palette';
    input.setAttribute('aria-label', nameText);
    input.addEventListener('change', () => { pending = preset.id; status.textContent = ''; render(); }, { signal: ctx.signal });

    const art = c.node('div', '', 'studio-appearance-art');
    art.dataset.appearance = preset.id;
    art.setAttribute('aria-hidden', 'true');
    const window = c.node('div', '', 'studio-appearance-window');
    const chrome = c.node('div', '', 'studio-appearance-chrome');
    chrome.append(c.node('span', '', 'studio-appearance-dot'), c.node('span', t('桌宠', 'Desktop pet')));
    const bubbles = c.node('div', '', 'studio-appearance-bubbles');
    bubbles.append(c.node('span', t('在吗？', 'Hi there')), c.node('span', t('我在这儿。', 'I’m here.')));
    const rail = c.node('div', '', 'studio-appearance-rail');
    rail.append(c.node('span', '', 'studio-appearance-tile'), c.node('span', '', 'studio-appearance-tile'));
    window.append(chrome, bubbles, rail);
    art.append(window);

    const copy = c.node('div', '', 'studio-appearance-copy');
    const name = c.node('span', nameText, 'studio-appearance-name');
    const marker = c.node('span', t('使用中', 'In use'), 'studio-appearance-marker');
    copy.append(name, marker, c.node('small', t(preset.description[0], preset.description[1])));
    card.append(input, art, copy);
    cards.append(card);
    selected.set(preset.id, { input, art, marker });
  }

  function render() {
    light.setAttribute('aria-pressed', String(scheme === 'light'));
    dark.setAttribute('aria-pressed', String(scheme === 'dark'));
    for (const [id, card] of selected) {
      card.input.checked = id === (pending ?? current);
      card.input.disabled = saving || !current;
      card.art.dataset.scheme = scheme;
      card.marker.hidden = id !== current;
    }
    apply.disabled = saving || !pending || pending === current;
    apply.textContent = saving ? t('正在应用…', 'Applying…') : t('应用外观', 'Apply appearance');
  }

  async function save() {
    if (apply.disabled || !pending) return;
    saving = true;
    status.textContent = '';
    render();
    try {
      const receipt = await c.call<{ appearance: AppearancePreset }>('appearance.set', [pending]);
      if (ctx.signal.aborted) return;
      const applied = appearancePreset(receipt.appearance);
      current = applied;
      pending = undefined;
      applyAppearance(applied);
      status.textContent = t('已应用外观。', 'Appearance applied.');
    } catch (error) {
      if (!ctx.signal.aborted) status.textContent = errorText(error);
    } finally {
      saving = false;
      if (!ctx.signal.aborted) render();
    }
  }

  render();
  return { element, update(value: unknown) { if (!saving) { current = appearancePreset(value); render(); } } };
}
