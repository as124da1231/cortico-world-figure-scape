import type { ModelNativeCatalog, NativeBinding } from '../../../../framework/model-contract.ts';
import type { PageContext } from '../../base/page.ts';
// @ts-expect-error The renderer and editor share Cubism's blend rules.
import { expressionTracks, MAX_EXPRESSIONS, ParameterConflict } from '../../../../../live2d-runtime/pack/backends/native-combination.js';
import { studioControls, studioText as t } from './controls.ts';

type Resource = ModelNativeCatalog['resources'][number];

/** Shows conflicts from the shared Cubism rules. Full validation stays in the edit service. */
export function expressionPicker(ctx: PageContext, options: {
  resources: Resource[];
  current: () => NativeBinding;
  initial: string[];
  change: () => void;
  audition: (id: string) => Promise<void>;
}) {
  const c = studioControls(ctx);
  const overlay = c.node('div', '', 'framework-overlay-group');
  const selected = new Set(options.initial);
  const expressions = options.resources.filter(r => r.kind === 'expression' && r.classification !== 'appearance');
  const byId = new Map(expressions.map(r => [r.id, r]));
  const chips = c.node('div', '', 'studio-expression-chips');
  const heading = c.node('div', '', 'studio-expression-heading');
  const dialog = c.dialog(t('叠加表情', 'Expression overlays'), 'studio-expressions-dialog');
  const inline = c.node('section', '', 'studio-expression-inline'); inline.hidden = true;
  const search = c.node('input');
  search.type = 'search';
  search.placeholder = t('搜索原生表情', 'Find native expressions');
  search.setAttribute('aria-label', search.placeholder);
  const list = c.node('div', '', 'studio-expression-options');
  const feedback = c.status();
  dialog.body.append(search, list, feedback);
  const label = c.node('strong', t('叠加表情', 'Expression overlays'));
  const show = c.button(t('选择表情', 'Choose expressions'), () => {
    if (overlay.closest('dialog[open]')) {
      inline.hidden = !inline.hidden;
      show.setAttribute('aria-expanded', String(!inline.hidden));
      if (inline.hidden) { show.focus(); return; }
      inline.append(search, list, feedback);
    } else if (!dialog.open()) return;
    render();
    search.focus();
  });
  heading.append(label, show);
  show.setAttribute('aria-expanded', 'false');
  overlay.append(heading, chips, inline);
  let auditionSequence = 0;

  function conflict(id: string) {
    const primary = options.current().resource;
    if (!primary) return t('请先选择主资源', 'Select a main resource first');
    if (primary === id) return t('已用作主资源', 'Already the main resource');
    if (!byId.has(primary)) return t('仅表情可以叠加', 'Overlays require a main expression');
    if (selected.size >= MAX_EXPRESSIONS - 1) return t('已达到组合上限', 'Combination limit reached');
    const resources = [primary, ...selected, id].map(key => byId.get(key));
    if (resources.some(resource => !resource)) return t('请先移除失效表情', 'Remove unavailable expressions first');
    try { expressionTracks(resources); }
    catch (error) {
      if (error instanceof ParameterConflict) {
        const detail = (error as Error & { detail: { parameter: string; existing: { title: string } } }).detail;
        return t('与 ', 'Conflicts with ') + detail.existing.title + ' · ' + detail.parameter;
      }
    }
    return '';
  }

  function change(id: string, checked: boolean) {
    if (checked) selected.add(id); else selected.delete(id);
    options.change();
    render();
  }

  function render() {
    show.disabled = expressions.length === 0 && selected.size === 0;
    label.textContent = t('叠加表情', 'Expression overlays') + (selected.size ? ' · ' + selected.size : '');
    chips.replaceChildren(...Array.from(selected, id => {
      const resource = byId.get(id);
      const name = resource?.title ?? id;
      const remove = c.button(name + ' ×', () => change(id, false));
      remove.setAttribute('aria-label', t('移除叠加 ', 'Remove overlay ') + name);
      if (!resource) remove.title = t('来源中已找不到此资源', 'Resource no longer exists');
      return remove;
    }));
    if (!dialog.element.open && inline.hidden) return;
    const q = search.value.trim().toLocaleLowerCase();
    const items = expressions.filter(r => r.title.toLocaleLowerCase().includes(q));
    const focused = c.doc.activeElement instanceof HTMLElement ? c.doc.activeElement.dataset.expression : undefined;
    list.replaceChildren(...items.map(resource => {
      const row = c.node('div', '', 'studio-expression-option');
      const checked = selected.has(resource.id);
      row.dataset.selected = String(checked);
      const audition = c.button(resource.title, () => void play(resource.id));
      audition.title = t('单独试播', 'Play this expression');
      const checkbox = c.node('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checked;
      checkbox.dataset.expression = resource.id;
      checkbox.setAttribute('aria-label', t('加入组合 ', 'Add to combination ') + resource.title);
      const problem = checked ? '' : conflict(resource.id);
      checkbox.disabled = !!problem;
      checkbox.addEventListener('change', () => change(resource.id, checkbox.checked), { signal: ctx.signal });
      row.append(audition, c.node('small', checked ? t('已加入', 'Added') : problem, 'studio-expression-hint'), checkbox);
      return row;
    }));
    if (!items.length) list.append(c.node('p', t('没有匹配的表情。', 'No matching expressions.'), 'studio-help'));
    if (focused) Array.from(list.querySelectorAll<HTMLElement>('[data-expression]')).find(input => input.dataset.expression === focused)?.focus();
  }

  async function play(id: string) {
    const sequence = ++auditionSequence;
    feedback.textContent = t('正在试播…', 'Starting preview…');
    try {
      await options.audition(id);
      if (!ctx.signal.aborted && sequence === auditionSequence) feedback.textContent = t('正在单独试播。', 'Playing this expression.');
    } catch (error) { if (!ctx.signal.aborted && sequence === auditionSequence) feedback.textContent = error instanceof Error ? error.message : String(error); }
  }

  search.addEventListener('input', render, { signal: ctx.signal });
  render();
  return { element: overlay, values: () => [...selected], render, dispose: () => dialog.element.remove() };
}
