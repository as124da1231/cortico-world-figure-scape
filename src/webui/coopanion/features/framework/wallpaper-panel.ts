import { invokePanelBinary } from '../../base/api.ts';
import type { PageContext } from '../../base/page.ts';
import { WORKSPACE_PROVIDER } from '../../../../framework/workspace.ts';
import { createWallpaperPlacementControl, type WallpaperComposition } from '../../../../../web/framework/wallpaper-placement-control.js';
import type { WallpaperOptions } from '../../../../framework/wallpaper-library.ts';
import { visibleScene, type RuntimeState } from './runtime.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';
import { encodeChunk, filePayload, readTransferredFiles, selectedFiles } from './import-files-ui.ts';
import type { sceneWorkspace } from './scene-workspace.ts';

type Item = { id: string; title: string; kind: 'image' | 'video' | 'scene' | 'web'; cover: boolean; composition: WallpaperComposition };
type Catalog = { items: Item[]; selected: string | null; options: WallpaperOptions };
const kindLabel = {
  image: t('图片', 'Image'), video: t('视频', 'Video'),
  scene: t('Wallpaper Engine 场景', 'Wallpaper Engine scene'), web: t('网页壁纸', 'Web wallpaper'),
};
const message = (error: unknown) => {
  const raw = errorText(error);
  return ({
    'wallpaper-source-unavailable': t('源文件已移动或无法读取。请重新导入。', 'The source moved or is unavailable. Import it again.'),
    'wallpaper-first-frame-failed': t('壁纸未能显示首帧，当前画面已保留。', 'The wallpaper could not draw its first frame. The current view is still active.'),
    'presentation-timeout': t('壁纸加载超时，可以再试一次。', 'The wallpaper took too long to load. Try again.'),
    'window-disconnected': t('桌宠已断开。恢复窗口后可以重试。', 'The pet disconnected. Reopen it and try again.'),
  } as Record<string, string>)[raw] ?? raw;
};

export function wallpaperPanel(ctx: PageContext, refreshRuntime: () => Promise<void>, workspace: ReturnType<typeof sceneWorkspace>) {
  const c = studioControls(ctx), win = c.doc.defaultView!;
  let state: Catalog | undefined, busy = false;
  let removal: Item | undefined, operation: string | undefined, upload: string | undefined;
  let cancelled = false, currentRender = 0, page = 0, libraryScroll = 0;
  let wallpaperMode = false, wallpaperError = false, activeWallpaper: string | undefined;
  let catalogKey = '';
  const covers = new Map<string, Promise<string>>();
  const section = c.section(t('壁纸', 'Wallpaper'));
  section.classList.add('studio-wallpaper-settings', 'studio-scene-settings');
  const title = section.querySelector('h2')!;
  title.textContent = t('背景与构图', 'Background and composition');
  const header = c.node('header', '', 'studio-wallpaper-header');
  const current = c.node('p', '', 'studio-help');
  const openLibrary = c.button(t('壁纸库', 'Wallpaper library'), () => open(openLibrary));
  const heading = c.node('div');
  heading.append(title, current);
  const compositionButton = c.button(t('角色构图', 'Character composition'), () => void openComposition());
  const headerActions = c.node('div','','studio-inline');
  headerActions.append(compositionButton,openLibrary);
  header.append(heading,headerActions);
  const controls = c.node('div', '', 'studio-wallpaper-options');
  const feedback = c.status();
  const fit = c.node('select');
  for (const [value, label] of [['cover', t('铺满画面', 'Fill frame')], ['contain', t('完整显示', 'Fit inside')]]) {
    const option = c.node('option', label); option.value = value; fit.append(option);
  }
  const scale = c.node('input'), volume = c.node('input'), interactive = c.node('input'), paused = c.node('input');
  interactive.type = paused.type = 'checkbox';
  const scaleRange = c.range(scale, 50, 200, '5', value => value + '%');
  const volumeRange = c.range(volume, 0, 100, '1', value => value + '%');
  controls.append(
    c.field(t('画面适应', 'Fit'), fit),
    c.field(t('背景缩放', 'Background scale'), scaleRange.element),
    c.field(t('壁纸音量', 'Wallpaper volume'), volumeRange.element, t('仅影响壁纸本身的声音，0% 为静音。', 'Wallpaper audio only. 0% mutes it.')),
    c.field(t('暂停动态壁纸', 'Pause animated wallpaper'), paused),
    c.field(t('壁纸响应鼠标', 'Wallpaper reacts to the pointer'), interactive,
      t('适用于支持鼠标互动的实时壁纸。', 'Available for live wallpapers with pointer interactions.')),
  );
  section.append(header, controls, feedback);
  fit.addEventListener('change', () => void update({fit:fit.value as WallpaperOptions['fit']}), {signal:ctx.signal});
  scale.addEventListener('change', () => void update({scale:scale.valueAsNumber / 100}), {signal:ctx.signal});
  volume.addEventListener('change', () => void update({volume:volume.valueAsNumber / 100}), {signal:ctx.signal});
  paused.addEventListener('change', () => void update({paused:paused.checked}), {signal:ctx.signal});
  interactive.addEventListener('change', () => void update({interactive:interactive.checked}), {signal:ctx.signal});

  const compositionBody = c.node('div', '', 'studio-wallpaper-composition');
  const compositionPage = {title: t('角色构图', 'Character composition'), body: compositionBody, close: releaseArt};
  const loadingArt = c.status();
  let artURLs: string[] = [], artRequest = 0;
  const composition = createWallpaperPlacementControl({
    doc:c.doc, text:t,
    async read(id) {
      await refresh();
      const item = state?.items.find(row => row.id === id);
      if (!item) throw Error(t('这张壁纸已移出壁纸库。','This wallpaper was removed from the library.'));
      return item;
    },
    async save(id, value, revision) {
      const saved = await c.call<WallpaperComposition>('wallpaper.setPlacement',[id,value,revision]);
      const item = state?.items.find(row => row.id === id);
      if (item) item.composition = saved;
      return saved;
    },
  });
  compositionBody.append(composition.element,loadingArt);
  function releaseArt() {
    artRequest++;
    composition.deactivate();
    composition.setArt();
    for (const url of artURLs) win.URL.revokeObjectURL(url);
    artURLs = [];
  }
  ctx.lifecycle.add(releaseArt);

  async function openComposition() {
    const item = state?.items.find(row => row.id === state?.selected);
    if (!item || workspace.showing(compositionPage)) return;
    workspace.open(compositionPage, compositionButton);
    const ticket = ++artRequest;
    composition.sync(item,true);
    composition.setArt();
    loadingArt.textContent = t('正在加载预览素材…','Loading preview artwork…');
    const binary = (method: string, id: string) => invokePanelBinary(WORKSPACE_PROVIDER,'framework',method,[id],{signal:ctx.signal});
    const runtime = c.call<{skin?:{figure?:string};presentationScales?:{wallpaper?:number}}>('runtime.state').catch(() => undefined);
    const [wallpaper,figure] = await Promise.all([
      item.cover ? binary('wallpaper.cover',item.id).catch(() => undefined) : undefined,
      runtime.then(value => value?.skin?.figure ? binary('resources.cover',value.skin.figure).catch(() => undefined) : undefined),
    ]);
    if (ticket !== artRequest || !workspace.showing(compositionPage) || ctx.signal.aborted) return;
    const current = await runtime;
    const url = (blob?: Blob) => {
      if (!blob) return;
      const value = win.URL.createObjectURL(blob);
      artURLs.push(value);
      return value;
    };
    composition.setArt({wallpaperURL:url(wallpaper),figureURL:url(figure),fit:state?.options.fit,
      scale:state?.options.scale,characterScale:current?.presentationScales?.wallpaper});
    loadingArt.textContent = !wallpaper && !figure ? t('暂无封面。可使用坐标与落点定位。','No cover art available. The coordinates and anchor can still be edited.')
      : !figure ? t('角色暂无封面，圆点标示落点。','The character has no cover. The dot marks the landing point.')
      : !wallpaper ? t('此壁纸暂无封面。','This wallpaper has no cover.') : '';
  }

  const body = c.node('div', '', 'studio-wallpaper-library');
  const libraryPage = {title: t('壁纸库', 'Wallpaper library'), body, close: closeLibrary};
  const libraryOpen = () => workspace.showing(libraryPage);
  const toolbar = c.node('div', '', 'studio-wallpaper-toolbar');
  const files = c.node('input'); files.type = 'file'; files.hidden = true;
  files.accept = '.png,.jpg,.jpeg,.webp,.avif,.gif,.mp4,.webm,.pkg,.zip';
  const folder = c.node('input'); folder.type = 'file'; folder.hidden = true; folder.setAttribute('webkitdirectory', '');
  const choose = c.button(t('添加壁纸', 'Add wallpaper'), () => {
    if (ctx.pickPath) void nativeFile(); else { files.value = ''; files.click(); }
  }, true);
  const chooseFolder = c.button(t('导入项目文件夹', 'Import project folder'), () => { folder.value = ''; folder.click(); });
  const steam = c.node('details', '', 'studio-wallpaper-steam');
  const steamTrigger = c.node('summary', t('Steam 库', 'Steam library'), 'studio-button');
  const steamPath = c.node('input'); steamPath.type = 'text';
  steamPath.placeholder = t('Steam 库路径（可留空）', 'Steam library path (optional)');
  steamPath.setAttribute('aria-label', steamPath.placeholder);
  const scan = c.button(t('查找壁纸', 'Find wallpapers'), () => void scanSteam());
  const steamOptions = c.node('div', '', 'studio-wallpaper-steam-options');
  steamOptions.append(steamPath, scan);
  steam.append(steamTrigger, steamOptions);
  const search = c.node('input'); search.type = 'search'; search.placeholder = t('搜索壁纸', 'Search wallpapers');
  search.setAttribute('aria-label', search.placeholder);
  toolbar.append(choose, chooseFolder, steam, search);
  const grid = c.node('div', '', 'studio-wallpaper-grid');
  const pages = c.node('div', '', 'studio-wallpaper-pages');
  const previous = c.button(t('上一页', 'Previous'), () => { page--; buildCards(); workspace.viewport.scrollTop = 0; });
  const next = c.button(t('下一页', 'Next'), () => { page++; buildCards(); workspace.viewport.scrollTop = 0; });
  const pageLabel = c.node('span', '', 'studio-help');
  pages.append(previous, pageLabel, next);
  const dialogStatus = c.status();
  const statusBar = c.node('footer', '', 'studio-dialog-actions studio-wallpaper-feedback');
  const cancel = c.button(t('取消操作', 'Cancel operation'), () => void cancelWork());
  cancel.hidden = true;
  const confirmation = c.node('div', '', 'studio-wallpaper-confirm');
  confirmation.hidden = true;
  statusBar.append(dialogStatus, cancel);
  body.append(toolbar, files, folder, grid, pages, confirmation, statusBar);
  search.addEventListener('input', () => { page = 0; buildCards(); workspace.viewport.scrollTop = 0; }, {signal:ctx.signal});
  for (const input of [files, folder]) input.addEventListener('change', () => {
    if (input.files?.length) void uploadFiles(() => selectedFiles(input.files!));
  }, {signal:ctx.signal});
  body.addEventListener('dragover', event => {
    if (!busy && event.dataTransfer?.types.includes('Files')) {
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; body.dataset.drag = 'true';
    }
  }, {signal:ctx.signal});
  body.addEventListener('dragleave', event => {
    if (!(event.relatedTarget instanceof win.Node) || !body.contains(event.relatedTarget)) delete body.dataset.drag;
  }, {signal:ctx.signal});
  body.addEventListener('drop', event => {
    delete body.dataset.drag;
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    const transfer = event.dataTransfer;
    void uploadFiles(() => readTransferredFiles(transfer));
  }, {signal:ctx.signal});
  function closeLibrary() {
    libraryScroll = workspace.viewport.scrollTop;
    removal = undefined;
    if (operation || upload) void cancelWork();
    for (const cover of covers.values()) void cover.then(url => win.URL.revokeObjectURL(url), () => {});
    covers.clear();
  }
  ctx.lifecycle.add(() => {
    if (upload) c.keepalive('wallpaper.cancelUpload', [upload]);
    if (operation) c.keepalive('operation.cancel', [operation]);
    for (const cover of covers.values()) void cover.then(url => win.URL.revokeObjectURL(url), () => {});
  });

  function sync() {
    const item = state?.items.find(row => row.id === state?.selected);
    current.textContent = item
      ? (activeWallpaper === item.id ? t('当前背景 · ', 'Current background · ') : t('已选背景 · ', 'Selected background · ')) + item.title
      : t('从壁纸库选择背景。', 'Choose a background from your wallpaper library.');
    controls.hidden = !item;
    compositionButton.disabled = busy || !item;
    openLibrary.textContent = wallpaperMode ? t('更换壁纸', 'Change wallpaper') : t('壁纸库', 'Wallpaper library');
    if (state) {
      const options = state.options;
      fit.value = options.fit;
      scale.value = String(options.scale * 100); scaleRange.sync();
      volume.value = String(options.volume * 100); volumeRange.sync();
      paused.checked = options.paused;
      interactive.checked = options.interactive;
    }
    for (const input of [fit, scale, volume, paused, interactive]) input.disabled = busy;
    volume.disabled ||= item?.kind === 'image';
    paused.disabled ||= item?.kind === 'image';
    interactive.disabled ||= item?.kind === 'image' || item?.kind === 'video';
    for (const button of [choose, chooseFolder, scan, ...grid.querySelectorAll('button')]) {
      button.disabled = busy || !!removal;
      const id = button.dataset.wallpaperChoice;
      if (!id) continue;
      const selected = id === state?.selected, active = id === activeWallpaper, retry = selected && wallpaperError;
      button.textContent = retry ? t('重新加载', 'Reload') : active ? t('使用中', 'In use') : selected ? t('已选定', 'Selected')
        : wallpaperMode ? t('切换到这张', 'Switch to this') : t('设为背景', 'Set as background');
      button.classList.toggle('is-primary', retry || !selected && !active);
      button.disabled ||= !retry && (active || selected);
    }
    search.disabled = busy || !!removal;
    for (const button of confirmation.querySelectorAll('button')) button.disabled = busy;
    cancel.hidden = !busy || (!upload && !operation);
  }

  function cover(item: Item) {
    let pending = covers.get(item.id);
    if (!pending) {
      pending = invokePanelBinary(WORKSPACE_PROVIDER, 'framework', 'wallpaper.cover', [item.id], {signal:ctx.signal})
        .then(blob => win.URL.createObjectURL(blob));
      covers.set(item.id, pending);
    }
    return pending;
  }

  function buildCards() {
    const token = ++currentRender;
    const scroll = workspace.viewport.scrollTop;
    const query = search.value.trim().toLocaleLowerCase();
    const list = (state?.items ?? []).filter(item => (item.title + ' ' + kindLabel[item.kind]).toLocaleLowerCase().includes(query));
    grid.replaceChildren();
    if (!list.length) {
      grid.append(c.node('p', query
        ? t('没有匹配的壁纸。', 'No matching wallpapers.')
        : t('拖入图片、视频或 Wallpaper Engine 项目文件夹。', 'Drop an image, video or Wallpaper Engine project folder here.'), 'studio-wallpaper-empty'));
    }
    const size = 16, total = Math.max(1, Math.ceil(list.length / size));
    page = Math.min(total - 1, Math.max(0, page));
    pages.hidden = total === 1 || !!removal;
    previous.disabled = page === 0;
    next.disabled = page === total - 1;
    pageLabel.textContent = (page + 1) + ' / ' + total;
    for (const item of list.slice(page * size, (page + 1) * size)) {
      const card = c.node('article', '', 'studio-wallpaper-card');
      card.dataset.wallpaperItem = item.id;
      card.tabIndex = -1;
      const thumbnail = c.node('div', '', 'studio-wallpaper-cover');
      const kind = c.node('span', kindLabel[item.kind], 'studio-wallpaper-kind');
      const placeholder = c.node('span', t('暂无封面', 'No cover'), 'studio-wallpaper-no-cover');
      thumbnail.append(placeholder, kind);
      if (item.cover) {
        const img = c.node('img'); img.alt = ''; img.loading = 'lazy';
        thumbnail.prepend(img);
        void cover(item).then(url => {
          if (token === currentRender && libraryOpen()) img.src = url;
        }, () => img.remove());
        img.addEventListener('load', () => { placeholder.hidden = true; }, {once:true,signal:ctx.signal});
        img.addEventListener('error', () => img.remove(), {once:true,signal:ctx.signal});
      }
      const name = c.node('h3', item.title);
      name.title = item.title;
      const actions = c.node('div', '', 'studio-inline');
      const use = c.button('', () => void activate(item));
      use.dataset.wallpaperChoice = item.id;
      const remove = c.button(t('移除', 'Remove'), () => askRemoval(item, remove));
      actions.append(use, remove);
      card.append(thumbnail, name, actions);
      grid.append(card);
    }
    sync();
    workspace.viewport.scrollTop = scroll;
  }

  function askRemoval(item: Item, opener?: HTMLButtonElement) {
    removal = item;
    confirmation.hidden = false;
    grid.hidden = pages.hidden = true;
    const keep = c.button(t('取消', 'Cancel'), () => {
      clearRemoval();
      opener?.focus();
    });
    const remove = c.button(t('移出壁纸库', 'Remove from library'), () => void run(async () => {
      await c.call('wallpaper.remove', [item.id]);
      clearRemoval();
      await refreshRuntime();
      dialogStatus.textContent = t('已从壁纸库移除。', 'Removed from the wallpaper library.');
    }), true);
    confirmation.replaceChildren(
      c.node('h3', t('移除壁纸', 'Remove wallpaper')),
      c.node('p', item.title + ' · ' + t('保留原始文件。', 'The source files are kept.')),
      ...(item.id === state?.selected ? [c.node('p', t('壁纸场景使用这张背景时，移除会先回到桌面。', 'If this background is in use, the pet returns to the desktop before it is removed.'))] : []),
      keep, remove,
    );
    sync(); keep.focus();
  }

  function clearRemoval() {
    removal = undefined;
    confirmation.replaceChildren();
    confirmation.hidden = true;
    grid.hidden = false;
    pages.hidden = !(previous.disabled === false || next.disabled === false);
    sync();
  }

  async function refresh() {
    state = await c.call<Catalog>('wallpaper.state');
    const key = JSON.stringify(state.items.map(({id,title,kind,cover}) => [id,title,kind,cover]));
    if (libraryOpen() && key !== catalogKey) buildCards(); else sync();
    catalogKey = key;
  }

  function open(opener?: HTMLElement) {
    if (libraryOpen()) return;
    workspace.open(libraryPage, opener);
    clearRemoval();
    dialogStatus.textContent = '';
    buildCards();
    workspace.viewport.scrollTop = libraryScroll;
    void refresh().catch(error => { if (!ctx.signal.aborted) dialogStatus.textContent = message(error); });
  }

  async function run(work: () => Promise<void>, status = dialogStatus) {
    if (busy || ctx.signal.aborted) return;
    busy = true; cancelled = false; sync(); status.textContent = '';
    try { await work(); await refresh(); }
    catch (error) { if (!ctx.signal.aborted && !cancelled) status.textContent = message(error); sync(); }
    finally { busy = false; if (!ctx.signal.aborted) sync(); }
  }

  async function update(patch: Partial<WallpaperOptions>) {
    await run(async () => { state = await c.call<Catalog>('wallpaper.options', [patch]); }, feedback);
  }

  async function nativeFile() {
    await run(async () => {
      const options = {kind:'file' as const,extensions:['.png','.jpg','.jpeg','.webp','.avif','.gif','.mp4','.webm','.pkg','.json']};
      const path = await ctx.pickPath?.(options);
      if (!path) return;
      await c.call('wallpaper.import', [path]);
      dialogStatus.textContent = t('壁纸已添加到库。', 'Wallpaper added to the library.');
    });
  }

  async function scanSteam() {
    await run(async () => {
      dialogStatus.textContent = t('正在查找本机 Steam 壁纸…', 'Looking for local Steam wallpapers…');
      const result = await c.call<{found:number; added:number; skipped:number}>('wallpaper.scan', steamPath.value.trim() ? [steamPath.value.trim()] : []);
      dialogStatus.textContent = result.found || result.skipped
        ? t('找到 ', 'Found ') + result.found + t(' 张，新增 ', ', added ') + result.added + (result.skipped ? t('，无法读取 ', ', unreadable ') + result.skipped : '')
        : t('此处没有找到已下载的壁纸。可以填写另一个 Steam 库路径。', 'No downloaded wallpapers were found here. You can enter another Steam library path.');
    });
  }

  async function uploadFiles(read: () => ReturnType<typeof selectedFiles> | Promise<ReturnType<typeof selectedFiles>>) {
    await run(async () => {
      dialogStatus.textContent = t('正在读取壁纸文件…', 'Reading wallpaper files…');
      const payload = filePayload(await read());
      if (cancelled || !libraryOpen() || ctx.signal.aborted) return;
      const {id} = await c.call<{id:string}>('wallpaper.beginUpload', [payload.kind, payload.blob.size]);
      upload = id; sync();
      try {
        for (let offset = 0; offset < payload.blob.size; offset += 1_000_000) {
          if (cancelled || ctx.signal.aborted || !libraryOpen()) return;
          const chunk = await encodeChunk(payload.blob.slice(offset, offset + 1_000_000));
          const receipt = await c.call<{done:number;total:number}>('wallpaper.appendUpload', [id, offset, chunk]);
          if (!cancelled) dialogStatus.textContent = t('正在导入壁纸… ', 'Importing wallpaper… ') + Math.floor(receipt.done / receipt.total * 100) + '%';
        }
        if (cancelled || ctx.signal.aborted || !libraryOpen()) return;
        await c.call('wallpaper.finishUpload', [id]);
        dialogStatus.textContent = t('壁纸已添加到库。', 'Wallpaper added to the library.');
      } finally { c.keepalive('wallpaper.cancelUpload', [id]); upload = undefined; }
    });
  }

  async function activate(item: Item) {
    await run(async () => {
      const request = win.crypto.randomUUID();
      operation = wallpaperMode ? request : undefined;
      sync();
      dialogStatus.textContent = operation
        ? t('正在加载新壁纸…', 'Loading the new wallpaper…') : t('正在保存背景选择…', 'Saving the selected background…');
      try {
        const result = await c.call<{phase:string;applied:boolean;selectionOnly?:boolean;error?:string}>('wallpaper.choose', [item.id, request]);
        if (result.phase === 'failed') throw Error(result.error ?? 'wallpaper-first-frame-failed');
        if (result.phase !== 'completed') return;
        dialogStatus.textContent = result.applied ? t('壁纸已切换。', 'Wallpaper switched.')
          : result.selectionOnly ? t('已设为壁纸场景的背景。', 'Background saved for wallpaper mode.')
            : t('已选定。显示桌宠后加载这张壁纸。', 'Selected. The wallpaper will load when the pet is shown.');
      } finally { operation = undefined; }
    });
    await refreshRuntime();
    if (libraryOpen() && !body.contains(c.doc.activeElement)) {
      grid.querySelector<HTMLElement>(`[data-wallpaper-item="${item.id}"]`)?.focus({preventScroll:true});
    }
  }

  async function cancelWork() {
    cancelled = true;
    cancel.disabled = true;
    try {
      if (operation) {
        const receipt = await c.call<{phase?:string} | null>('operation.cancel', [operation]);
        if (receipt?.phase === 'committing' || receipt?.phase === 'completed') {
          cancelled = false;
          return;
        }
      }
      if (upload) await c.call('wallpaper.cancelUpload', [upload]);
      dialogStatus.textContent = t('操作已取消。', 'Operation cancelled.');
    } catch (error) { if (!ctx.signal.aborted) dialogStatus.textContent = message(error); }
    finally { cancel.disabled = false; }
  }

  sync();
  function renderRuntime(next: RuntimeState) {
    const inCabin = ['connecting','active','leaving'].includes(next.cabinWorld?.phase ?? '');
    const selected = !inCabin && next.presentation?.desired === 'wallpaper';
    const error = !!(selected && (next.presentation?.details?.wallpaper?.kind === 'failed'
      || next.presentation?.applied !== 'wallpaper' && next.presentation?.error));
    const inUse = visibleScene(next) === 'wallpaper';
    const active = inUse && !error ? next.presentation?.details?.wallpaper?.id : undefined;
    if (wallpaperMode === inUse && activeWallpaper === active && wallpaperError === error) return;
    wallpaperMode = inUse;
    wallpaperError = error;
    activeWallpaper = active;
    sync();
  }

  return { section, openLibrary, open, refresh, renderRuntime, hasSelection: () => !!state?.selected };
}

