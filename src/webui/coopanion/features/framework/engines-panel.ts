import type { CabinState } from '../../../../framework/cabin-world.ts';
import type { PageContext } from '../../base/page.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';
import { runtimeComponents, type Sdk } from './runtime-components.ts';
import './engines-panel.css';

export function enginesPanel(ctx: PageContext) {
  const c = studioControls(ctx);
  const components = runtimeComponents(ctx);

  function card(title: string, type: string, description: string) {
    const element = c.node('section', '', 'studio-engine');
    const header = c.node('header', '', 'studio-engine-header');
    const heading = c.node('h2', title);
    const kind = c.node('span', type, 'studio-engine-kind');
    header.append(heading, kind);
    const status = c.status('studio-engine-state');
    const controls = c.node('div', '', 'studio-engine-actions');
    element.append(header, c.node('p', description, 'studio-engine-description'), status, controls);
    return { element, status, controls };
  }

  const live2d = card('Live2D', t('角色渲染', 'Character renderer'),
    t('用于原始 Live2D 模型和使用 Cubism 的形象包。', 'Renders Live2D source models and figure packs that use Cubism.'));
  const componentAction = c.button(t('组件与许可', 'Components and licenses'), () => void components.open());
  live2d.controls.append(componentAction);
  const cabin = card(t('小屋世界', 'Cabin World'), t('场景引擎', 'Scene engine'),
    t('安装适配组件，或选择电脑上已有的小屋世界。', 'Install the compatible runtime or select a local Cabin World installation.'));
  const transfer = c.node('div', '', 'studio-engine-transfer');
  const version = c.node('p', '', 'studio-engine-version');
  cabin.controls.before(transfer);
  const source = c.node('a', t('上游发布页', 'Upstream release'), 'studio-link');
  source.href = 'https://github.com/BabyBus2022/cabin-world/releases/tag/V1.1.0';
  source.rel = 'noopener noreferrer';
  source.target = '_blank';
  let primaryCommand: 'cabin.prepare' | 'cabin.enter' | undefined;
  const primary = c.button(t('正在读取…', 'Reading…'), () => { if (primaryCommand) void change(primaryCommand); }, true);
  primary.classList.add('studio-engine-primary');
  primary.disabled = true;
  const cancel = c.button(t('取消', 'Cancel'), () => void change('cabin.cancelPrepare'));
  const choose = c.button(t('选择已有安装', 'Choose existing installation'), () => void chooseInstall());
  const managed = c.button(t('由梦境管理', 'Use managed runtime'), () => void change('cabin.configure', [null]));
  const progress = c.node('progress');
  progress.setAttribute('aria-label', t('小屋世界组件进度','Cabin World component progress'));
  progress.hidden = cancel.hidden = managed.hidden = true;
  const failure = c.status('studio-engine-error');
  failure.tabIndex = 0;
  failure.hidden = true;
  transfer.append(version, progress, failure);
  cabin.controls.append(primary, choose, managed, source, cancel);

  const spriter = card(t('Spriter · 饥荒角色', 'Spriter · Don’t Starve characters'), t('角色格式', 'Character format'),
    t('读取单角色工程里的骨骼、分层 PNG、动画和装扮映射。', 'Reads bones, layered PNGs, animations and outfits from single-character projects.'));
  spriter.status.textContent = t('可导入 .scml 和配套 PNG', 'Ready for .scml projects with PNGs');
  spriter.status.dataset.state = 'ready';
  spriter.controls.append(c.link(t('前往角色库导入', 'Import in the character library'), 'framework', 'library'));

  let working = '', commandError = '', revision = 0;
  let current: CabinState | undefined, checkingCabin: Promise<void> | undefined;
  const installErrors = {
    network: t('下载中断，请检查网络后重试。', 'Download interrupted. Check your connection and try again.'),
    unpublished: t('小屋组件的发布附件暂不可用。可以重试，或选择已有安装。', 'The release asset is unavailable. Try again or select an existing installation.'),
    integrity: t('组件校验失败。请重试下载完整组件。', 'Verification failed. Retry to download the complete runtime.'),
    'disk-space': t('磁盘空间不足，请释放空间后重试。', 'Free some disk space, then try again.'),
    'in-use': t('组件文件正在使用，请关闭小屋世界后重试。', 'Close Cabin World and try again.'),
    install: t('组件安装失败，可以重试或选择已有安装。', 'Installation failed. Retry or select an existing installation.'),
  };
  function showError() {
    const problem = current?.resources?.failure;
    failure.textContent = (problem && !working ? installErrors[problem] : '') || commandError
      || (current?.externalUnavailable ? t('找不到原来的安装，请重新选择程序。', 'Could not find the selected installation. Choose its executable again.') : '')
      || (current?.phase === 'error' ? current.detail ?? '' : '');
    failure.hidden = !failure.textContent;
    transfer.dataset.error = String(!failure.hidden);
  }
  function render(next: CabinState) {
    current = next;
    const res = next.resources;
    const busy = Boolean(working || next.preparing || next.phase === 'connecting' || next.phase === 'leaving');
    const external = next.configured && !next.bundled;
    const ready = res?.phase === 'ready' || next.bundled === true && !res;
    const active = next.phase === 'active';
    const download = res?.phase === 'downloading';
    const preparing = download || res?.phase === 'verifying' || res?.phase === 'installing' || !!next.preparing || working === 'cabin.prepare';
    const total = Math.ceil((res?.total ?? 0) / 1_000_000);
    const canEnter = next.canEnter ?? (external || ready);
    version.textContent = res?.version
      ? res.version + (res.phase === 'needed' || download ? ` · ${total} MB` : '') : '';
    cabin.status.textContent = active ? t('使用中', 'In use')
      : next.phase === 'connecting' ? t('正在进入…', 'Entering…')
      : download ? t('正在下载', 'Downloading') + ` · ${Math.floor(res!.done / 1_000_000)} / ${total} MB`
      : res?.phase === 'verifying' ? t('校验中', 'Verifying')
      : res?.phase === 'installing' ? t('正在安装', 'Installing')
      : preparing ? t('正在准备', 'Preparing')
      : next.externalUnavailable ? t('安装位置不可用', 'Installation unavailable')
      : external ? t('外部安装 · ', 'External installation · ') + next.name
      : ready ? t('已安装', 'Installed')
      : res?.repair ? t('安装需要修复', 'Installation needs repair')
      : res?.phase === 'local' ? t('本机已有资源，可直接安装', 'Resources available locally')
      : res?.phase === 'needed' ? t('可下载', 'Download available')
      : t('待连接', 'Setup needed');
    cabin.status.dataset.state = preparing || next.phase === 'connecting' ? 'working' : canEnter ? 'ready' : 'needed';
    progress.hidden = !preparing;
    progress.max = res?.total || 1;
    if (download) progress.value = res!.done;
    else progress.removeAttribute('value');
    const entry = !preparing && (canEnter || active || next.phase === 'connecting');
    primaryCommand = entry ? 'cabin.enter' : res && (!ready || preparing) ? 'cabin.prepare' : undefined;
    primary.textContent = entry
      ? (active ? t('使用中', 'In use')
        : next.phase === 'connecting' || working === 'cabin.enter' ? t('正在进入…', 'Entering…')
          : next.phase === 'error' ? t('重试进入', 'Retry entry') : t('进入小屋世界', 'Enter Cabin World'))
      : preparing ? t('正在准备…', 'Preparing…')
      : res?.repair ? t('修复安装', 'Repair installation')
      : res?.phase === 'local' ? t('安装本机资源', 'Install local resources')
        : res?.failure ? t('重试下载', 'Retry download')
          : primaryCommand ? t('下载并安装', 'Download and install') : t('等待安装', 'Awaiting setup');
    const cancelFocused = c.doc.activeElement === cancel;
    cancel.hidden = !preparing;
    choose.disabled = managed.disabled = busy || active;
    primary.disabled = busy || active || !primaryCommand;
    if (cancelFocused && cancel.hidden && !primary.disabled) primary.focus({preventScroll:true});
    cancel.disabled = working === 'cabin.cancelPrepare';
    managed.hidden = !external || !next.managedAvailable;
    showError();
  }

  function readCabin() {
    const requestedRevision = revision;
    checkingCabin ??= c.call<CabinState>('cabin.state')
      .then(next => { if (!ctx.signal.aborted && requestedRevision === revision) render(next); })
      .catch(error => { if (!ctx.signal.aborted && !current) cabin.status.textContent = errorText(error); })
      .finally(() => { checkingCabin = undefined; });
    return checkingCabin;
  }

  async function change(method: string, args: unknown[] = []) {
    if (working && method !== 'cabin.cancelPrepare') return;
    revision++;
    working = method;
    commandError = '';
    if (current) render(current);
    try {
      const next = await c.call<CabinState>(method, args);
      if (!ctx.signal.aborted && working === method) render(next);
    } catch (error) {
      if (!ctx.signal.aborted && working === method) commandError = errorText(error);
    } finally {
      if (working === method) {
        working = '';
        revision++;
        if (current) render(current);
        else showError();
      }
      await checkingCabin;
      await readCabin();
    }
  }

  async function chooseInstall() {
    try {
      const file = await ctx.pickPath?.({ kind:'file', title:'CabinWorld.exe', extensions:['.exe'] });
      if (file) await change('cabin.configure', [file]);
    } catch (error) {
      if (!ctx.signal.aborted) { commandError = errorText(error); showError(); }
    }
  }

  async function readLive2d() {
    try {
      const sdk = await c.call<Sdk | null>('resources.runtimeState');
      if (ctx.signal.aborted) return;
      live2d.status.textContent = !sdk ? t('组件状态不可用', 'Status unavailable')
        : sdk.local ? t('已就绪 · ', 'Ready · ') + sdk.version
        : sdk.running ? t('正在准备', 'Preparing')
        : sdk.reusable ? t('可复用本机组件', 'Local runtime available')
        : t('待准备', 'Setup needed');
      live2d.status.dataset.state = sdk?.local ? 'ready' : sdk?.running ? 'working' : 'needed';
    } catch (error) {
      if (!ctx.signal.aborted) live2d.status.textContent = errorText(error);
    }
  }
  live2d.status.textContent = cabin.status.textContent = t('正在读取…', 'Reading…');
  let refreshSdkAfter = 0;
  return {
    live2d:live2d.element, cabin:cabin.element, spriter:spriter.element, readLive2d, readCabin,
    poll() {
      void readCabin();
      void components.poll();
      if (Date.now() >= refreshSdkAfter) {
        refreshSdkAfter = Date.now() + 5000;
        void readLive2d();
      }
    },
  };
}
