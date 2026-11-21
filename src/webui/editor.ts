import { modelEditor } from './coopanion/features/framework/model-editor.ts';
import type { PageContext } from './coopanion/base/page.ts';
import type { RequestOptions } from './coopanion/base/api.ts';
import { createTouchEditor } from './coopanion/features/framework/touch-editor.ts';
import { studioControls } from './coopanion/features/framework/controls.ts';
import { figureEditorView, type OpenedFigure } from './figure-editor-view.ts';
import type { CharacterEditorSource, CharacterTask } from '../framework/model-contract.ts';
import { characterEditorTask, characterOriginLabel } from '../framework/character-source.ts';
import { isAppearancePreset } from '../framework/appearance.ts';
import './coopanion/features/framework/tokens.css';
import './coopanion/features/framework/studio.css';
import './coopanion/features/framework/workspace-layout.css';
import '../../web/framework/control-toggle.css';
import './editor.css';

const root = document.querySelector<HTMLElement>('#editor')!;
const secret = new URLSearchParams(location.hash.slice(1)).get('key');
if (secret) {
  sessionStorage.setItem('live2d-editor-key', secret);
  history.replaceState(null, '', location.pathname + location.search);
}
const key = secret ?? sessionStorage.getItem('live2d-editor-key');
const query = new URLSearchParams(location.search);
const lifetime = new AbortController();
const english = !document.documentElement.lang.startsWith('zh');
const studioName = english ? 'Figure Scape' : document.documentElement.lang === 'zh-Hant' ? '夢境' : '梦境';
const text = (zh: string, en: string) => english ? en : zh;
const tasks = [
  ['framing', '取景与外观', 'Framing and appearance'],
  ['bindings', '动作与表情', 'Actions and expressions'],
  ['wardrobe', '装扮', 'Wardrobe'],
  ['touch', '触碰', 'Touch'],
  ['behavior', '移动与注视', 'Motion and gaze'],
  ['mouth', '口型与输入', 'Mouth and input'],
  ['source', '来源', 'Source'],
] as const;
const heading = document.createElement('h1');
const feedback = document.createElement('p');
feedback.setAttribute('role', 'status');
feedback.className = 'editor-feedback';
const shell = document.createElement('section');
shell.className = 'studio-editor-dialog editor-shell';
const header = document.createElement('header');
header.className = 'editor-heading';
const title = document.createElement('div');
const contextLabel = document.createElement('span');
contextLabel.textContent = text('角色编辑台', 'Character editor');
title.append(contextLabel, heading);
heading.textContent = text('加载角色', 'Loading character');
const headerNotices = document.createElement('div');
headerNotices.className = 'editor-notices';
headerNotices.tabIndex = 0;
headerNotices.setAttribute('aria-label', text('编辑状态', 'Editor status'));
const loadRetry = button(text('重新加载角色', 'Reload character'), () => schedule(query.get('model'), selectedTask || query.get('task')));
loadRetry.hidden = true;
const draftNotice = document.createElement('div');
draftNotice.className = 'editor-draft-notice';
draftNotice.hidden = true;
const draftFeedback = document.createElement('p');
draftFeedback.setAttribute('role', 'status');
const draftRetry = button(text('重试保留草稿', 'Retry draft backup'), () => void flushDraft().catch(draftFailure));
const draftReload = button(text('读取另一页的草稿', 'Load the other draft'), () => {
  if (!confirm(text('放弃这个标签里的修改，读取已保留的草稿？', 'Discard the edits in this tab and load the retained draft?'))) return;
  queuedDraft = undefined;
  location.reload();
});
const draftReplace = button(text('保留本页草稿', 'Keep this draft'), () => {
  if (!queuedDraft || !confirm(text('用本页草稿替换已保留的草稿？', 'Replace the retained draft with this tab’s edits?'))) return;
  void replaceDraft().catch(draftFailure);
});
draftNotice.append(draftFeedback, draftRetry, draftReload, draftReplace);
headerNotices.append(feedback, loadRetry, draftNotice);
header.append(title, headerNotices);
const layout = document.createElement('div');
layout.className = 'studio-edit-layout editor-layout';
const nav = document.createElement('nav');
nav.className = 'studio-editor-nav';
nav.setAttribute('aria-label', text('角色编辑任务', 'Character editing tasks'));
const canvas = document.createElement('section');
canvas.className = 'editor-canvas';
canvas.setAttribute('aria-label', text('角色实时预览', 'Live character preview'));
const canvasHeader = document.createElement('header');
canvasHeader.className = 'editor-canvas-heading';
const canvasTitle = document.createElement('h2');
canvasTitle.textContent = text('角色预览', 'Character preview');
const canvasState = document.createElement('span');
canvasState.dataset.state = 'loading';
canvasState.textContent = text('准备中', 'Preparing');
canvasHeader.append(canvasTitle, canvasState);
const previewNotice = document.createElement('div');
previewNotice.className = 'editor-preview-notice';
const previewFeedback = document.createElement('p');
previewFeedback.setAttribute('role', 'status');
const previewRetry = button(text('重试预览', 'Retry preview'), () => { if (activeModel) attachPreview(activeModel); });
previewRetry.hidden = true;
previewNotice.append(previewFeedback, previewRetry);
canvas.append(canvasHeader, previewNotice);
const inspector = document.createElement('section');
inspector.className = 'editor-inspector';
layout.append(nav, canvas, inspector);
shell.append(header, layout);
root.append(shell);

function button(label: string, run?: () => void) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'studio-button';
  element.textContent = label;
  if (typeof run === 'function') element.addEventListener('click', run, { signal: lifetime.signal });
  return element;
}
class DraftConflict extends Error {}
async function invoke<T>(method: string, args: unknown[] = [], options?: RequestOptions): Promise<T> {
  const response = await fetch('/api/editor', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ method, args }), signal: options?.signal, keepalive: options?.keepalive,
  });
  if (response.status === 403) throw Error(english ? 'This editor session has expired. Reopen the model from the workbench.' : '编辑会话已失效，请从工作台重新打开模型。');
  const value = await response.json();
  if (response.status === 409 && value.code === 'draft-conflict') {
    throw new DraftConflict(text('另一个标签页改过这个角色的草稿。', 'Another tab changed this character’s draft.'));
  }
  if (!response.ok) throw Error(value.error || 'Editor request failed');
  return value;
}

let frame: HTMLIFrameElement | null = null;
let loading = Promise.resolve();
let queuedDraft: { args: unknown[]; writeId: string; expected?: string | null } | undefined;
let draftVersion: string | null = null;
let savingDraft: Promise<void> | undefined;
let lastDraftRequest: string | undefined;
let clearingDraft = false;
let previewReady = false;
const receipts = new Map<string, (event: Record<string, unknown>) => void>();
const failure = (error: unknown) => { feedback.textContent = error instanceof Error ? error.message : String(error); };
const draftFailure = (error: unknown) => {
  if (clearingDraft) return;
  const conflict = error instanceof DraftConflict;
  draftNotice.hidden = false;
  draftRetry.hidden = conflict;
  draftReload.hidden = !conflict;
  draftReplace.hidden = !conflict || !queuedDraft;
  draftFeedback.textContent = conflict
    ? text('另一个标签页改过这个角色的草稿。本页修改还在。', 'Another tab changed the draft. The edits in this tab are still here.')
    : text('本次修改还在编辑台，草稿备份未写入。', 'Your edits are still here. The draft backup was not written.');
};
async function replaceDraft() {
  const draft = queuedDraft;
  if (!draft) return;
  const { draftVersion: latest } = await invoke<{ draftVersion: string | null }>('edit.draftVersion', [draft.args[0]]);
  if (queuedDraft !== draft || clearingDraft) return;
  draft.expected = latest;
  await flushDraft();
}
async function flushDraft(): Promise<void> {
  if (clearingDraft) return;
  if (!savingDraft && queuedDraft) {
    const draft = queuedDraft;
    queuedDraft = undefined;
    const [model, profile, revision, catalog] = draft.args;
    const args = [model, profile, revision, catalog, draft.expected === undefined ? draftVersion : draft.expected, draft.writeId];
    savingDraft = invoke<{ draftVersion: string }>('edit.updateDraft', args, { keepalive: JSON.stringify(args).length < 16000 }).then(result => {
      draftVersion = result.draftVersion;
    }, error => {
      queuedDraft ??= draft;
      throw error;
    }).finally(() => { savingDraft = undefined; });
  }
  await savingDraft;
  if (queuedDraft && !clearingDraft) await flushDraft();
  if (!queuedDraft) {
    draftNotice.hidden = true;
    draftFeedback.textContent = '';
  }
}
function retainDraft(args: unknown[]) {
  const request = JSON.stringify(args);
  if (request === lastDraftRequest) return;
  lastDraftRequest = request;
  queuedDraft = { args, writeId: crypto.randomUUID() };
  void flushDraft().catch(draftFailure);
}
async function discardDraft(model: string) {
  clearingDraft = true;
  try {
    await savingDraft?.catch(() => {});
    await invoke('edit.clearDraft', [model, draftVersion]);
    draftVersion = null;
    queuedDraft = lastDraftRequest = undefined;
    draftNotice.hidden = true;
    draftFeedback.textContent = '';
  } catch (error) {
    clearingDraft = false;
    if (error instanceof DraftConflict) draftFailure(error);
    throw error;
  } finally {
    clearingDraft = false;
  }
}
addEventListener('beforeunload', event => {
  if (queuedDraft || savingDraft || clearingDraft || editor?.isSaving() || figure?.isSaving()) event.preventDefault();
}, { signal: lifetime.signal });
addEventListener('pagehide', event => {
  void flushDraft().catch(draftFailure);
  if (!event.persisted) lifetime.abort();
}, { signal: lifetime.signal });
function sendPreview(kind: string, input: Record<string, unknown> = {}) {
  if (!previewReady || !frame?.contentWindow) return Promise.reject(Error(english ? 'Preparing model preview' : '模型预览正在准备'));
  const id = crypto.randomUUID();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      receipts.delete(id);
      reject(new DOMException(text('画布未及时返回结果。', 'The canvas did not respond in time.'), 'TimeoutError'));
    }, 3200);
    receipts.set(id, result => {
      clearTimeout(timer);
      receipts.delete(id);
      if (result.error) reject(Error(String(result.error)));
      else resolve(result);
    });
    frame?.contentWindow?.postMessage({ ...input, type: 'live2d-editor:preview', id, kind }, location.origin);
  });
}
let editor: ReturnType<typeof modelEditor> | null = null;
let figure: ReturnType<typeof figureEditorView> | null = null;
const touch = createTouchEditor({
  root,
  signal: lifetime.signal,
  changed: () => { if (figure) figure.changed(); else editor?.markDirty(); },
  send: sendPreview,
});
type OpenedCharacter = ({ character: CharacterEditorSource } | OpenedFigure) & { policy: Parameters<typeof touch.setPolicy>[0]; draftVersion: string | null };
let selectedTask = '';
const navButtons = new Map<string, HTMLButtonElement>();
function showTasks(enabled: CharacterTask[], packaged: boolean) {
  navButtons.clear();
  nav.replaceChildren();
  for (const id of enabled) {
    const label = tasks.find(([key]) => key === id);
    if (!label) continue;
    const name = packaged && id === 'bindings' ? text('动作试播', 'Actions')
      : packaged && id === 'framing' ? text('外观', 'Appearance') : text(label[1], label[2]);
    const entry = button(name, () => select(id));
    navButtons.set(id, entry);
    nav.append(entry);
  }
}
function select(id: string) {
  const task = navButtons.has(id) ? id : navButtons.keys().next().value ?? '';
  if (!task) return;
  if (task !== selectedTask) {
    feedback.textContent = '';
  }
  selectedTask = task;
  for (const [key, entry] of navButtons) entry.setAttribute('aria-current', key === task ? 'page' : 'false');
  editor?.selectSection(task);
  figure?.select(task);
  touch.show(task === 'touch', previewReady);
  navButtons.get(task)?.scrollIntoView?.({block:'nearest',inline:'nearest'});
  if (activeModel) {
    const url = new URL(location.href);
    if (url.searchParams.get('task') !== task) {
      url.searchParams.set('task', task);
      history.replaceState(null, '', url);
    }
  }
}
let activeModel: string | null = null;
let controller: AbortController | null = null;

async function open(model: string | null, task: string | null) {
  if (!key || !model) throw Error(english ? 'Select a model from the workbench' : '请从工作台选择模型');
  if (activeModel === model && (editor?.hasModel() || figure)) { select(task ?? selectedTask); return; }
  await flushDraft();
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  previewReady = false;
  editor = figure = null;
  frame?.remove();
  frame = null;
  inspector.replaceChildren();
  nav.replaceChildren();
  navButtons.clear();
  selectedTask = '';
  previewNotice.hidden = false;
  previewRetry.hidden = true;
  previewFeedback.textContent = text('正在读取角色配置…', 'Loading character settings…');
  loadRetry.hidden = true;
  const context = {
    root,
    signal,
    ui: { button },
    lifecycle: {
      add(cleanup: () => void) { signal.addEventListener('abort', cleanup, { once: true }); },
    },
  } as unknown as PageContext;
  touch.clear();
  touch.setPackageActions();
  feedback.textContent = '';
  const report = await invoke<OpenedCharacter>('character.open', [model], { signal });
  draftVersion = report.draftVersion ?? null;
  lastDraftRequest = undefined;
  const packaged = report.character.kind === 'figure-pack';
  showTasks(report.character.tasks, packaged);
  contextLabel.textContent = characterOriginLabel(report.character,english);
  touch.setPolicy(report.policy);
  if (packaged) {
    if (!('settings' in report)) throw Error('The figure editor did not return its settings');
    const opened = report;
    figure = figureEditorView(opened, {
      button, english, touch, retainDraft, flushDraft, discardDraft, sendPreview, failure, controls: studioControls(context),
      async invoke<T>(method: string, args: unknown[]) {
        if (method !== 'character.saveFigure') return invoke<T>(method, args);
        return commitDraft<T>(method, args);
      },
      feedback: text => { feedback.textContent = text; },
      previewReady: () => previewReady,
      reloadPreview: () => attachPreview(opened.character.id),
      freezeCanvas: locked => { canvas.inert = locked; },
      selectTask: select,
    });
    inspector.append(figure.element);
    activeModel = opened.character.id;
    heading.textContent = opened.name;
    document.title = opened.name + ' · ' + studioName;
    attachPreview(activeModel);
    select(characterEditorTask(opened.character,task));
    return;
  }
  let initial: unknown = report;
  const current = modelEditor(context, {
    externalNavigation: true,
    invoke: async <T>(method: string, args: unknown[] = [], options?: RequestOptions): Promise<T> => {
      if (method === 'modelEditor' && initial) {
        const result = initial;
        initial = undefined;
        return result as T;
      }
      if (method === 'edit.clearDraft' && typeof args[0] === 'string') {
        await discardDraft(args[0]);
        touch.cancelDrawing();
        return undefined as T;
      }
      if (method === 'saveModel' || method === 'saveLibraryModel') return commitDraft<T>(method, args, options);
      if (method === 'modelEditor') {
        const report = await invoke<T & { draftVersion: string | null }>(method, args, options);
        draftVersion = report.draftVersion ?? null;
        lastDraftRequest = undefined;
        return report;
      }
      return invoke<T>(method, args, options);
    },
    onDraft: retainDraft,
    onRead(profile, catalog) { touch.read(profile.touch, catalog, profile.bindings); },
    touch,
    preview: (kind, input) => kind === 'restore' && !previewReady ? undefined : sendPreview(kind, input),
    onInvalid: select,
  });
  editor = current;
  inspector.append(current.element);
  if (!await current.ensureLoaded(model)) throw Error(current.loadFailure() ?? 'Model unavailable');
  activeModel = model;
  heading.textContent = current.modelLabel() || (english ? 'Live2D model editor' : 'Live2D 模型编辑台');
  document.title = heading.textContent + ' · ' + studioName;
  attachPreview(model);
  select(characterEditorTask(report.character,task));
}

async function commitDraft<T>(method: string, args: unknown[], options?: RequestOptions): Promise<T> {
  try {
    await flushDraft();
    const result = await invoke<T & { saved?: boolean }>(method, [...args, draftVersion], options);
    if (result.saved) {
      draftVersion = null;
      lastDraftRequest = undefined;
    }
    return result;
  } catch (error) {
    if (error instanceof DraftConflict) draftFailure(error);
    throw error;
  }
}

function attachPreview(model: string) {
  dropPreview();
  canvasState.dataset.state = 'loading';
  canvasState.textContent = text('载入中', 'Loading');
  previewNotice.hidden = true;
  previewRetry.hidden = true;
  frame?.remove();
  const view = document.createElement('iframe');
  view.className = 'studio-preview-frame';
  view.title = english ? 'Model preview' : '模型实时预览';
  view.src = '/model-preview?' + new URLSearchParams({ model, edit: '1' });
  frame = view;
  canvas.append(view);
}
function dropPreview() {
  previewReady = false;
  editor?.previewUnavailable();
  figure?.previewUnavailable();
  touch.show(selectedTask === 'touch', false);
  for (const complete of receipts.values()) complete({ cancelled: true });
}

addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== frame?.contentWindow || !event.data) return;
  if (event.data.type === 'live2d-editor:appearance') {
    if (isAppearancePreset(event.data.appearance)) document.documentElement.dataset.appearance = event.data.appearance;
  } else if (event.data.type === 'live2d-editor:loading') {
    dropPreview();
    canvasState.dataset.state = 'loading';
    canvasState.textContent = text('载入中', 'Loading');
  } else if (event.data.type === 'live2d-editor:ready') {
    previewReady = true;
    canvasState.dataset.state = 'ready';
    canvasState.textContent = text('实时', 'Live');
    previewNotice.hidden = true;
    figure?.previewReady(event.data.words);
    editor?.setPreviewBehavior(event.data.behavior);
    if (editor && activeModel && Array.isArray(event.data.behavior?.mouth?.parameters))
      void invoke('edit.previewParameters',[activeModel,event.data.behavior.mouth.parameters]).catch(failure);
    if (selectedTask === 'touch') touch.show(true);
  } else if (event.data.type === 'live2d-editor:preview-error') {
    dropPreview();
    canvasState.dataset.state = 'error';
    canvasState.textContent = text('预览失败', 'Preview failed');
    previewFeedback.textContent = String(event.data.message);
    previewNotice.hidden = previewRetry.hidden = false;
  } else if (event.data.type === 'live2d-editor:receipt') receipts.get(event.data.id)?.(event.data);
  else if (event.data.type === 'live2d-editor:action-state') editor?.actionState(event.data.id,event.data.status);
  else if (event.data.type === 'live2d-editor:touch-point') touch.pointer(event.data.point);
  else if (event.data.type === 'live2d-preview:close' && selectedTask === 'touch') touch.cancelDrawing();
}, { signal: lifetime.signal });
function schedule(model: string | null, task: string | null) {
  loading = loading.then(() => open(model, task)).catch(error => {
    failure(error);
    previewFeedback.textContent = text('角色加载失败', 'Could not load the character');
    canvasState.dataset.state = 'error';
    canvasState.textContent = text('加载失败', 'Load failed');
    loadRetry.hidden = !key || !model;
  });
}
schedule(query.get('model'), query.get('task'));

