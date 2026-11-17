import type { PageContext } from '../../base/page.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';

type Sdk = { ok: boolean; local: boolean; reusable: boolean; version: string; bytes: number; consentAt: number | null; running: boolean; official: string; messages: string[] };

export function runtimeComponents(ctx: PageContext, version: string) {
  const c = studioControls(ctx);
  const license = c.dialog(t('须知', 'Notice'), 'studio-license-dialog');
  let sdkState: Sdk | null = null, licenseReading = 0, sdkWorking = false;
  const licenseSummary = c.node('div', '', 'studio-license-summary');
  const licenseRow = c.node('div', '', 'studio-license-row');
  const sdkStatus = c.status();
  const links = c.node('div', '', 'studio-inline');
  const official = c.node('a', t('打开官网', 'Official site'));
  official.target = '_blank';
  official.rel = 'noopener noreferrer';
  const licenseText = c.node('pre', '', 'studio-license-text');
  licenseText.tabIndex = 0;
  const licensePage = c.node('section', '', 'studio-license-page');
  const summaryPage = c.node('div');
  let previous: HTMLButtonElement | undefined;
  const back = c.button(t('返回须知', 'Back to notice'), () => {
    licenseReading++;
    license.heading.textContent = summaryTitle();
    license.body.replaceChildren(summaryPage);
    license.body.scrollTop = 0;
    previous?.focus({preventScroll:true});
  });
  licensePage.append(back, licenseText);
  const sdkFeedback = c.status();
  const sdkProgress = c.node('progress');
  sdkProgress.setAttribute('aria-label', t('Live2D 运行组件进度', 'Live2D runtime progress'));
  sdkProgress.hidden = true;
  const install = c.button(t('同意许可并下载', 'Accept licenses and download'), () => void installSdk(), true);
  for (const [kind, label] of [['core', t('Core 许可', 'Core license')], ['sdk', t('SDK 许可', 'SDK license')]]) {
    const link = c.button(label, () => void showLicense(kind, label, link));
    links.append(link);
  }
  links.append(official);
  licenseRow.append(sdkStatus, links);
  licenseSummary.append(c.node('strong', 'Live2D'), licenseRow);
  let onReturn: (() => void) | undefined;
  const summaryTitle = () => onReturn ? t('组件与许可', 'Components and licenses') : t('须知', 'Notice');
  const goBack = c.button(t('返回运行详情', 'Back to runtime details'), () => {
    license.element.close();
    onReturn?.();
  });
  goBack.classList.add('studio-runtime-notice-back');
  goBack.hidden = true;
  summaryPage.append(goBack, c.node('p', 'v' + version, 'studio-notice-version'), c.node('p', t('首次加载需要在本机准备 Live2D 运行组件。', 'The first load requires the local Live2D runtime.')), licenseSummary, install, sdkProgress, sdkFeedback);
  license.body.append(summaryPage);

  function renderSdk(next: Sdk | null) {
    sdkState = next;
    sdkStatus.textContent = !next ? '' : next.local
      ? t('运行组件已就绪 · ', 'Runtime ready · ') + next.version + ' · ' + Math.round(next.bytes / 1024) + ' KB · ' + t('已校验', 'Verified')
      : next.reusable ? t('可复用一键安装的已校验组件', 'Verified runtime from Figure is available')
        : t('运行组件尚未就绪', 'Runtime required');
    if (next?.official && /^https:\/\//.test(next.official)) official.href = next.official;
    else official.removeAttribute('href');
    official.hidden = !official.hasAttribute('href');
    install.hidden = !next || next.local;
    install.disabled = sdkWorking || !!next?.running;
    install.textContent = next?.reusable ? t('复用本机组件', 'Use local runtime')
      : next?.consentAt ? t('获取运行组件', 'Get runtime') : t('同意许可并下载', 'Accept licenses and download');
    sdkProgress.hidden = !sdkWorking && !next?.running;
    if (next?.running && next.messages.length) sdkFeedback.textContent = next.messages.at(-1)!;
  }

  async function openLicense(backToDetails?: () => void) {
    if (!license.open()) return;
    onReturn = backToDetails;
    goBack.hidden = !onReturn;
    license.heading.textContent = summaryTitle();
    license.body.replaceChildren(summaryPage);
    license.body.scrollTop = 0;
    previous = undefined;
    licenseReading++;
    renderSdk(null);
    sdkFeedback.textContent = t('正在校验本机组件…', 'Checking local components…');
    try {
      const next = await c.call<Sdk | null>('resources.runtimeState');
      if (ctx.signal.aborted) return;
      sdkFeedback.textContent = next ? '' : t('暂时读不到组件状态。', 'Runtime status is unavailable.');
      renderSdk(next);
    } catch (error) { if (!ctx.signal.aborted) sdkFeedback.textContent = errorText(error); }
  }
  license.element.addEventListener('close', () => { if (!license.element.open) licenseReading++; }, {signal:ctx.signal});
  async function showLicense(kind: string, label: string, trigger: HTMLButtonElement) {
    const token = ++licenseReading;
    previous = trigger;
    license.heading.textContent = label;
    license.body.replaceChildren(licensePage);
    license.body.scrollTop = 0;
    licenseText.scrollTop = 0;
    back.focus();
    licenseText.textContent = t('正在读取许可…', 'Reading license…');
    try {
      const result = await c.call<{ text: string }>('resources.runtimeLicense', [kind]);
      if (!ctx.signal.aborted && token === licenseReading) licenseText.textContent = result.text;
    } catch (error) {
      if (!ctx.signal.aborted && token === licenseReading) licenseText.textContent = errorText(error);
    }
  }
  async function installSdk() {
    if (!sdkState || sdkWorking) return;
    sdkWorking = true;
    renderSdk(sdkState);
    sdkFeedback.textContent = t('正在获取和校验组件…', 'Downloading and verifying components…');
    try {
      sdkState = await c.call<Sdk>('resources.ensureRuntime', [!sdkState.reusable && !sdkState.consentAt]);
      sdkFeedback.textContent = sdkState.local ? t('组件已校验，可以打开模型。', 'Runtime verified. You can open a model.') : t('组件尚未就绪。', 'Runtime is still unavailable.');
    } catch (error) { if (!ctx.signal.aborted) sdkFeedback.textContent = errorText(error); }
    finally { sdkWorking = false; if (!ctx.signal.aborted) renderSdk(sdkState); }
  }
  async function poll() {
    if (!license.element.open || (!sdkWorking && !sdkState?.running)) return;
    const next = await c.call<Sdk | null>('resources.runtimeState').catch(() => null);
    if (!ctx.signal.aborted && license.element.open && next && (sdkWorking || sdkState?.running)) {
      renderSdk(next);
      if (next.local) sdkFeedback.textContent = '';
    }
  }
  return { open: openLicense, poll };
}
