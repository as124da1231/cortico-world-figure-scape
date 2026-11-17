import { characterWardrobePicker, type CharacterWardrobe } from './character-wardrobe.ts';
import { requiresBrowserPreview } from './preview-access.ts';
import { invokePanelBinary } from '../../base/api.ts';
import type { PageContext } from '../../base/page.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';
import type { NotificationKind } from './notifications.ts';

type CoverStatus = { phase: 'queued'|'rendering' } | { phase:'failed'; reason:string };
type Resource = { origin?: 'cabin-world'; builtin?: boolean; coverJob?: CoverStatus; id: string; name: string; kind: string; active: boolean; ready?: boolean; failed?: boolean; failure?: string; loading?: boolean; wardrobe?: boolean; sourceActive?: boolean; source?: string; cover?: string; sourceId?: string };
type LibraryOptions = {
  confirm: () => Promise<boolean>;
  changed: () => Promise<void>;
  notify: (message: string, kind?: NotificationKind) => void;
  edit: (id: string) => void;
  origin: () => string | undefined;
  activeActions: HTMLElement;
  review: (sourceId: string) => void;
  analyze: (resourceId: string) => void;
};

export function resourceLibrary(ctx: PageContext, options: LibraryOptions) {
  const c = studioControls(ctx);
  const element = c.node('section', '', 'studio-resource-view');
  const header = c.node('header', '', 'studio-resource-toolbar');
  const title = c.node('h2', t('模型库', 'Model library'));
  const search = c.node('input');
  search.type = 'search';
  search.placeholder = t('搜索模型', 'Search models');
  search.setAttribute('aria-label', search.placeholder);
  header.append(title, search);

  const grid = c.node('div', '', 'studio-model-grid');
  let retryingCovers = false;
  const retryCovers = c.button(t('重试封面', 'Retry covers'), () => void retryFailedCovers());
  retryCovers.classList.add('studio-cover-retry');
  retryCovers.hidden = true;
  header.append(retryCovers);
  const pages = c.node('div', '', 'studio-inline studio-library-pages');
  const previous = c.button(t('上一页', 'Previous'), () => { page--; render(); });
  const next = c.button(t('下一页', 'Next'), () => { page++; render(); });
  const countLabel = c.node('span', '', 'studio-help');
  pages.append(previous, countLabel, next);
  header.append(pages);
  element.append(header, grid);
  let rows: Resource[] = [];
  let page = 0;
  const pageSize = 24;
  let reading: Promise<void> | undefined;
  let activeRequest = '';
  let loaded = false;
  let reviewable = new Set<string>();
  const win = c.doc.defaultView!;
  const native = requiresBrowserPreview(win);
  const coverRequests = new Map<string, Promise<string>>();
  const coverStates = new WeakMap<HTMLElement, string>();
  const cardStates = new WeakMap<HTMLElement, string>();
  function coverUrl(resource: Resource, origin: string) {
    if (!native) return Promise.resolve(new URL(resource.cover!, origin).href);
    const key = resource.cover!;
    let pending = coverRequests.get(key);
    if (!pending) {
      pending = invokePanelBinary('world:desktop-live2d-pet', 'framework', 'resources.cover', [resource.id], { signal: ctx.signal })
        .then(blob => {
          if (ctx.signal.aborted) throw Error('Panel closed');
          const url = win.URL.createObjectURL(blob);
          ctx.signal.addEventListener('abort', () => win.URL.revokeObjectURL(url), { once: true });
          return url;
        })
        .catch(error => { coverRequests.delete(key); throw error; });
      coverRequests.set(key, pending);
    }
    return pending;
  }

  const removeDialog = c.dialog(t('移出模型库', 'Remove from library'), 'studio-confirm-dialog');
  const removeCopy = c.node('p', '', 'studio-help');
  const removeStatus = c.status();
  const removeFooter = c.node('footer', '', 'studio-dialog-actions');
  const removeConfirm = c.button(t('移出模型库', 'Remove from library'), () => { if (removing) void remove(removing); }, true);
  const removeCancel = c.button(t('取消', 'Cancel'), () => removeDialog.element.close());
  removeFooter.append(removeCancel, removeConfirm);
  removeDialog.body.append(removeCopy, removeStatus, removeFooter);
  let removing: Resource | undefined;
  let wardrobeRequest = 0;
  const wardrobe = c.dialog(t('快捷装扮', 'Quick outfit'), 'studio-character-wardrobe-dialog');
  options.activeActions.addEventListener('click', event => {
    if ((event.target as HTMLElement | null)?.closest('button') && wardrobe.element.open) wardrobe.element.close();
  }, { capture: true, signal: ctx.signal });
  async function openWardrobe(resource: Resource) {
    wardrobe.heading.textContent = t('快捷装扮 · ', 'Quick outfit · ') + resource.name;
    if (!wardrobe.open()) return;
    const ticket = ++wardrobeRequest;
    const status = c.status();
    status.textContent = t('正在读取…', 'Loading…');
    wardrobe.body.replaceChildren(status);
    try {
      const report = await c.call<CharacterWardrobe>('resources.characterWardrobe', [resource.id]);
      if (!wardrobe.element.open || ctx.signal.aborted || ticket !== wardrobeRequest) return;
      const picker = characterWardrobePicker(c.doc, report, t('zh','en') === 'zh');
      const apply = c.button(report.active ? t('穿上', 'Wear') : t('设为下次装扮', 'Use next time'), () => {
        apply.disabled = true;
        void c.call('resources.chooseWardrobe', [resource.id, picker.value()]).then(() => {
          wardrobe.element.close();
          options.notify(t('已保存装扮。', 'Outfit saved.'), 'info');
        }).catch(error => { status.textContent = errorText(error); apply.disabled = false; });
      }, true);
      wardrobe.body.replaceChildren(picker.element, status, apply);
      if (resource.active) wardrobe.body.append(options.activeActions);
    } catch (error) { status.textContent = errorText(error); }
  }

  function syncCover(item: HTMLElement, resource: Resource) {
    const visual = item.querySelector<HTMLElement>('.studio-model-cover')!;
    const status = visual.querySelector<HTMLElement>('.studio-cover-status')!;
    const base = options.origin();
    const key = JSON.stringify([resource.cover,resource.coverJob,base]);
    if (coverStates.get(visual) === key) return;
    coverStates.set(visual, key);
    visual.querySelector('img')?.remove();
    const job = resource.coverJob;
    const pending = job?.phase === 'queued' || job?.phase === 'rendering';
    visual.setAttribute('aria-busy', String(!!pending));
    status.title = job?.phase === 'failed' ? job.reason : '';
    status.textContent = resource.cover && base ? t('正在读取封面…','Loading cover…')
      : pending ? t('正在生成封面…','Generating cover…')
      : job?.phase === 'failed' ? t('封面未生成','Cover generation failed')
      : t('暂无封面','No cover');
    if (!resource.cover || !base) return;

    const image = c.node('img');
    image.alt = '';
    image.decoding = 'async';
    const current = () => !ctx.signal.aborted && coverStates.get(visual) === key;
    const failed = () => {
      if (!current()) return;
      image.remove();
      status.textContent = t('封面暂不可用', 'Cover unavailable');
    };
    image.addEventListener('load', () => { if (current()) status.textContent = ''; }, { once:true });
    image.addEventListener('error', failed, { once:true });
    void coverUrl(resource,base).then(src => {
      if (!current()) return;
      visual.prepend(image);
      image.src = src;
    },failed);
  }

  async function retryFailedCovers() {
    if (retryingCovers) return;
    const ids = rows.filter(item => !item.cover && item.coverJob?.phase === 'failed').map(item => item.id);
    if (!ids.length) return;
    retryingCovers = retryCovers.disabled = true;
    try {
      const results = await Promise.allSettled(ids.map(id => c.call('resources.retryCover', [id])));
      if (ctx.signal.aborted) return;
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') options.notify(errorText(failure.reason));
      await refreshAfterChange();
    } catch (error) { if (!ctx.signal.aborted) options.notify(errorText(error)); }
    finally { retryingCovers = retryCovers.disabled = false; }
  }

  function card(resource: Resource) {
    const item = c.node('article', '', 'studio-model-card');
    item.dataset.resource = resource.id;
    item.dataset.active = String(resource.active);
    if (resource.origin) item.dataset.origin = resource.origin;
    const identity = c.node('div', '', 'studio-model-identity');
    const visual = c.node('div', '', 'studio-model-cover');
    visual.append(
      c.node('span', '', 'studio-cover-status'),
      c.node('span', resource.builtin ? t('内置形象包', 'Built-in figure') : resource.origin === 'cabin-world' ? t('小屋世界 · Cabin World', 'Cabin World')
        : resource.kind === 'figure-pack' ? t('Coo 形象包', 'Coo figure') : t('原始 Live2D', 'Live2D source'), 'studio-model-source'),
    );
    item.append(visual);
    syncCover(item,resource);
    const info = c.node('div', '', 'studio-model-info');
    const name = c.node('h3', resource.name);
    name.title = resource.name;
    const originLabel = resource.builtin ? t('内置形象包', 'Built-in figure') : resource.origin === 'cabin-world' ? t('小屋世界 · Cabin World', 'Cabin World')
      : resource.source ?? (resource.kind === 'figure-pack' ? t('Coo 形象包', 'Coo figure') : t('原始 Live2D 模型', 'Original Live2D model'));
    item.title = originLabel;
    info.append(name);
    if (resource.failed && resource.failure) info.append(c.node('p', resource.failure, 'studio-help studio-model-failure'));
    identity.append(info);
    item.append(identity);

    const actions = c.node('div', '', 'studio-model-actions');
    function action(id: string, title: string, run: () => void, primary = false) {
      const button = c.button(title, run, primary);
      button.dataset.action = id;
      actions.append(button);
      return button;
    }
    const edit = action('edit', t('编辑角色', 'Edit character'), () => options.edit(resource.id), true);
    edit.title = t('在浏览器中编辑', 'Edit in the browser');
    const row = c.node('div', '', 'studio-model-shortcuts');
    actions.append(row);
    const request = activeRequest === resource.id;
    const label = request || resource.loading ? t('加载中…', 'Loading…') : resource.failed ? t('重试', 'Retry') : resource.active
      ? resource.ready ? t('使用中', 'In use') : t('待加载', 'Pending load') : t('使用', 'Use');
    const use = action('use', label, () => void choose(resource));
    use.disabled = !!activeRequest || resource.active && !resource.failed;
    row.append(use);
    const outfit = action('wardrobe', t('快捷装扮', 'Quick outfit'), () => void openWardrobe(resource));
    outfit.disabled = !resource.wardrobe || !!activeRequest;
    row.append(outfit);
    if (!resource.builtin) {
      const removeButton = action('remove', t('移除', 'Remove'), () => {
        removing = resource;
        const active = resource.active ? t('会停止使用这个角色。', 'The character will stop running.') : '';
        removeCopy.textContent = t('移出「', 'Remove “') + resource.name + t('」？原始文件和已保存的配置会保留。', '”? Source files and saved settings will be kept.') + active;
        removeStatus.textContent = '';
        removeDialog.open();
      });
      removeButton.disabled = !!activeRequest;
      row.append(removeButton);
    }
    if (resource.sourceId && reviewable.has(resource.sourceId)) {
      const sourceId = resource.sourceId;
      const review = action('review', t('审阅 Coo 方案', 'Review Coo proposal'), () => options.review(sourceId));
      review.classList.add('studio-model-review');
    }
    item.append(actions);
    return item;
  }

  function render() {
    const active = c.doc.activeElement as HTMLElement | null;
    const activeCard = active?.closest<HTMLElement>('.studio-model-card');
    const focusedId = activeCard?.dataset.resource;
    const focusedAction = active?.dataset.action;
    const byId = new Map([...grid.querySelectorAll<HTMLElement>('.studio-model-card')].map(element => [element.dataset.resource, element]));
    retryCovers.hidden = !rows.some(item => !item.cover && item.coverJob?.phase === 'failed');
    const query = search.value.trim().toLocaleLowerCase();
    const found = rows.filter(resource => [resource.name, resource.source].some(value => value?.toLocaleLowerCase().includes(query)));
    const count = Math.max(1, Math.ceil(found.length / pageSize));
    page = Math.max(0, Math.min(page, count - 1));
    pages.hidden = count < 2;
    previous.disabled = page === 0;
    next.disabled = page === count - 1;
    countLabel.textContent = (page + 1) + ' / ' + count;
    title.textContent = t('模型库', 'Model library');
    search.hidden = rows.length < 2 && !query;
    const cards = found.slice(page * pageSize, (page + 1) * pageSize).map(resource => {
      const { cover, coverJob, ...cardState } = resource;
      const signature = JSON.stringify([cardState, activeRequest, reviewable.has(resource.sourceId ?? '')]);
      const existing = byId.get(resource.id);
      if (existing && cardStates.get(existing) === signature) {
        syncCover(existing,resource);
        return existing;
      }
      const next = card(resource);
      cardStates.set(next, signature);
      return next;
    });
    if (cards.length !== grid.childElementCount || cards.some((entry,index) => entry !== grid.children[index])) {
      grid.replaceChildren(...cards);
    }
    if (!cards.length) grid.replaceChildren(c.node('p', !loaded ? t('正在读取模型库…', 'Reading model library…') : query
      ? t('没有匹配的模型。', 'No matching models.')
      : t('选择模型文件夹后，模型会显示在这里。', 'Choose a folder to add models here.'), 'studio-help'));
    for (const element of cards) {
      if (focusedId === element.dataset.resource && focusedAction && !active?.isConnected) {
        [...element.querySelectorAll<HTMLElement>('[data-action]')].find(button => button.dataset.action === focusedAction)?.focus({ preventScroll: true });
      }
    }
  }

  async function choose(resource: Resource) {
    if (activeRequest || ctx.signal.aborted) return;
    const trigger = c.doc.activeElement;
    if (!await options.confirm() || ctx.signal.aborted || activeRequest) return;
    activeRequest = resource.id;
    render();
    options.notify(t('正在切换角色…', 'Switching character…'), 'progress');
    try {
      const result = await c.call<{ modelApplied?: boolean }>('selectResource', [resource.id]);
      await options.changed();
      options.notify(result.modelApplied ? t('已切换到 ', 'Now using ') + resource.name
        : t('角色已选定，显示桌宠后加载。', 'Character selected. Show the pet to load it.'), 'info');
    } catch (error) { options.notify(errorText(error)); }
    finally {
      activeRequest = '';
      if (!ctx.signal.aborted) {
        await refreshAfterChange();
        render();
        if (trigger instanceof HTMLElement && !trigger.isConnected &&
          (c.doc.activeElement === c.doc.body || c.doc.activeElement === trigger)) {
          const model = rows.find(item => item.id === resource.id || resource.sourceId && item.sourceId === resource.sourceId);
          const card = [...grid.querySelectorAll<HTMLElement>('.studio-model-card')].find(item => item.dataset.resource === model?.id);
          const target = card?.querySelector<HTMLElement>(model?.active ? '[data-action=edit]' : '[data-action=use]');
          target?.focus({ preventScroll: true });
        }
      }
    }
  }

  async function remove(resource: Resource) {
    if (activeRequest || ctx.signal.aborted) return;
    activeRequest = resource.id;
    removeConfirm.disabled = removeCancel.disabled = true;
    removeStatus.textContent = t('正在移出…', 'Removing…');
    try {
      await c.call('resources.removeModel', [resource.id]);
      if (ctx.signal.aborted) return;
      rows = rows.filter(item => item.id !== resource.id);
      removeDialog.element.close();
      options.notify(t('已移出模型库。', 'Removed from the library.'), 'info');
    } catch (error) { if (!ctx.signal.aborted) removeStatus.textContent = errorText(error); }
    finally {
      activeRequest = '';
      removeConfirm.disabled = removeCancel.disabled = false;
      if (!ctx.signal.aborted) { await refreshAfterChange(); render(); }
    }
  }

  async function refreshAfterChange() {
    await reading;
    await refresh();
  }

  function refresh(): Promise<void> {
    if (ctx.signal.aborted) return Promise.resolve();
    reading ??= (async () => {
      try {
        const next = await c.call<Resource[]>('resources');
        if (ctx.signal.aborted) return;
        if (!Array.isArray(next)) throw Error(t('模型库返回的数据不可用。', 'The model library returned unavailable data.'));
        const models = next.filter(resource => resource.kind === 'live2d-model' || resource.kind === 'figure-pack');
        const changed = !loaded || JSON.stringify(rows) !== JSON.stringify(models);
        rows = models;
        loaded = true;
        if (changed) render();
      } catch (error) {
        if (!ctx.signal.aborted && !loaded) {
          options.notify(t('读取模型库失败。', 'Could not read the model library. ') + errorText(error));
          grid.replaceChildren(c.button(t('重试读取', 'Retry loading'), () => void refresh()));
        }
      }
    })().finally(() => { reading = undefined; });
    return reading;
  }

  function reveal(id: string) {
    const index = rows.findIndex(resource => resource.id === id);
    if (index < 0) return;
    search.value = '';
    page = Math.floor(index / pageSize);
    render();
    const item = [...grid.children].find((entry): entry is HTMLElement => (entry as HTMLElement).dataset.resource === id);
    item?.scrollIntoView?.({ block: 'nearest' });
  }

  ctx.root.addEventListener('pointerdown', event => {
    for (const menu of element.querySelectorAll<HTMLDetailsElement>('.studio-model-more[open]')) {
      if (!event.composedPath().includes(menu)) menu.open = false;
    }
  }, { signal: ctx.signal });
  search.addEventListener('input', () => { page = 0; render(); }, { signal: ctx.signal });
  render();
  return {
    element, toolbar: header, refresh, reveal, render,
    setReviewable(ids: Set<string>) {
      if (ids.size === reviewable.size && [...ids].every(id => reviewable.has(id))) return;
      reviewable = ids;
      render();
    },
  };
}
