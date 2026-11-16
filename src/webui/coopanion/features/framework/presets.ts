import type { PetSkin, SavedLook } from '../../../../config.ts';
import type { PageContext } from '../../base/page.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';

export function appearancePresets(ctx: PageContext, options: {
  skin: () => PetSkin | undefined;
  confirmSwitch: () => Promise<boolean>;
  changed: () => Promise<void>;
}) {
  const c = studioControls(ctx);
  const element = c.section(t('装扮预设', 'Outfit presets'));
  const heading = c.node('div', '', 'studio-resource-toolbar');
  const add = c.button(t('保存当前装扮', 'Save current look'), () => open(), true);
  heading.append(element.firstChild!, add);
  const status = c.status();
  const list = c.node('div', '', 'studio-resource-list');
  const dialog = c.dialog(t('装扮预设', 'Outfit preset'));
  const inlineEditor = c.node('div', '', 'studio-preset-edit'); inlineEditor.hidden = true;
  const name = c.node('input');
  name.required = true;
  name.maxLength = 40;
  const save = c.button(t('保存预设', 'Save preset'), () => void commit(), true);
  const feedback = c.status();
  dialog.body.append(c.field(t('预设名称', 'Preset name'), name), save, feedback);
  element.append(heading, list, inlineEditor, status);

  let presets: SavedLook[] | undefined;
  let editing: SavedLook | undefined;
  let busy = false;
  const lock = () => {
    add.disabled = busy || !presets || !options.skin() || presets.length >= 60;
    save.disabled = busy;
    for (const button of list.querySelectorAll('button')) button.disabled = busy;
  };
  function render(next: SavedLook[]) {
    presets = next;
    list.replaceChildren(...next.map(preset => {
      const row = c.node('div', '', 'studio-resource-item');
      const actions = c.node('div', '', 'studio-inline');
      actions.append(c.button(t('应用', 'Apply'), () => void apply(preset)),
        c.button(t('重命名', 'Rename'), () => open(preset)),
        c.button(t('移除', 'Remove'), () => void remove(preset)));
      row.append(c.node('strong', preset.name), actions);
      return row;
    }));
    if (!next.length) list.append(c.node('p', t('还没有预设。', 'No presets yet.'), 'studio-help'));
    lock();
  }
  async function read() {
    try {
      const next = await c.call<SavedLook[]>('appearance.presets');
      if (!ctx.signal.aborted && Array.isArray(next)) render(next);
    } catch (error) { if (!ctx.signal.aborted) status.textContent = errorText(error); }
  }
  function open(preset?: SavedLook) {
    editing = preset;
    name.value = preset?.name ?? '';
    feedback.textContent = '';
    if (element.closest('dialog[open]')) {
      inlineEditor.hidden = false;
      inlineEditor.append(...Array.from(dialog.body.childNodes));
    } else dialog.open();
    name.focus();
  }
  async function write(next: SavedLook[]) {
    const saved = await c.call<SavedLook[]>('appearance.savePresets', [next]);
    if (!ctx.signal.aborted) render(saved);
  }
  async function commit() {
    if (busy || !presets || !name.reportValidity() || !name.value.trim()) return;
    const skin = editing?.skin ?? options.skin();
    if (!skin) return;
    busy = true;
    lock();
    try {
      const item = { id: editing?.id ?? c.doc.defaultView!.crypto.randomUUID(), name: name.value.trim(), skin };
      await write(editing ? presets.map(preset => preset.id === item.id ? item : preset) : [...presets, item]);
      if (!ctx.signal.aborted) { if (dialog.element.open) dialog.element.close(); inlineEditor.hidden = true; status.textContent = t('预设已保存。', 'Preset saved.'); }
    } catch (error) { if (!ctx.signal.aborted) feedback.textContent = errorText(error); }
    finally { busy = false; lock(); }
  }
  async function remove(preset: SavedLook) {
    if (busy || !presets) return;
    busy = true;
    lock();
    try { await write(presets.filter(item => item.id !== preset.id)); if (!ctx.signal.aborted) status.textContent = t('预设已移除。', 'Preset removed.'); }
    catch (error) { if (!ctx.signal.aborted) status.textContent = errorText(error); }
    finally { busy = false; lock(); }
  }
  async function apply(preset: SavedLook) {
    if (busy) return;
    busy = true;
    lock();
    try {
      if (preset.skin.figure !== options.skin()?.figure && !await options.confirmSwitch()) return;
      if (ctx.signal.aborted) return;
      status.textContent = t('正在应用预设…', 'Applying preset…');
      const result = await c.call<{ observed?: { status: string } }>('appearance.applyPreset', [preset.id]);
      await options.changed();
      if (!ctx.signal.aborted) status.textContent = result.observed?.status === 'applied'
        ? t('预设已应用。', 'Preset applied.') : t('预设已选定，应用状态见「当前装扮」。', 'Preset selected. Check Current look for the applied state.');
    } catch (error) { if (!ctx.signal.aborted) status.textContent = errorText(error); }
    finally { busy = false; lock(); }
  }
  lock();
  return { element, read, lock };
}
