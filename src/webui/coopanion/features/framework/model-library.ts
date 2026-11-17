import { encodeChunk, filePayload, localClipboardPaths, selectedFiles, readTransferredFiles } from './import-files-ui.ts';
import type { PageContext } from '../../base/page.ts';
import type { ModelOperation } from '../../../../framework/model-domain.ts';
import { workspaceHref } from '../../../../framework/workspace.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';
import { resourceLibrary } from './resources.ts';
import type { NotificationKind } from './notifications.ts';
import type { RuntimeState } from './runtime.ts';

type Candidate = { id: string; title: string; file: string };
type Discovery = { models: Candidate[]; problems: { file: string; reason: string }[]; truncated: boolean };
type Adaptation = { mode: 'none' | 'manual' | 'ai'; automatic: boolean; confirmFallback: boolean };
type Proposal = { id: string; sourceId: string; target: Candidate; status: string; bindings: {word: string; resource: string; overlays?: string[]}[]; skipped: string[]; reviewWarnings: string[]; requiresConfirmation: boolean };
type Cache = { prunable: string[]; deleted?: string[]; failed?: { id: string; reason: string }[] };

export function modelLibrary(
  ctx: PageContext, editor: { confirmDiscard(): Promise<boolean>; refresh(): Promise<void>; dirty?(): boolean },
  refresh: () => Promise<void>, notify: (value: string, kind?: NotificationKind) => void, edit: (id: string) => void, activeActions: HTMLElement,
  openRuntimeComponents: () => void,
  phoneEntry: HTMLElement,
) {
  const c = studioControls(ctx), win = c.doc.defaultView!;
  const element = c.node('div', '', 'studio-workbench');
  const toolbar = c.node('section', '', 'studio-import');
  const buttons = c.node('div', '', 'studio-import-actions');
  const dropTarget = c.node('div', '', 'studio-drop-target');
  const dropTitle = c.node('strong', t('拖入模型文件夹或 ZIP', 'Drop a model folder or ZIP'));
  const dropHint = c.node('span', t('支持原始 Live2D 模型和 Coo 形象包', 'Live2D sources and Coo figure packages'));
  const dropCopy = c.node('div', '', 'studio-drop-copy');
  dropCopy.append(dropTitle, dropHint);
  const importMenu = c.node('details', '', 'studio-import-menu');
  const menuTrigger = c.node('summary', '', 'studio-button');
  menuTrigger.setAttribute('aria-label', t('更多导入方式', 'More import options'));
  menuTrigger.title = menuTrigger.getAttribute('aria-label')!;
  const menuItems = c.node('div', '', 'studio-import-options-list');
  importMenu.append(menuTrigger, menuItems);
  const folderInput = c.node('input');
  folderInput.type = 'file';
  folderInput.setAttribute('webkitdirectory', '');
  folderInput.hidden = true;
  const zipInput = c.node('input');
  zipInput.type = 'file';
  zipInput.accept = '.zip,application/zip';
  zipInput.hidden = true;
  const choose = c.button(t('导入文件夹', 'Import folder'), () => {
    folderInput.value = '';
    folderInput.click();
  }, true);
  const zipChoice = c.button(t('导入 ZIP', 'Import ZIP'), () => {
    importMenu.open = false;
    zipInput.value = '';
    zipInput.click();
  });
  const cabinImport = c.dialog(t('从小屋世界导入角色', 'Import a Cabin World character'), 'studio-editor-form');
  const cabinList = c.node('div', '', 'studio-resource-list');
  const cabinStatus = c.status();
  const cabinSetup = c.node('a', t('连接小屋世界', 'Connect Cabin World'), 'studio-link');
  cabinSetup.href = workspaceHref('desktop', 'cabin');
  cabinSetup.hidden = true;
  cabinImport.body.append(cabinStatus, cabinSetup, cabinList);
  const cabinChoice = c.button(t('从小屋世界导入', 'Import from Cabin World'), () => {
    importMenu.open = false;
    if (cabinImport.open(menuTrigger)) void readCabin();
  });
  menuItems.append(zipChoice, cabinChoice);
  c.doc.addEventListener('click', event => {
    if (importMenu.open && event.target instanceof win.Node && !importMenu.contains(event.target)) importMenu.open = false;
  }, { signal: ctx.signal });
  importMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape' && importMenu.open) {
      event.preventDefault();
      importMenu.open = false;
      menuTrigger.focus();
    }
  }, { signal: ctx.signal });
  const progress = c.node('progress');
  progress.setAttribute('aria-label', t('模型任务进度', 'Model task progress'));
  const cancel = c.button(t('取消导入', 'Cancel import'), () => void cancelLoad());
  const activity = c.node('div', '', 'studio-operation');
  const feedback = c.status();
  const idleHint = '';
  feedback.textContent = idleHint;
  const importDetails = c.dialog(t('导入结果', 'Import result'));
  const detailsText = c.node('p', '', 'studio-full-feedback');
  importDetails.body.append(detailsText);
  const showDetails = c.button(t('导入详情', 'Import details'), () => importDetails.open());
  showDetails.hidden = true;
  const feedbackSlot = c.node('div', '', 'studio-import-status');
  feedbackSlot.append(feedback, showDetails);
  const retry = c.button(t('重试', 'Retry'), () => { if (lastLoad) void load(lastLoad.method, lastLoad.value); });
  buttons.append(choose, importMenu);
  dropTarget.append(dropCopy, buttons);
  toolbar.tabIndex = 0;
  toolbar.setAttribute('role', 'region');
  toolbar.setAttribute('aria-label', t('模型导入区，可拖入或粘贴文件', 'Model import area. Drop or paste files.'));
  activity.append(progress, feedbackSlot, cancel, retry);
  toolbar.append(dropTarget, activity, folderInput, zipInput);
  const entries = c.node('div', '', 'studio-workbench-entries');
  entries.append(toolbar, phoneEntry);
  element.append(entries);

  const candidates = c.dialog(t('选择要导入的模型', 'Choose a model to import'), 'studio-candidates-dialog');
  const foundList = c.node('div', '', 'studio-resource-list');
  const foundStatus = c.status();
  const problems = c.node('details', '', 'studio-import-problems');
  candidates.body.append(foundStatus, foundList, problems);
  const manage = c.dialog(t('模型缓存', 'Model cache'));
  const manageStatus = c.status();
  const cleanup = c.button(t('清理可移除缓存', 'Clear unused cache'), () => void cache(true));
  manage.body.append(manageStatus, cleanup);
  const maintenance = c.node('div', '', 'studio-model-maintenance');
  const cacheButton = c.button(t('管理缓存', 'Manage cache'), () => { manage.open(); void cache(false); });
  const adaptation = c.dialog(t('导入偏好', 'Import preferences'), 'studio-import-options');
  const strategy = c.node('fieldset', '', 'studio-import-modes');
  strategy.append(c.node('legend', t('导入后的动作绑定', 'Action bindings after import')));
  const modes = [
    ['none', t('直接导入', 'Import directly'), t('使用通用表情和动作。', 'Use standard expressions and actions.')],
    ['manual', t('手动编辑', 'Edit manually'), t('从模型卡片打开编辑，自己绑定动作与表情。', 'Open the model card to bind its actions and expressions.')],
    ['ai', t('交给 Coo 分析', 'Ask Coo'), t('导入后可让 Coo 分析，再从模型卡片审阅方案。', 'Ask Coo after importing, then review the proposal on the model card.')],
  ] as const;
  const modeInputs = modes.map(([value, label, description]) => {
    const input = c.node('input');
    input.type = 'radio';
    input.name = 'studio-adaptation-mode';
    input.value = value;
    strategy.append(c.field(label, input, description));
    return input;
  });
  const fallback = c.node('input'); fallback.type = 'checkbox';
  const automatic = c.node('input'); automatic.type = 'checkbox';
  const advanced = c.node('div', '', 'studio-adaptation-advanced');
  advanced.append(
    c.field(t('自动采用可靠建议', 'Apply reliable suggestions automatically'), automatic),
    c.field(t('降级前确认', 'Confirm before fallback'), fallback,
      t('需要沿用通用表现时先征求确认。', 'Ask before falling back to standard behavior.')),
  );
  function chosenMode() { return modeInputs.find(input => input.checked)?.value ?? 'manual'; }
  function syncMode() {
    const active = chosenMode() === 'ai';
    automatic.disabled = fallback.disabled = !active;
    advanced.dataset.enabled = String(active);
  }
  strategy.addEventListener('change', syncMode, { signal: ctx.signal });
  const adaptationStatus = c.status();
  const saveAdaptation = c.button(t('保存', 'Save'), () => void updateAdaptation(true), true);
  const preferencesActions = c.node('footer', '', 'studio-dialog-actions');
  preferencesActions.append(adaptationStatus, c.button(t('取消', 'Cancel'), () => adaptation.element.close()), saveAdaptation);
  adaptation.body.append(strategy, advanced, preferencesActions);
  const adaptationButton = c.button(t('导入偏好', 'Import preferences'), () => {
    importMenu.open = false;
    if (adaptation.open(menuTrigger)) void updateAdaptation(false);
  });
  menuItems.append(adaptationButton);
  const pendingReviews = c.button(t('待审方案', 'Pending proposals'), () => openReview());
  pendingReviews.hidden = true;
  maintenance.append(pendingReviews, cacheButton);

  const reviewDialog = c.dialog(t('审阅 Coo 方案', 'Review Coo proposal'));
  const reviewList = c.node('div', '', 'studio-review-list');
  const reviewStatus = c.status();
  reviewDialog.body.append(reviewList, reviewStatus);

  let state: RuntimeState | undefined, stage:  'picker' | 'discovery' | 'loading' | 'upload' | null = null;
  let upload: string | undefined, uploadEpoch = 0, adaptationMode = 'none';
  let operationId: string | undefined, cancelling = false, discoveryCancelled = false;
  let lastLoad: { method: string; value: string } | undefined;
  const recovery = c.button(t('检查运行组件', 'Check runtime components'), openRuntimeComponents);
  recovery.hidden = true;
  activity.append(recovery);

  function sync() {
    const locked = !!stage || state?.canOpenLive2d === false || !!state?.framework.model?.busy;
    for (const control of [choose, zipChoice, cabinChoice, folderInput, zipInput, adaptationButton]) control.disabled = locked;
    menuTrigger.tabIndex = locked ? -1 : 0;
    menuTrigger.setAttribute('aria-disabled', String(locked));
    if (locked) importMenu.open = false;
    cancel.hidden = !stage || stage === 'picker';
    cancel.disabled = cancelling;
    progress.hidden = stage !== 'discovery' && stage !== 'loading' && stage !== 'upload';
    retry.disabled = locked;
    toolbar.setAttribute('aria-busy', String(!progress.hidden));
    for (const button of foundList.querySelectorAll('button')) button.disabled = locked;
  }

  async function changed() {
    await Promise.all([editor.refresh(), refresh()]);
  }
  const library = resourceLibrary(ctx, {
    confirm: editor.confirmDiscard, changed, edit, notify, activeActions,
    origin: () => state?.url ?? undefined,
    review: sourceId => openReview(sourceId),
    analyze: id => void analyzeImported(id),
  });
  library.toolbar.append(maintenance);
  element.append(library.element);

  let readingCabin = false, importingCabin = false;
  async function readCabin() {
    if (readingCabin || importingCabin) return;
    readingCabin = true;
    cabinSetup.hidden = true;
    cabinList.replaceChildren();
    cabinStatus.textContent = t('正在读取原版角色…', 'Reading original characters…');
    try {
      const state = await c.call<{configured: boolean}>('cabin.state');
      if (ctx.signal.aborted || !cabinImport.element.open) return;
      if (!state.configured) {
        cabinStatus.textContent = t('先连接小屋世界的安装目录。', 'Connect your Cabin World installation first.');
        cabinSetup.hidden = false;
        return;
      }
      const figures = await c.call<Array<{key:string;name:string}>>('cabin.figures');
      if (ctx.signal.aborted || !cabinImport.element.open) return;
      cabinStatus.textContent = figures.length ? '' : t('这个安装里没有可导入的角色素材。', 'No importable characters were found.');
      for (const figure of figures) {
        const item = c.node('div', '', 'studio-cabin-import-row');
        const add = c.button(t('导入', 'Import'), () => void importCabin(figure), true);
        add.setAttribute('aria-label', t('导入 ', 'Import ') + figure.name);
        item.append(c.node('strong', figure.name), add);
        cabinList.append(item);
      }
    } catch (error) { if (!ctx.signal.aborted) cabinStatus.textContent = errorText(error); }
    finally { readingCabin = false; }
  }

  async function importCabin(figure: {key:string;name:string}) {
    if (importingCabin) return;
    importingCabin = true;
    const buttons = cabinList.querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    cabinStatus.textContent = t('正在导入 ', 'Importing ') + figure.name;
    try {
      const {imported} = await c.call<{imported: string}>('cabin.importFigure', [figure.key]);
      if (ctx.signal.aborted) return;
      if (cabinImport.element.open) cabinImport.element.close();
      await library.refresh();
      library.reveal(imported);
      notify(t('已加入角色库。', 'Added to your character library.'), 'success');
    } catch (error) {
      if (!ctx.signal.aborted) cabinStatus.textContent = errorText(error);
    } finally {
      importingCabin = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  async function updateAdaptation(save: boolean) {
    const controls = [strategy, saveAdaptation];
    for (const control of controls) control.disabled = true;
    adaptationStatus.textContent = save ? t('正在保存…', 'Saving…') : t('正在读取…', 'Reading…');
    try {
      const next = save
        ? await c.call<Adaptation>('resources.configureAdaptation', [{ mode: chosenMode(), automatic: automatic.checked, confirmFallback: fallback.checked }])
        : (await c.call<{ options?: Adaptation }>('resources.adaptationState')).options;
      if (ctx.signal.aborted) return;
      if (!next) throw Error(t('适配服务不可用。', 'Adaptation is unavailable.'));
      adaptationMode = next.mode;
      for (const input of modeInputs) input.checked = input.value === next.mode;
      syncMode();
      automatic.checked = next.automatic;
      fallback.checked = next.confirmFallback;
      adaptationStatus.textContent = '';
      if (save) {
        adaptation.element.close();
        notify(t('导入偏好已保存。', 'Import preferences saved.'));
      }
    } catch (error) { if (!ctx.signal.aborted) adaptationStatus.textContent = errorText(error); }
    finally { if (!ctx.signal.aborted) for (const control of controls) control.disabled = false; }
  }

  let requestedAnalysis: string | undefined;
  let reviewTarget = '';
  let proposalBusy = false;
  let proposals: Proposal[] = [];
  async function analyzeImported(id: string) {
    notify(t('正在向 Coo 请求分析…', 'Requesting analysis from Coo…'));
    try {
      const result = await c.call<{ id: string }>('resources.analyzeModel', [id]);
      requestedAnalysis = result.id;
      notify(t('已交给 Coo 分析。方案会出现在该模型卡片上。', 'Sent to Coo. The proposal will appear on the model card.'));
    } catch (error) { notify(errorText(error)); }
  }
  function openReview(sourceId = '') {
    if (!reviewDialog.open()) return;
    reviewTarget = sourceId;
    reviewStatus.textContent = '';
    renderProposals();
  }
  function renderProposals() {
    const current = proposals.filter(plan => reviewTarget
      ? plan.sourceId === reviewTarget && plan.status !== 'rejected'
      : plan.status === 'pending' || plan.status === 'approved').slice(-12).reverse();
    reviewList.replaceChildren();
    if (!current.length) reviewList.append(c.node('p', t('暂无方案。', 'There is no proposal yet.'), 'studio-help'));
    for (const plan of current) {
      const card = c.section(plan.target.title);
      const content = c.node('div', '', 'studio-proposal-bindings');
      content.append(...plan.bindings.map(binding => c.node('p', binding.word + ' → ' + [binding.resource, ...binding.overlays ?? []].join(' + '))),
        ...plan.reviewWarnings.map(warning => c.node('p', warning)),
        ...(plan.skipped.length ? [c.node('p', t('保留通用表现', 'Keep generic behavior') + ' · ' + plan.skipped.join('、'))] : []));
      card.append(content);
      const controls = c.node('div', '', 'studio-inline');
      if (plan.status === 'saved') controls.append(c.node('span', t('绑定已保存', 'Bindings saved')));
      else if (plan.status !== 'executing') controls.append(
        c.button(t('采用方案', 'Apply proposal'), () => void settleProposal(plan, true), true),
        c.button(t('拒绝', 'Reject'), () => void settleProposal(plan, false)),
      );
      card.append(controls);
      reviewList.append(card);
    }
  }
  async function settleProposal(plan: Proposal, accept: boolean) {
    if (proposalBusy) return;
    proposalBusy = true;
    for (const button of reviewList.querySelectorAll('button')) button.disabled = true;
    try {
      if (accept) {
        if (editor.dirty?.()) { reviewStatus.textContent = t('请先保存或放弃当前编辑草稿。','Save or discard the current editor draft first.'); return; }
        await c.call('resources.approveAdaptation', [plan.id]);
        await c.call('resources.applyAdaptation', [plan.id]);
        reviewStatus.textContent = t('绑定已保存。可重新加载该模型应用。', 'Bindings saved. Reload the model to apply them.');
      } else await c.call('resources.rejectAdaptation', [plan.id]);
      updateProposals((await c.call<{plans: Proposal[]}>('resources.adaptationState')).plans);
    } catch (error) { reviewStatus.textContent = errorText(error); }
    finally { proposalBusy = false; renderProposals(); }
  }
  async function cache(prune: boolean) {
    cleanup.disabled = true;
    manageStatus.textContent = prune ? t('正在检查引用并清理…', 'Checking references and clearing…') : t('正在读取…', 'Reading…');
    try {
      const result = await c.call<Cache | null>(prune ? 'resources.pruneCache' : 'resources.cacheState');
      if (!result) {
        manageStatus.textContent = t('模型缓存服务不可用。', 'The model cache is unavailable.');
        return;
      }
      const count = result.prunable.length;
      cleanup.disabled = count === 0;
      manageStatus.textContent = (prune ? t('已清理 ', 'Cleared ') + (result.deleted?.length ?? 0) + ' · ' : '')
        + t('可清理 ', 'Ready to clear ') + count + ' · ' + t('源模型和配置会保留。', 'Source files and model settings are kept.')
        + (result.failed?.length ? '\n' + result.failed.map(item => item.reason).join('\n') : '');
    } catch (error) { if (!ctx.signal.aborted) manageStatus.textContent = errorText(error); }
  }




  menuTrigger.addEventListener('click', event => { if (choose.disabled) event.preventDefault(); }, { signal: ctx.signal });
  async function importPaths(paths: string[]) {
    stage = 'discovery'; discoveryCancelled = false;
    retry.hidden = showDetails.hidden = recovery.hidden = true;
    feedback.textContent = t('正在查找模型…', 'Finding models…');
    sync();
    try {
      const result = await c.call<Discovery>('resources.importPaths', [paths]);
      if (!ctx.signal.aborted && !discoveryCancelled) return result;
    } finally { stage = null; sync(); }
  }
  async function completeDiscovery(result: Discovery | undefined) {
    if (!result || ctx.signal.aborted) return;
    if (result.models.length === 1 && !result.truncated) {
      await load('resources.importCandidate', result.models[0].id);
      if (result.problems.length) {
        detailsText.textContent = [detailsText.textContent, ...result.problems.map(problem => problem.file + ' · ' + problem.reason)].filter(Boolean).join('\n');
        showDetails.hidden = false;
      }
      return;
    }
    showCandidates(result);
  }
  async function importFiles(read: () => Promise<ReturnType<typeof selectedFiles>> | ReturnType<typeof selectedFiles>) {
    if (choose.disabled || stage || ctx.signal.aborted) return;
    let result: Discovery | undefined;
    stage = 'upload';
    discoveryCancelled = false;
    retry.hidden = showDetails.hidden = recovery.hidden = true;
    feedback.textContent = t('正在读取导入文件…', 'Reading import files…');
    sync();
    const token = ++uploadEpoch;
    try {
      const files = await read();
      if (token !== uploadEpoch || ctx.signal.aborted) return;
      const { kind, blob } = filePayload(files);
      const { id } = await c.call<{id: string}>('resources.beginUpload', [kind, blob.size]);
      if (token !== uploadEpoch || ctx.signal.aborted) { c.keepalive('resources.cancelUpload', [id]); return; }
      upload = id;
      for (let offset = 0; offset < blob.size; offset += 1_000_000) {
        const chunk = await encodeChunk(blob.slice(offset, offset + 1_000_000));
        if (token !== uploadEpoch || ctx.signal.aborted) return;
        const receipt = await c.call<{done: number; total: number}>('resources.appendUpload', [id, offset, chunk]);
        if (token !== uploadEpoch || ctx.signal.aborted) return;
        progress.max = receipt.total; progress.value = receipt.done;
        feedback.textContent = t('正在传入模型文件…', 'Transferring model files…') + ' ' + Math.floor(receipt.done / receipt.total * 100) + '%';
      }
      progress.removeAttribute('value');
      feedback.textContent = t('正在识别模型和形象包…', 'Checking models and figure packages…');
      result = await c.call<Discovery>('resources.finishUpload', [id]);
      if (token !== uploadEpoch) result = undefined;
    } catch (error) { if (!ctx.signal.aborted && !discoveryCancelled) feedback.textContent = errorText(error); }
    finally {
      if (upload) c.keepalive('resources.cancelUpload', [upload]);
      upload = undefined; stage = null; progress.removeAttribute('value'); sync();
    }
    await completeDiscovery(result);
  }
  async function fromTransfer(transfer: DataTransfer) {
    if (choose.disabled || stage || ctx.signal.aborted) return;
    if (transfer.types.includes('Files') || transfer.files.length) {
      await importFiles(() => readTransferredFiles(transfer));
      return;
    }
    const paths = localClipboardPaths(transfer.getData('text/plain'));
    if (!paths.length) return;
    try { await completeDiscovery(await importPaths(paths)); }
    catch (failure) { if (!ctx.signal.aborted && !discoveryCancelled) feedback.textContent = errorText(failure); }
  }
  for (const input of [folderInput, zipInput]) input.addEventListener('change', () => {
    const files = selectedFiles(input.files ?? []);
    if (files.length) void importFiles(() => files);
    input.value = '';
  }, { signal: ctx.signal });
  element.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = choose.disabled ? 'none' : 'copy';
    if (!choose.disabled) toolbar.dataset.dragging = 'true';
  }, { signal: ctx.signal });
  element.addEventListener('dragleave', event => {
    if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) delete toolbar.dataset.dragging;
  }, { signal: ctx.signal });
  element.addEventListener('drop', event => {
    delete toolbar.dataset.dragging;
    if (!event.dataTransfer?.types.includes('Files') && !event.dataTransfer?.files.length) return;
    event.preventDefault();
    void fromTransfer(event.dataTransfer);
  }, { signal: ctx.signal });
  toolbar.addEventListener('paste', event => {
    const transfer = event.clipboardData;
    if (!transfer || !transfer.files.length && !localClipboardPaths(transfer.getData('text/plain')).length) return;
    event.preventDefault();
    void fromTransfer(transfer);
  }, { signal: ctx.signal });
  ctx.lifecycle.add(() => { uploadEpoch++; if (upload) c.keepalive('resources.cancelUpload', [upload]); });
  function showCandidates(result: Discovery) {
    foundList.replaceChildren(...result.models.map(model => {
      const row = c.node('article', '', 'studio-resource-item');
      const name = c.node('div');
      name.append(c.node('strong', model.title), c.node('small', model.file));
      const use = c.button(t('导入到模型库', 'Add to library'), () => {
        candidates.element.close();
        void load('resources.importCandidate', model.id);
      });
      row.append(name, use);
      return row;
    }));
    foundStatus.textContent = result.models.length ? t('找到 ', 'Found ') + result.models.length + t(' 个模型', ' models')
      : t('未找到可导入的 Live2D 模型或形象包。', 'No supported Live2D models or figure packages found.');
    if (result.truncated) foundStatus.textContent += t(' · 已达扫描上限', ' · Scan limit reached');
    problems.hidden = !result.problems.length;
    const summary = c.node('summary', t('查看未能导入的项目', 'See import issues') + ' · ' + result.problems.length);
    problems.replaceChildren(summary, ...result.problems.map(problem => c.node('p', problem.file + ' · ' + problem.reason)));
    feedback.textContent = idleHint;
    candidates.open();
  }
  async function load(method: string, value: string) {
    if (stage && stage !== 'picker') return;
    stage = 'picker';
    sync();
    try {
      if (ctx.signal.aborted) return;
      lastLoad = { method, value };
      showDetails.hidden = true;
      detailsText.textContent = '';
      importDetails.body.replaceChildren(detailsText);
      retry.hidden = recovery.hidden = true;
      stage = 'loading';
      const id = win.crypto.randomUUID();
      operationId = id;
      sync();
      feedback.textContent = t('正在检查和准备模型…', 'Validating and preparing the model…');
      const result = await c.call<{ imported?: string; modelOperation?: ModelOperation }>(method, [value, id]);
      if (ctx.signal.aborted) return;
      await library.refresh();
      if (result.imported) {
        library.reveal(result.imported);
        if (adaptationMode === 'ai' && result.imported.startsWith('live2d-')) showImportResult(result.imported);
      }
      feedback.textContent = t('已加入模型库。', 'Added to the model library.');
    } catch (error) {
      if (ctx.signal.aborted) return;
      const step = operationId ? await c.call<ModelOperation | null>('operation.get', [operationId]).catch(() => null) : null;
      if (ctx.signal.aborted) return;
      const cancelled = step?.phase === 'cancelled';
      feedback.textContent = cancelled ? t('已取消导入。', 'Import cancelled.') : t('模型导入失败。', 'Model import failed.') + ' ' + errorText(error);
      detailsText.textContent = feedback.textContent;
      showDetails.hidden = cancelled;
      retry.hidden = cancelled || !lastLoad;
      recovery.hidden = cancelled || !/live2d|cubism|sdk|runtime|运行组件|许可/i.test(errorText(error));
    } finally {
      operationId = undefined;
      stage = null;
      if (!ctx.signal.aborted) sync();
    }
  }
  async function cancelLoad() {
    if (cancelling) return;
    cancelling = true;
    sync();
    try {
      if (stage === 'upload') {
        uploadEpoch++;
        discoveryCancelled = true;
        if (upload) await c.call('resources.cancelUpload', [upload]);
        feedback.textContent = t('已取消导入。', 'Import cancelled.');
      } else if (stage === 'discovery') {
        const result = await c.call<{ cancelled: boolean }>('resources.cancelImport');
        discoveryCancelled = result.cancelled;
      } else if (operationId) await c.call('operation.cancel', [operationId]);
    } catch (error) { if (!ctx.signal.aborted) feedback.textContent = errorText(error); }
    finally { cancelling = false; if (!ctx.signal.aborted) sync(); }
  }
  function showImportResult(id: string) {
    detailsText.textContent = t('模型已加入模型库，可以交给 Coo 分析原生动作。', 'The model is in your library. You can ask Coo to analyze its native actions.');
    const ask = c.button(t('请 Coo 分析', 'Ask Coo to analyze'), () => {
      importDetails.element.close();
      void analyzeImported(id);
    }, true);
    const actions = c.node('footer', '', 'studio-dialog-actions');
    actions.append(c.button(t('完成', 'Done'), () => importDetails.element.close()), ask);
    importDetails.body.replaceChildren(detailsText, actions);
    showDetails.hidden = false;
  }
  function updateProposals(next: Proposal[]) {
    if (JSON.stringify(next) === JSON.stringify(proposals)) return;
    proposals = next;
    pendingReviews.hidden = !next.some(plan => plan.status === 'pending' || plan.status === 'approved');
    library.setReviewable(new Set(next.filter(plan => plan.status !== 'rejected').map(plan => plan.sourceId)));
    if (reviewDialog.element.open && !proposalBusy) renderProposals();
  }
  async function poll() {
    const id = operationId;
    if (id && !cancelling) {
      const step = await c.call<ModelOperation | null>('operation.get', [id]).catch(() => null);
      if (!ctx.signal.aborted && operationId === id && step?.phase === 'applying') {
        feedback.textContent = t('正在等待桌宠渲染首帧…', 'Waiting for the first frame…');
      }
    }
    if (!stage) await library.refresh();
    const next = await c.call<{plans: Proposal[]}>('resources.adaptationState').catch(() => null);
    if (ctx.signal.aborted) return;
    if (Array.isArray(next?.plans)) {
      updateProposals(next.plans);
      if (requestedAnalysis && next.plans.some(plan => plan.target.id === requestedAnalysis && plan.status !== 'rejected')) {
        requestedAnalysis = undefined;
        notify(t('Coo 的方案已就绪，可从模型卡片审阅。', 'Coo’s proposal is ready. Review it on the model card.'));
      }
    }
  }
  retry.hidden = true;
  sync();
  return {
    element,
    async refresh() {
      await library.refresh();
      const config = await c.call<{options?: Adaptation; plans?: Proposal[]}>('resources.adaptationState').catch(() => null);
      if (config?.options) adaptationMode = config.options.mode;
      if (config?.plans) updateProposals(config.plans);
    },
    poll,
    render(next: RuntimeState) {
      const originChanged = state?.url !== next.url;
      state = next;
      sync();
      if (originChanged) library.render();
    },
  };
}
