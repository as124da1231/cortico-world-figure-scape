import type { FigureEditorState, FigureSaveResult, FigureSettings } from '../framework/model-contract.ts';
import type { EditorDraft } from '../framework/editor-backend.ts';
import type { createTouchEditor } from './coopanion/features/framework/touch-editor.ts';
import { characterWardrobePicker } from './coopanion/features/framework/character-wardrobe.ts';

export type OpenedFigure = FigureEditorState & { draft: EditorDraft<FigureSettings> | null };

export function figureEditorView(report: OpenedFigure, ports: {
  button(label: string, run: () => void): HTMLButtonElement;
  english: boolean;
  invoke<T>(method: string, args: unknown[]): Promise<T>;
  touch: ReturnType<typeof createTouchEditor>;
  retainDraft(args: unknown[]): void;
  flushDraft(): Promise<void>;
  discardDraft(model: string): Promise<void>;
  sendPreview(kind: string, input: Record<string, unknown>): Promise<unknown>;
  failure(error: unknown): void;
  feedback(text: string): void;
  previewReady(): boolean;
  freezeCanvas(locked: boolean): void;
  selectTask(task: string): void;
}) {
  const { id, tasks } = report.character;
  const { button, english, touch, sendPreview, failure } = ports;
  const text = (zh: string, en: string) => english ? en : zh;
  const draft = report.draft?.profile;
  let committed = report.settings;
  const initial = draft ?? committed;
  touch.read(initial.touch, undefined, []);
  let revision = report.revision;
  let dirty = !!draft, busy = false, applyError = false, scheme = initial.scheme ?? '';

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

  const wardrobe = tasks.includes('wardrobe') ? section('wardrobe', text('装扮', 'Outfit')) : null;
  const picker = wardrobe && characterWardrobePicker(document, { ...report, current: scheme }, !english, value => {
    scheme = value;
    changed();
    previewOutfit();
  });
  if (picker) wardrobe!.append(picker.element);

  const source = section('source', text('形象包', 'Figure package'));
  const details = document.createElement('p');
  details.className = 'studio-help';
  details.textContent = report.author ?? report.name;
  source.append(details);

  const actionButtons = new Map<string, HTMLButtonElement>();
  let actionRequest = 0;
  let currentWords: Set<string> | null = null;
  const actionLabel = (action: FigureEditorState['actions'][number]) =>
    (english ? action.names.en : action.names.zh)?.[0] ?? Object.values(action.names)[0]?.[0] ?? action.id;
  if (tasks.includes('bindings')) {
    const actions = section('bindings', text('形象包动作', 'Package actions'));
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
  function previewOutfit() {
    if (picker && ports.previewReady()) void sendPreview('figure-look', { scheme }).catch(failure);
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
      ...(scheme ? { scheme } : {}),
      ...(touchProfile && (touchProfile.areas.length || touchProfile.rules.length) ? { touch: touchProfile } : {}),
    };
  }
  function renderFooter() {
    save.disabled = busy || !dirty;
    discard.disabled = busy || !dirty;
    retry.hidden = !applyError || dirty;
    retry.disabled = busy;
    restore.disabled = busy || !scheme && !settings().touch;
    workspace.inert = busy;
    ports.freezeCanvas(busy);
  }
  function finish(result: FigureSaveResult) {
    revision = result.revision;
    committed = result.settings;
    applyError = !!result.error;
    hint.textContent = result.applied ? text('已保存并应用', 'Saved and applied')
      : result.error ? text('已保存，应用失败', 'Saved. Application failed.')
      : text('已保存，下次加载角色时生效。', 'Saved. Applies when this character next loads.');
    if (result.error) hint.textContent += ' · ' + result.error;
  }
  async function persist(applyOnly: boolean) {
    if (busy || (applyOnly ? dirty || !applyError : !dirty)) return;
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
      const result = applyOnly
        ? await ports.invoke<FigureSaveResult>('character.applyFigure', [id, revision])
        : await ports.invoke<FigureSaveResult>('character.saveFigure', [id, { scheme: value.scheme ?? null, touch: value.touch ?? null }, revision]);
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
    scheme = '';
    picker?.setValue(scheme);
    touch.read(undefined, undefined, []);
    changed();
    previewOutfit();
  });
  source.append(restore);
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
      picker?.setValue(scheme);
      touch.cancelDrawing();
      touch.read(committed.touch, undefined, []);
      dirty = false;
      hint.textContent = text('已回到上一次保存的配置。', 'Last saved settings restored.');
      previewOutfit();
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
  renderFooter();
  footer.append(hint, discard, retry, save);
  panel.append(workspace, footer, confirmation);
  return {
    element: panel, changed, isSaving: () => busy,
    select(task: string) {
      actionRequest++;
      for (const [key, pane] of sections) pane.hidden = key !== task;
    },
    previewUnavailable() {
      actionRequest++;
      syncActions();
    },
    previewReady(words: unknown) {
      currentWords = Array.isArray(words) ? new Set(words.filter(word => typeof word === 'string')) : null;
      syncActions();
      if (scheme !== (committed.scheme ?? '')) previewOutfit();
    },
  };
}

