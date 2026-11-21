import type { FigureEditorState, FigureSaveResult, FigureSettings } from '../framework/model-contract.ts';
import type { EditorDraft } from '../framework/editor-backend.ts';
import type { createTouchEditor } from './coopanion/features/framework/touch-editor.ts';
import type { studioControls } from './coopanion/features/framework/controls.ts';
import { characterWardrobePicker } from './coopanion/features/framework/character-wardrobe.ts';
import { characterOriginLabel } from '../framework/character-source.ts';

export type OpenedFigure = FigureEditorState & { draft: EditorDraft<FigureSettings> | null };

export function figureEditorView(report: OpenedFigure, ports: {
  button(label: string, run: () => void): HTMLButtonElement;
  english: boolean;
  invoke<T>(method: string, args: unknown[]): Promise<T>;
  touch: ReturnType<typeof createTouchEditor>;
  controls: ReturnType<typeof studioControls>;
  retainDraft(args: unknown[]): void;
  flushDraft(): Promise<void>;
  discardDraft(model: string): Promise<void>;
  sendPreview(kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  failure(error: unknown): void;
  feedback(text: string): void;
  previewReady(): boolean;
  reloadPreview(): void;
  freezeCanvas(locked: boolean): void;
  selectTask(task: string): void;
}) {
  const { id, tasks, origin } = report.character;
  const { button, english, touch, sendPreview, failure, controls } = ports;
  const text = (zh: string, en: string) => english ? en : zh;
  const draft = report.draft?.profile;
  let committed = report.settings;
  const initial = draft ?? committed;
  touch.read(initial.touch, undefined, []);
  let revision = report.revision;
  let dirty = !!draft, busy = false, applyError = false, scheme = initial.scheme ?? '';
  let worn = report.worn, usingAuthorOutfit = draft?.scheme === '', savedOutfitChanged = true;
  const colorDefaults = {hue:0,brightness:1};
  let visual = initial.visual ?? colorDefaults;

  const sections = new Map<string, HTMLElement>([['touch', touch.element]]);
  function section(key: string, label: string) {
    const container = document.createElement('section');
    container.className = 'studio-editor-group';
    const title = document.createElement('h2');
    title.textContent = label;
    container.append(title);
    sections.set(key, container);
    return container;
  }

  const appearance = section('framing', text('模型配色', 'Model colors'));
  const appearanceHeader = document.createElement('header');
  appearanceHeader.className = 'studio-editor-group-heading';
  appearanceHeader.append(appearance.firstElementChild!);
  appearance.prepend(appearanceHeader);
  function colorRange(key: 'hue' | 'brightness', label: string, min: number, max: number, step: string, unit: string) {
    const input = document.createElement('input');
    const range = controls.range(input, min, max, step, value => value + unit);
    const sync = () => { input.value = String(visual[key]); range.sync(); };
    sync();
    input.addEventListener('input', () => {
      visual = { ...visual, [key]: input.valueAsNumber };
      changed();
      previewColors();
    });
    appearance.append(controls.field(label, range.element));
    return sync;
  }
  const syncHue = colorRange('hue', text('色相', 'Hue'), -180, 180, '1', '°');
  const syncBrightness = colorRange('brightness', text('亮度', 'Brightness'), .5, 1.5, '.01', '×');
  function readColors(value: FigureSettings['visual']) {
    visual = value ?? colorDefaults;
    syncHue();
    syncBrightness();
    previewColors();
  }
  function previewColors() {
    if (ports.previewReady()) void sendPreview('visual', { value:visual }).catch(failure);
  }
  appearanceHeader.append(button(text('恢复已保存值', 'Restore saved values'), () => {
    readColors(committed.visual);
    changed();
  }));

  const wardrobe = tasks.includes('wardrobe') ? section('wardrobe', text('装扮', 'Outfit')) : null;
  let trial: string | null = null;
  let confirmedTrial = false;
  let outfitRequest: { value: string; trial: boolean } | undefined;
  let previewingOutfit = false;
  let refreshOutfitPreview = false;
  const outfitSummary = document.createElement('p');
  outfitSummary.className = 'studio-figure-outfit-summary';
  const wornSummary = document.createElement('p');
  wornSummary.className = 'studio-figure-outfit-summary';
  const outfitStatus = document.createElement('p');
  outfitStatus.className = 'studio-figure-outfit-status';
  outfitStatus.setAttribute('role', 'status');
  const picker = wardrobe && characterWardrobePicker(document, { ...report, current: scheme }, !english, value => {
    if (value === scheme) { endTrial(); return; }
    trial = value;
    requestOutfit(value, true);
  });
  const keepOutfit = button(text('加入草稿', 'Keep in draft'), () => {
    if (trial === null || !confirmedTrial) return;
    scheme = trial;
    usingAuthorOutfit = false;
    trial = null;
    outfitStatus.textContent = text('已加入草稿', 'Added to draft');
    syncOutfit();
    changed();
  });
  const resetOutfit = button(text('结束试穿', 'End try-on'), () => endTrial());
  const retryOutfit = button(text('重试预览', 'Retry outfit preview'), () => {
    if (refreshOutfitPreview) ports.reloadPreview();
    else if (outfitRequest) requestOutfit(outfitRequest.value, outfitRequest.trial);
  });
  retryOutfit.hidden = true;
  keepOutfit.classList.add('is-primary');
  if (wardrobe && picker) {
    wardrobe.classList.add('studio-figure-wardrobe');
    const heading = document.createElement('div');
    heading.append(wardrobe.firstElementChild!, wornSummary, outfitSummary);
    const preview = document.createElement('div');
    preview.className = 'studio-figure-outfit-preview';
    const controls = document.createElement('div');
    controls.className = 'studio-figure-outfit-actions';
    controls.append(resetOutfit, retryOutfit, keepOutfit);
    preview.append(outfitStatus, controls);
    wardrobe.append(heading, picker.element, preview);
  }

  function syncOutfit() {
    if (!picker) return;
    const ready = ports.previewReady();
    for (const control of picker.element.querySelectorAll('select')) control.disabled = !ready;
    wornSummary.hidden = worn === undefined;
    wornSummary.textContent = worn === undefined ? '' : text('桌宠穿戴 · ', 'Worn by the pet · ') + picker.label(worn);
    outfitSummary.textContent = text('草稿装扮 · ', 'Draft outfit · ') + picker.label(scheme);
    keepOutfit.disabled = trial === null || !confirmedTrial;
    resetOutfit.disabled = trial === null;
    retryOutfit.disabled = !ready;
  }

  function requestOutfit(value: string, trying = false) {
    if (!picker) return;
    outfitRequest = { value, trial: trying };
    confirmedTrial = false;
    refreshOutfitPreview = false;
    retryOutfit.hidden = true;
    outfitStatus.dataset.state = 'pending';
    outfitStatus.textContent = trying ? text('正在试穿…', 'Trying outfit…') : text('正在恢复草稿外观…', 'Restoring draft outfit…');
    syncOutfit();
    renderFooter();
    void previewOutfit();
  }

  function endTrial() {
    trial = null;
    picker?.setValue(scheme);
    requestOutfit(scheme);
  }

  const source = tasks.includes('source') ? section('source',characterOriginLabel(report.character,english)) : null;
  if (source) {
    const details = document.createElement('p');
    details.className = 'studio-help';
    details.textContent = origin === 'spriter'
      ? text('动作来自导入的 SCML 工程。这里保存梦境里的角色设置。', 'Actions come from the imported SCML project. This editor saves settings for Figure Scape.')
      : origin === 'cabin-world'
        ? text('这里保存角色在梦境中的外观与触碰设置。小屋世界管理自己的住户和存档。', 'This editor saves appearance and touch settings for Figure Scape. Cabin World manages its own residents and saves.')
        : text('角色与动作来自作者的形象包。调整单独保存为梦境里的角色设置。', 'The character and actions come from the author’s figure pack. Edits are saved in the character’s Figure Scape settings.');
    if (report.author) {
      const author = document.createElement('p');
      author.textContent = report.author;
      source.append(author);
    }
    source.append(details);
  }

  const actionButtons = new Map<string, HTMLButtonElement>();
  let actionRequest = 0;
  let currentWords: Set<string> | null = null;
  const actionLabel = (action: FigureEditorState['actions'][number]) =>
    (english ? action.names.en : action.names.zh)?.[0] ?? Object.values(action.names)[0]?.[0]
      ?? (english ? action.about?.en : action.about?.zh) ?? action.id;
  if (tasks.includes('bindings')) {
    const actions = section('bindings', text('动作试播', 'Action preview'));
    const list = document.createElement('div');
    list.className = 'studio-figure-actions';
    for (const action of report.actions) {
      const play = button(actionLabel(action), () => {
        const request = ++actionRequest;
        ports.feedback('');
        void sendPreview('figure-word', { word: action.id }).then(() => {
          if (request === actionRequest) ports.feedback(text('已试播', 'Action previewed'));
        }, error => { if (request === actionRequest) failure(error); });
      });
      play.dataset.figureWord = action.id;
      play.disabled = true;
      actionButtons.set(action.id, play);
      list.append(play);
    }
    actions.append(list);
  }
  function syncActions() {
    const available = (id: string) => !currentWords || currentWords.has(id);
    touch.setPackageActions(report.actions.filter(action => available(action.id))
      .map(action => ({ id: action.id, label: actionLabel(action) })));
    for (const [id, control] of actionButtons) control.disabled = !ports.previewReady() || !available(id);
  }
  async function previewOutfit() {
    const request = outfitRequest;
    if (!request || previewingOutfit || !ports.previewReady()) return;
    previewingOutfit = true;
    try {
      const result = await sendPreview('figure-look', { scheme: request.value });
      if (outfitRequest !== request) return;
      if (result.cancelled) throw Error(text('试穿已取消。', 'Outfit preview was cancelled.'));
      outfitRequest = undefined;
      confirmedTrial = request.trial;
      outfitStatus.dataset.state = 'ready';
      outfitStatus.textContent = request.trial ? text('正在预览 · ', 'Previewing · ') + picker!.label(request.value) : '';
    } catch (error) {
      if (outfitRequest !== request) return;
      outfitStatus.dataset.state = 'error';
      outfitStatus.textContent = text('外观预览失败。', 'Could not preview the outfit. ') + (error instanceof Error ? error.message : String(error));
      refreshOutfitPreview = error instanceof DOMException && error.name === 'TimeoutError';
      retryOutfit.textContent = refreshOutfitPreview ? text('重新加载画布', 'Reload canvas') : text('重试预览', 'Retry outfit preview');
      retryOutfit.hidden = false;
    } finally {
      previewingOutfit = false;
      syncOutfit();
      if (outfitRequest !== request) void previewOutfit();
    }
  }
  syncActions();

  const panel = document.createElement('section');
  panel.className = 'framework-model-editor';
  const workspace = document.createElement('div');
  workspace.className = 'framework-editor-workspace';
  workspace.append(...sections.values());
  const footer = document.createElement('footer');
  footer.className = 'framework-editor-footer framework-editor-actions';
  const hint = document.createElement('span');
  hint.className = 'framework-draft-state';
  hint.setAttribute('role', 'status');
  hint.textContent = draft ? report.draft?.revision !== revision
    ? text('已恢复旧版草稿，请核对后保存。', 'Earlier draft restored. Review it before saving.')
    : text('已恢复草稿', 'Draft restored')
    : text('已载入保存的配置', 'Saved settings loaded');

  function settings(): FigureSettings {
    const touchProfile = touch.value();
    return {
      ...(scheme || usingAuthorOutfit ? { scheme } : {}),
      ...(touchProfile && (touchProfile.areas.length || touchProfile.rules.length || Object.keys(touchProfile.areaNotes ?? {}).length) ? { touch: touchProfile } : {}),
      ...(visual.hue || visual.brightness !== 1 ? { visual } : {}),
    };
  }
  function renderFooter() {
    save.disabled = busy || !dirty || trial !== null;
    discard.disabled = busy || !dirty;
    retry.hidden = !applyError || dirty;
    retry.disabled = busy || trial !== null;
    restore.disabled = busy || !scheme && !worn && !settings().touch && !settings().visual;
    workspace.inert = busy;
    ports.freezeCanvas(busy);
  }
  function finish(result: FigureSaveResult) {
    revision = result.revision;
    committed = result.settings;
    if (result.worn !== undefined) worn = result.worn;
    syncOutfit();
    applyError = !!result.error;
    hint.textContent = result.applied ? text('已保存并应用', 'Saved and applied')
      : result.error ? text('已保存，应用失败', 'Saved. Application failed.')
      : text('已保存，下次加载角色时生效。', 'Saved. Applies when this character next loads.');
    if (result.error) hint.textContent += ' · ' + result.error;
  }
  async function persist(applyOnly: boolean) {
    if (busy || trial !== null || (applyOnly ? dirty || !applyError : !dirty)) return;
    if (!applyOnly && touch.isDrawing()) {
      ports.selectTask('touch');
      hint.textContent = text('请先完成或取消触碰范围绘制。', 'Finish or cancel drawing the touch area first.');
      return;
    }
    busy = true;
    ports.feedback('');
    hint.textContent = applyOnly ? text('正在重新应用…', 'Reapplying…') : text('正在保存配置…', 'Saving settings…');
    renderFooter();
    try {
      await ports.flushDraft();
      const value = settings();
      const outfitChanged = usingAuthorOutfit || scheme !== (committed.scheme ?? '');
      const result = applyOnly
        ? await ports.invoke<FigureSaveResult>('character.applyFigure', [id, revision, savedOutfitChanged])
        : await ports.invoke<FigureSaveResult>('character.saveFigure', [id, {
          ...(outfitChanged ? { scheme: value.scheme || null } : {}), touch: value.touch ?? null, visual: value.visual ?? null,
        }, revision]);
      if (!applyOnly) savedOutfitChanged = outfitChanged;
      usingAuthorOutfit = false;
      dirty = false;
      finish(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      hint.textContent = (applyOnly ? text('已保存，应用失败。', 'Saved. Application failed. ') : text('保存未完成，当前修改已保留。', 'Save did not complete. Your edits are still here. ')) + detail;
    }
    finally { busy = false; renderFooter(); }
  }
  const save = button(report.active ? text('保存并应用', 'Save and apply') : text('保存配置', 'Save settings'), () => void persist(false));
  save.classList.add('is-primary');
  const retry = button(text('重新应用已保存版本', 'Reapply saved version'), () => void persist(true));
  const restore = button(text('恢复作者默认', 'Restore author defaults'), () => {
    usingAuthorOutfit = true;
    scheme = '';
    endTrial();
    touch.read(undefined, undefined, []);
    readColors(undefined);
    changed();
  });
  source?.append(restore);
  const confirmation = document.createElement('dialog');
  confirmation.className = 'framework-dialog';
  const confirmTitle = document.createElement('h2');
  confirmTitle.textContent = text('放弃当前修改？', 'Discard these edits?');
  confirmation.setAttribute('aria-label', confirmTitle.textContent);
  const explanation = document.createElement('p');
  explanation.textContent = text('将回到上一次保存的装扮和触碰设置。', 'Return to the last saved outfit and touch settings.');
  const keep = button(text('继续编辑', 'Keep editing'), () => confirmation.close());
  keep.autofocus = true;
  const confirm = button(text('放弃修改并继续', 'Discard and continue'), () => {
    confirmation.close();
    void discardChanges();
  });
  confirmation.append(confirmTitle, explanation, keep, confirm);
  const discard = button(text('放弃修改', 'Discard edits'), () => confirmation.showModal());
  async function discardChanges() {
    if (busy || !dirty) return;
    busy = true;
    renderFooter();
    try {
      await ports.discardDraft(id);
      scheme = committed.scheme ?? '';
      usingAuthorOutfit = false;
      endTrial();
      touch.cancelDrawing();
      touch.read(committed.touch, undefined, []);
      readColors(committed.visual);
      dirty = false;
      hint.textContent = text('已回到上一次保存的配置。', 'Last saved settings restored.');
    } catch (error) {
      failure(error);
    } finally {
      busy = false;
      renderFooter();
    }
  }
  function changed() {
    dirty = true;
    hint.textContent = text('有未保存的修改', 'Unsaved changes');
    ports.retainDraft([id, settings(), revision]);
    renderFooter();
  }
  syncOutfit();
  renderFooter();
  footer.append(hint, discard, retry, save);
  panel.append(workspace, footer, confirmation);
  return {
    element: panel, changed, isSaving: () => busy,
    select(task: string) {
      actionRequest++;
      if (task !== 'wardrobe' && trial !== null) endTrial();
      for (const [key, pane] of sections) pane.hidden = key !== task;
    },
    previewUnavailable() {
      actionRequest++;
      outfitRequest = undefined;
      trial = null;
      confirmedTrial = false;
      picker?.setValue(scheme);
      outfitStatus.textContent = '';
      retryOutfit.hidden = true;
      syncOutfit();
      renderFooter();
      syncActions();
    },
    previewReady(words: unknown) {
      currentWords = Array.isArray(words) ? new Set(words.filter(word => typeof word === 'string')) : null;
      syncActions();
      syncOutfit();
      if (outfitRequest) void previewOutfit();
      else if (scheme !== (committed.scheme ?? '')) requestOutfit(scheme);
      if (visual !== (committed.visual ?? colorDefaults)) previewColors();
    },
  };
}

