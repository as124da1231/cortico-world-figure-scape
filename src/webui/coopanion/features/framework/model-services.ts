import type { PageContext } from '../../base/page.ts';
import { invokePanelBinary } from '../../base/api.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';
import type { NotificationKind } from './notifications.ts';
import type { ModelUse } from '../../../../framework/model-services.ts';
import { WORKSPACE_PROVIDER } from '../../../../framework/workspace.ts';

const names: Record<ModelUse, [string, string]> = {
  planner: ['动作编排', 'Choreography'], tts: ['语音合成', 'Speech synthesis'], asr: ['在线转写', 'Online transcription'],
};
const uses = Object.keys(names) as ModelUse[];
const localSovits = 'tts:sovitsLocal';
type Protocol = { id: string; name: string; endpoint?: string; uses: ModelUse[]; modelDefault?: boolean; hint?: string; hintEn?: string; acceptsKey?: boolean; fields: {key: string; label: string; value: string | number}[] };
type Provider = { id: string; name: string; protocol: string; endpoint: string; hasKey: boolean; fields: Record<string, string | number> };
type Model = { id: string; providerId: string; model: string; uses: ModelUse[]; tests: Partial<Record<ModelUse, Test>> };
type Test = { ok: boolean; elapsedMs: number; message?: string };
export type ServiceState = { protocols: Protocol[]; providers: Provider[]; models: Model[]; selected: Partial<Record<ModelUse, string | null>> };
const modelName = (item: Model) => item.model || t('服务默认', 'Service default');

export function serviceLabel(state: ServiceState, use: ModelUse) {
  const model = state.models.find(item => item.id === state.selected[use]);
  const provider = state.providers.find(item => item.id === model?.providerId);
  return model && provider ? provider.name + ' / ' + modelName(model) : t('未选择模型', 'No model selected');
}

export function modelServicesPanel(ctx: PageContext, notify: (text: string, kind?: NotificationKind) => void) {
  const c = studioControls(ctx), { signal } = ctx;
  const element = c.node('div', '', 'studio-services');
  const usage = c.section(t('当前使用的模型', 'Assigned models'));
  usage.classList.add('studio-use-section');
  const useGrid = c.node('div', '', 'studio-use-grid');
  const useHeader = c.node('header', '', 'studio-use-header');
  useHeader.append(usage.firstChild!);
  usage.append(useHeader, useGrid);
  const settings = c.section(t('提供商与模型', 'Providers and models'));
  settings.classList.add('studio-provider-panel');
  const settingsHeader = c.node('header', '', 'studio-service-header');
  const grid = c.node('div', '', 'studio-service-grid');
  const left = c.node('div', '', 'studio-provider-list');
  const selectProvider = c.node('select', '', 'studio-provider-select');
  selectProvider.setAttribute('aria-label', t('提供商', 'Provider'));
  const right = c.node('div');
  const actions = c.node('div', '', 'studio-inline studio-services-actions');
  const providerActions = c.node('div', '', 'studio-inline studio-services-actions');
  const providerTitle = c.node('h3', '', 'studio-provider-title');
  const filter = c.node('input'); filter.type = 'search'; filter.placeholder = t('搜索已添加的模型', 'Search added models');
  filter.setAttribute('aria-label', filter.placeholder);
  const modelRows = c.node('div', '', 'studio-model-rows');
  const dialog = c.dialog(t('编辑服务', 'Edit service'), 'studio-service-dialog');
  const dialogStatus = c.status();
  const form = c.node('form', '', 'studio-service-fields');
  form.id = dialog.heading.id + '-form';
  const formActions = c.node('footer', '', 'studio-service-form-actions');
  const submit = c.node('button', t('保存', 'Save'), 'is-primary'); submit.type = 'submit';
  submit.setAttribute('form', form.id);
  formActions.append(dialogStatus, submit);
  dialog.body.append(form);
  dialog.element.append(formActions);
  element.append(usage, settings);
  grid.append(left, right);
  settingsHeader.append(settings.firstChild!, providerActions);
  const emptyProvider = c.node('p', t('添加提供商后可获取模型目录，也可手动添加模型。', 'Add a provider to fetch its catalog or enter a model manually.'), 'studio-help');
  emptyProvider.hidden = true;
  const modelHeader = c.node('div', '', 'studio-service-header');
  modelHeader.append(providerTitle, actions);
  settings.append(settingsHeader, selectProvider, emptyProvider, grid);
  right.append(modelHeader, filter, modelRows);
  let state: ServiceState | undefined, selected = '', pending = false;
  let saveForm: ((input: FormData) => Promise<void>) | undefined;
  let disposePreview: (() => void) | undefined;
  const makeOption = (value: string, label: string) => { const option = c.node('option', label); option.value = value; return option; };
  const currentProvider = () => state?.providers.find(provider => provider.id === selected);
  const modelFor = (id?: string | null) => state?.models.find(model => model.id === id);
  const selectedUses = (id: string) => uses.filter(use => state?.selected[use] === id);
  const useName = (use: ModelUse) => t(...names[use]);

  function providerLabel(id: string) { return state?.providers.find(item => item.id === id)?.name ?? ''; }
  function select(id: string) {
    if (id === selected) return;
    selected = id;
    filter.value = '';
    render();
  }
  async function mutation(method: string, args: unknown[], inDialog = false) {
    if (pending) return false;
    pending = true; submit.disabled = true; settings.setAttribute('aria-busy', 'true');
    if (inDialog) dialogStatus.textContent = t('正在处理…', 'Working…');
    else notify(t('正在保存…', 'Saving…'), 'pending');
    try {
      const next = await c.call<ServiceState>(method, args);
      if (signal.aborted) return false;
      state = next;
      notify(t('已保存', 'Saved'), 'success');
      return true;
    } catch (error) {
      if (!signal.aborted) {
        if (inDialog) dialogStatus.textContent = errorText(error);
        else notify(errorText(error));
      }
      return false;
    } finally {
      pending = false; submit.disabled = false; settings.removeAttribute('aria-busy');
      if (!signal.aborted) render();
    }
  }
  function resetForm(title: string, body: Node[], save: (input: FormData) => Promise<void>) {
    disposePreview?.();
    disposePreview = undefined;
    dialog.heading.textContent = title;
    dialogStatus.textContent = '';
    submit.textContent = t('保存', 'Save');
    submit.hidden = false;
    form.replaceChildren(...body);
    dialog.body.scrollTop = 0;
    saveForm = save;
    if (dialog.element.open || dialog.open()) focusForm();
  }
  function focusForm() {
    [...form.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),button:not(:disabled)')]
      .find(control => control.getClientRects().length)?.focus({preventScroll:true});
  }
  form.addEventListener('submit', event => { event.preventDefault(); if (!pending) void saveForm?.(new FormData(form)); }, { signal });
  dialog.element.addEventListener('close', () => {
    disposePreview?.();
    disposePreview = undefined;
    form.reset();
    form.replaceChildren();
    saveForm = undefined;
  }, { signal });
  signal.addEventListener('abort', () => disposePreview?.(), { once: true });
  function editProvider(previous?: Provider) {
    if (!state) return;
    const protocol = c.node('select'); protocol.name = 'protocol';
    protocol.append(...state.protocols.map(item => makeOption(item.id, item.name)));
    protocol.value = previous?.protocol ?? state.protocols[0]?.id ?? '';
    protocol.disabled = !!previous;
    const name = c.node('input'); name.name = 'name'; name.required = true; name.maxLength = 96; name.value = previous?.name ?? '';
    const address = c.node('input'); address.type = 'url'; address.name = 'endpoint'; address.maxLength = 2048;
    const key = c.node('input'); key.type = 'password'; key.autocomplete = 'new-password'; key.name = 'key';
    key.placeholder = previous?.hasKey ? t('已配置，留空保留', 'Configured. Leave blank to keep.') : '';
    const addressField = c.field(t('接口地址', 'Endpoint'), address);
    const keyField = c.field(t('API 密钥', 'API key'), key);
    const hint = c.node('p', '', 'studio-help');
    let suggestedName = '';
    const extras = c.node('div', '', 'studio-service-fields');
    function refreshFields() {
      const spec = state?.protocols.find(item => item.id === protocol.value);
      if (!spec) return;
      addressField.hidden = !spec.endpoint && spec.id !== 'openai-compatible';
      address.required = !addressField.hidden;
      address.value = previous?.endpoint ?? spec.endpoint ?? '';
      if (!previous && (!name.value || name.value === suggestedName)) name.value = spec.name;
      suggestedName = spec.name;
      keyField.hidden = key.disabled = spec.acceptsKey === false;
      hint.textContent = t(spec.hint ?? '', spec.hintEn ?? spec.hint ?? '');
      hint.hidden = !hint.textContent;
      extras.replaceChildren(...spec.fields.map(field => {
        const input = c.node('input'); input.name = 'field:' + field.key;
        input.value = String(previous?.fields[field.key] ?? field.value);
        return c.field(field.label, input);
      }));
    }
    protocol.addEventListener('change', refreshFields, { signal });
    refreshFields();
    resetForm(previous ? t('编辑提供商', 'Edit provider') : t('添加提供商', 'Add provider'), [
      c.field(t('接口类型', 'Protocol'), protocol), c.field(t('名称', 'Name'), name), addressField,
      extras, keyField, hint,
    ], async input => {
      const ids = new Set(state?.providers.map(provider => provider.id));
      if (!await mutation('services.saveProvider', [{
        id: previous?.id, protocol: protocol.value, name: input.get('name'), endpoint: input.get('endpoint'),
        fields: Object.fromEntries([...input].filter(([field]) => field.startsWith('field:')).map(([field, value]) => [field.slice(6), value])),
        key: input.get('key'),
      }], true)) return;
      key.value = '';
      select(previous?.id ?? state?.providers.find(provider => !ids.has(provider.id))?.id ?? selected);
      dialog.element.close();
    });
  }
  function editModel(provider: Provider, previous?: Model, discovered = '') {
    const spec = state?.protocols.find(item => item.id === provider.protocol);
    if (!spec) return;
    const model = c.node('input'); model.name = 'model'; model.maxLength = 240; model.required = !spec.modelDefault;
    model.value = previous?.model ?? discovered;
    const idField = c.field(t('模型 ID', 'Model ID'), model); idField.hidden = !!spec.modelDefault;
    const capabilities = c.node('fieldset');
    capabilities.append(c.node('legend', t('支持的用途', 'Supported uses')));
    for (const use of spec.uses) {
      const box = c.node('input'); box.name = 'use'; box.value = use; box.type = 'checkbox';
      box.checked = previous?.uses.includes(use) ?? (spec.uses.length === 1 || use === 'planner');
      capabilities.append(c.field(useName(use), box));
    }
    resetForm(previous ? t('编辑模型', 'Edit model') : t('添加模型', 'Add model'), [
      ...(spec.modelDefault ? [c.node('p', t('使用这个服务当前加载的模型。', 'Use this service’s currently loaded model.'))] : [idField]), capabilities,
    ], async input => {
      if (await mutation('services.saveModel', [{ id: previous?.id, providerId: provider.id, model: model.value, uses: input.getAll('use') }], true)) dialog.element.close();
    });
  }
  function remove(title: string, description: string, method: string, id: string) {
    resetForm(title, [c.node('p', description)], async () => {
      if (await mutation(method, [id], true)) dialog.element.close();
    });
    submit.textContent = t('移除', 'Remove');
  }
  async function findModels(provider: Provider) {
    const search = c.node('input'); search.type = 'search'; search.placeholder = t('搜索服务模型', 'Search service models');
    search.setAttribute('aria-label', search.placeholder);
    const result = c.node('div', '', 'studio-model-rows');
    const manual = c.button(t('手动添加', 'Add manually'), () => editModel(provider));
    resetForm(t('从提供商获取模型', 'Get models from provider'), [search, result, manual], async () => {});
    submit.hidden = true;
    dialogStatus.textContent = t('正在获取模型…', 'Fetching models…');
    try {
      const items = await c.call<string[]>('services.discover', [provider.id]);
      if (signal.aborted || !result.isConnected) return;
      dialogStatus.textContent = '';
      const count = 30;
      let shown = count;
      const draw = () => {
        const found = items.filter(item => item.toLowerCase().includes(search.value.trim().toLowerCase()));
        result.replaceChildren(...found.slice(0, shown).map(id => {
          const button = c.button(id, () => editModel(provider, undefined, id));
          button.disabled = state?.models.some(m => m.providerId === provider.id && m.model === id) ?? false;
          return button;
        }));
        if (!found.length) result.append(c.node('p', t('没有匹配的模型，可手动添加。', 'No matching models. You can add one manually.')));
        if (found.length > shown) result.append(c.button(t('更多模型', 'More models'), () => { shown += count; draw(); }));
      };
      search.addEventListener('input', () => { shown = count; draw(); }, { signal });
      draw();
    } catch (error) { if (result.isConnected) dialogStatus.textContent = errorText(error); }
  }
  function openTest(model: Model, retryUse?: ModelUse) {
    const purpose = c.node('select'); purpose.name = 'use';
    purpose.append(...model.uses.map(use => makeOption(use, useName(use))));
    if (retryUse) purpose.value = retryUse;
    resetForm(t('测试模型', 'Test model'), [c.node('p', providerLabel(model.providerId) + ' / ' + modelName(model)),
      c.field(t('测试用途', 'Test capability'), purpose)], async () => {
      pending = true; submit.disabled = true;
      const use = purpose.value as ModelUse;
      dialogStatus.textContent = t('正在测试…', 'Testing…');
      try {
        const result = await c.call<Test>('services.test', [model.id, use]);
        if (!signal.aborted && purpose.isConnected) {
          model.tests[use] = result;
          dialogStatus.textContent = result.ok ? t('测试通过', 'Test passed') + ' · ' + result.elapsedMs + ' ms' : result.message ?? t('测试失败', 'Test failed');
          drawModels();
          drawAssignments();
        }
      } catch (error) { if (purpose.isConnected) dialogStatus.textContent = errorText(error); }
      finally { pending = false; submit.disabled = false; }
    });
    if (retryUse) dialogStatus.textContent = model.tests[retryUse]?.message || t('测试失败', 'Test failed');
    submit.textContent = retryUse ? t('重试测试', 'Retry test') : t('开始测试', 'Start test');
  }
  function openLocalPreview(model: Model) {
    const text = c.node('input');
    text.name = 'text';
    text.maxLength = 300;
    text.required = true;
    text.value = t('你好，我在这里。', 'Hello, I’m here.');
    const audio = c.node('audio');
    audio.className = 'studio-service-preview';
    audio.controls = true;
    audio.hidden = true;
    const controller = new AbortController();
    const objectUrl = c.doc.defaultView!.URL;
    let url: string | undefined;
    let generating = false;
    function releaseAudio() {
      audio.pause();
      audio.removeAttribute('src');
      if (url) objectUrl.revokeObjectURL(url);
      url = undefined;
      audio.hidden = true;
    }
    const selectVoice = c.button(t('设为当前语音合成模型', 'Use for speech synthesis'), () => {
      void mutation('services.select', ['tts', model.id], true).then(saved => {
        if (saved && audio.isConnected) dialog.element.close();
      });
    });
    selectVoice.hidden = state?.selected.tts === model.id;
    selectVoice.disabled = true;
    resetForm(t('试听本机语音', 'Preview local voice'), [
      c.field(t('试听文本','Preview text'), text), audio, selectVoice,
    ], async input => {
      if (generating || controller.signal.aborted) return;
      generating = true;
      submit.disabled = true;
      selectVoice.disabled = true;
      releaseAudio();
      dialogStatus.textContent = t('正在合成试听…', 'Synthesizing preview…');
      try {
        const sound = await invokePanelBinary(WORKSPACE_PROVIDER, 'framework', 'services.previewLocalVoice',
          [model.id, input.get('text')], { signal: controller.signal });
        if (controller.signal.aborted) return;
        url = objectUrl.createObjectURL(sound);
        audio.src = url;
        audio.hidden = false;
        selectVoice.disabled = false;
        dialogStatus.textContent = '';
        void audio.play().catch(() => {
          if (!controller.signal.aborted) dialogStatus.textContent = t('已生成试听，点播放键收听。', 'Preview is ready. Press Play to listen.');
        });
      } catch (error) {
        if (!controller.signal.aborted) dialogStatus.textContent = errorText(error);
      } finally {
        generating = false;
        if (!controller.signal.aborted) submit.disabled = false;
      }
    });
    submit.textContent = t('生成试听', 'Generate preview');
    disposePreview = () => {
      controller.abort();
      releaseAudio();
      submit.disabled = false;
    };
  }
  function drawModels() {
    const query = filter.value.trim().toLocaleLowerCase();
    const found = (state?.models ?? []).filter(item => item.providerId === selected && modelName(item).toLocaleLowerCase().includes(query));
    modelRows.replaceChildren(...found.map(model => {
      const row = c.node('div', '', 'studio-model-row'), copy = c.node('div'), controls = c.node('div', '', 'studio-inline');
      const active = selectedUses(model.id);
      const failedUse = model.uses.find(use => model.tests[use]?.ok === false);
      const tests = model.uses.flatMap(use => {
        const result = model.tests[use];
        return !result ? [] : result.ok ? [useName(use) + ' ✓']
          : [useName(use) + ' · ' + (result.message || t('测试失败', 'Test failed'))];
      });
      const useLabels = model.uses.map(use => useName(use) + (active.includes(use) ? t('（使用中）', ' (in use)') : ''));
      const details = c.node('small', (failedUse ? [...tests, ...useLabels] : [...useLabels, ...tests]).join(' · '), 'studio-model-test-details');
      if (failedUse) {
        details.dataset.failed = 'true';
        details.tabIndex = 0;
      }
      copy.append(c.node('strong', modelName(model)), details);
      if (currentProvider()?.protocol === localSovits) controls.append(c.button(t('试听','Preview'), () => openLocalPreview(model)));
      controls.append(c.button(failedUse ? t('重试测试', 'Retry test') : t('测试', 'Test'), () => openTest(model, failedUse)), c.button(t('编辑', 'Edit'), () => editModel(currentProvider()!, model)),
        c.button(t('移除', 'Remove'), () => remove(t('移除模型', 'Remove model'), active.length
          ? t('请先在上方替换或解除这些用途', 'Replace or clear these assignments first') + ' · ' + active.map(useName).join(' / ')
          : modelName(model), 'services.removeModel', model.id)));
      row.append(copy, controls); return row;
    }));
    if (!found.length) modelRows.append(c.node('p', query ? t('没有匹配的模型。', 'No matching models.') : t('还没有添加模型。', 'No models added.'), 'studio-help'));
  }
  function drawAssignments(unavailable = t('正在读取…', 'Reading…')) {
    const current = state;
    const focusedUse = (c.doc.activeElement as HTMLElement | null)?.dataset.serviceUse;
    useGrid.replaceChildren(...uses.map(use => {
      const item = c.node('div', '', 'studio-use-card');
      const label = c.node('h3', useName(use), 'studio-use-label');
      const identity = c.node('div', '', 'studio-use-identity');
      identity.append(label);
      item.append(identity);
      const models = current?.models.filter(model => model.uses.includes(use)) ?? [];
      if (!models.length) {
        const text = current ? t('无可用模型', 'No compatible models') : unavailable;
        item.append(c.node('p', text, 'studio-use-empty'));
        return item;
      }
      const choice = c.node('select');
      choice.setAttribute('aria-label',useName(use));
      choice.classList.add('studio-use-picker');
      choice.dataset.serviceUse = use;
      choice.disabled = pending;
      choice.append(makeOption('', t('选择模型', 'Choose a model')), ...models.map(model =>
        makeOption(model.id, modelName(model) + ' · ' + providerLabel(model.providerId))));
      choice.value = modelFor(current?.selected[use])?.id ?? '';
      choice.title = choice.selectedOptions[0]?.textContent ?? '';
      const model = modelFor(choice.value);
      if (model) {
        const tested = model.tests[use];
        const result = tested?.ok === false
          ? c.button(t('查看失败原因', 'Details on failure'), () => openTest(model, use))
          : c.node('span', tested ? t('测试通过', 'Test passed') : t('未测试', 'Not tested'));
        result.classList.add('studio-use-test');
        if (result instanceof HTMLButtonElement) result.classList.add('studio-use-test-action');
        result.dataset.status = tested === undefined ? 'unknown' : tested.ok ? 'ready' : 'error';
        identity.append(result);
      }
      choice.addEventListener('change', () => {
        if (pending) {
          choice.value = modelFor(state?.selected[use])?.id ?? '';
          return;
        }
        void mutation('services.select', [use, choice.value || null]);
      }, { signal });
      item.append(choice);
      return item;
    }));
    if (focusedUse) [...useGrid.querySelectorAll('select')].find(choice => choice.dataset.serviceUse === focusedUse)?.focus({preventScroll:true});
  }
  function render() {
    if (!state) return;
    const focusedProvider = (c.doc.activeElement as HTMLElement | null)?.dataset.providerId;
    if (!currentProvider()) selected = state.providers[0]?.id ?? '';
    drawAssignments();
    const provider = currentProvider();
    left.replaceChildren(...state.providers.map(item => {
      const button = c.button(item.name, () => select(item.id));
      button.dataset.providerId = item.id;
      button.setAttribute('aria-pressed', String(item.id === selected));
      return button;
    }));
    if (focusedProvider) {
      const restore = state.providers.some(item => item.id === focusedProvider) ? focusedProvider : selected;
      [...left.querySelectorAll('button')].find(button => button.dataset.providerId === restore)?.focus({preventScroll:true});
    }
    selectProvider.replaceChildren(...state.providers.map(item => makeOption(item.id, item.name)));
    selectProvider.value = selected;
    selectProvider.hidden = !provider;
    emptyProvider.hidden = !!provider;
    grid.hidden = !provider;
    right.hidden = !provider;
    providerTitle.textContent = provider ? provider.name : '';
    if (provider) {
      const localVoice = provider.protocol === localSovits;
      const hasModel = state.models.some(model => model.providerId === provider.id);
      actions.replaceChildren(
        ...(!localVoice ? [c.button(t('获取模型', 'Get models'), () => void findModels(provider), true)] : []),
        ...(!localVoice || !hasModel ? [c.button(localVoice ? t('添加服务默认', 'Add service default') : t('手动添加', 'Add manually'), () => editModel(provider))] : []),
        c.button(t('编辑提供商', 'Edit provider'), () => editProvider(provider)),
        c.button(t('移除提供商', 'Remove provider'), () => remove(t('移除提供商', 'Remove provider'), provider.name, 'services.removeProvider', provider.id)),
      );
      drawModels();
    }
  }
  selectProvider.addEventListener('change', () => select(selectProvider.value), { signal });
  filter.addEventListener('input', drawModels, { signal });
  const addProvider = c.button(t('添加提供商', 'Add provider'), () => editProvider(), true);
  addProvider.disabled = true;
  const readRetry = c.button(t('重新读取', 'Reload'), () => void read());
  const readStatus = c.status();
  readRetry.hidden = true;
  providerActions.append(readRetry, addProvider);
  settingsHeader.after(readStatus);
  async function read() {
    if (readRetry.disabled) return;
    const timeout = AbortSignal.timeout(10_000);
    readRetry.disabled = true;
    readStatus.textContent = '';
    try {
      const next = await c.call<ServiceState>('services.state', [], timeout);
      if (signal.aborted) return;
      state = next;
      readRetry.hidden = true;
      addProvider.disabled = false;
      render();
    }
    catch (error) {
      if (signal.aborted) return;
      if (!state) drawAssignments(t('加载失败', 'Could not load'));
      readRetry.hidden = false;
      readStatus.textContent = timeout.aborted
        ? t('读取模型服务超时。可以重新读取。', 'Model services did not respond in time. Reload to retry.')
        : errorText(error);
    } finally {
      readRetry.disabled = false;
    }
  }
  drawAssignments();
  return { element, read };
}
