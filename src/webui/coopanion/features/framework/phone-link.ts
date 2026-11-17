import { invokePanelBinary } from '../../base/api.ts';
import type { PageContext } from '../../base/page.ts';
import { WORKSPACE_PROVIDER } from '../../../../framework/workspace.ts';
import type { PhonePairCode } from '../../../../phone-link/link.mjs';
import type { PhoneConnectionState } from '../../../../phone-link/service.ts';
import { ICONS } from '../../../../../web/icons.js';
import { errorText, studioControls, studioText as t } from './controls.ts';

export function phoneLinkPanel(ctx: PageContext) {
  const c = studioControls(ctx), { signal } = ctx;
  const view = c.doc.defaultView!;
  const element = c.node('section', '', 'studio-phone-card');
  const icon = c.node('span', '', 'studio-phone-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = ICONS.phone;
  const copy = c.node('div', '', 'studio-phone-copy');
  const summary = c.status('studio-phone-summary');
  copy.append(c.node('h2', 'Figure Pet'), summary);
  const dialog = c.dialog(t('连接 Figure Pet', 'Connect Figure Pet'), 'studio-phone-dialog');
  const manage = c.button(t('连接手机', 'Connect phone'), () => {
    if (dialog.open(manage)) void update();
  }, true);
  manage.setAttribute('aria-haspopup', 'dialog');
  const download = c.button(t('下载 APK', 'Download APK'), () => void downloadApk());
  download.disabled = true;
  const actions = c.node('div', '', 'studio-phone-actions');
  actions.append(download, manage);
  element.append(icon, copy, actions);

  const feedback = c.status('studio-phone-feedback');
  const enable = c.button(t('启用手机连接', 'Enable phone connection'), () => void setEnabled(true), true);
  const disable = c.button(t('停用连接', 'Turn off connection'), () => void setEnabled(false));
  const connection = c.node('section', '', 'studio-phone-section');
  const connectionRow = c.node('div', '', 'studio-phone-section-header');
  const status = c.status('studio-phone-summary');
  const connectionCopy = c.node('div');
  connectionCopy.append(c.node('h3', t('局域网连接', 'Local network connection')), status);
  connectionRow.append(connectionCopy, enable, disable);
  connection.append(connectionRow);

  const pair = c.node('section', '', 'studio-phone-section');
  const pairHeader = c.node('div', '', 'studio-phone-section-header');
  const generate = c.button(t('生成配对码', 'Generate pairing code'), () => void generateCode(), true);
  const address = c.node('select');
  address.setAttribute('aria-label', t('电脑的局域网地址', 'Computer’s local address'));
  pairHeader.append(c.node('h3', t('扫码配对', 'Pair a phone')), address, generate);
  const guidance = c.node('p', t(
    '手机和电脑连同一个网络，在 Figure Pet 的「设置 → 连接 Coo」扫码。',
    'Connect both devices to the same network. In Figure Pet, scan from Settings → Connect to Coo.',
  ), 'studio-phone-summary');
  const qr = c.node('div', '', 'studio-phone-code');
  qr.hidden = true;
  const qrImage = c.node('img');
  qrImage.alt = t('Figure Pet 配对二维码', 'Figure Pet pairing QR code');
  qrImage.width = qrImage.height = 192;
  const qrNote = c.status('studio-phone-summary');
  qr.append(qrImage, qrNote);
  pair.append(pairHeader, guidance, qr);

  const paired = c.node('section', '', 'studio-phone-section');
  const list = c.node('ul', '', 'studio-phone-devices');
  paired.append(c.node('h3', t('已配对设备', 'Paired devices')), list);
  dialog.body.append(connection, pair, paired, feedback);

  let state: PhoneConnectionState | undefined;
  let ticket: PhonePairCode | undefined;
  let confirmedDevice = '';
  let problem = '';
  let busy = false, reading = false, downloading = false, generation = 0;
  let deviceKey = '';

  function connectionMessage() {
    if (state?.issue === 'port-in-use') return t('连接端口已占用。请关闭旧的 Figure Pet 连接服务后重试。', 'Close the previous Figure Pet connector to free its port, then retry.');
    if (state?.issue) return t('连接服务启动失败，可以重新启用。', 'Could not start the connector. Try enabling it again.');
    if (state?.running && !state.ready) return state.coo;
    return state?.running ? t('等待手机扫码或重连', 'Ready for pairing or reconnection') :
      t('启用后可在同一局域网配对。', 'Enable to pair on the local network.');
  }

  function clearCode() {
    ticket = undefined;
    qr.hidden = true;
    qrImage.removeAttribute('src');
  }

  function renderDevices() {
    const devices = state?.devices ?? [];
    const key = JSON.stringify([devices, confirmedDevice]);
    if (key !== deviceKey) {
      deviceKey = key;
      list.replaceChildren(...devices.map(device => {
        const row = c.node('li', '', 'studio-phone-device');
        row.append(c.node('span', device.name));
        if (confirmedDevice === device.id) {
          row.append(
            c.button(t('取消', 'Cancel'), () => { confirmedDevice = ''; render(); }),
            c.button(t('确认解除', 'Confirm unpair'), () => void revoke(device.id)),
          );
        } else {
          const remove = c.button(t('解除配对', 'Unpair'), () => { confirmedDevice = device.id; render(); });
          remove.setAttribute('aria-label', t('解除配对', 'Unpair') + ' · ' + device.name);
          row.append(remove);
        }
        return row;
      }));
      if (!devices.length) list.append(c.node('li', t('还没有已配对的手机。', 'No phones are paired.'), 'studio-phone-summary'));
    }
    for (const button of list.querySelectorAll('button')) button.disabled = busy;
  }

  function render() {
    const count = state?.devices.length ?? 0;
    const running = state?.running === true;
    const ready = running && state?.ready === true;
    summary.textContent = ready
      ? count ? t('已配对 ', 'Paired phones: ') + count + t(' 台手机', '') : t('等待手机配对', 'Ready to pair')
      : t('在 Android 手机上接续对话和装扮', 'Continue chat and outfits on Android');
    manage.textContent = running ? t('管理连接', 'Manage connection') : t('连接手机', 'Connect phone');
    status.textContent = connectionMessage();
    status.dataset.error = String(!!state?.issue || (running && !ready));
    feedback.textContent = problem;
    download.disabled = downloading || !state?.apk;
    download.textContent = downloading ? t('正在下载…', 'Downloading…') : t('下载 APK', 'Download APK');
    enable.hidden = running;
    disable.hidden = !running;
    enable.disabled = disable.disabled = busy;
    pair.hidden = paired.hidden = !running;
    const addresses = state?.addresses ?? [];
    if (Array.from(address.options, option => option.value).join() !== addresses.join()) {
      const previous = address.value;
      address.replaceChildren(...addresses.map(ip => {
        const option = c.node('option', ip);
        option.value = ip;
        return option;
      }));
      if (addresses.includes(previous)) address.value = previous;
      else clearCode();
    }
    address.hidden = addresses.length < 2;
    address.disabled = busy;
    generate.disabled = busy || !ready || !addresses.length;
    guidance.textContent = addresses.length
      ? t('手机和电脑连同一个网络，在 Figure Pet 的「设置 → 连接 Coo」扫码。', 'Connect both devices to the same network. In Figure Pet, scan from Settings → Connect to Coo.')
      : t('暂未发现局域网地址，请先让电脑连上网络。', 'Connect the computer to a local network to pair.');
    renderDevices();
  }

  function receive(next: PhoneConnectionState) {
    if (!next.running || next.devices.length > (state?.devices.length ?? 0)) clearCode();
    state = next;
    render();
  }

  async function update() {
    if (busy || reading || signal.aborted) return;
    reading = true;
    const requested = ++generation;
    try {
      const next = await c.call<PhoneConnectionState>('phone.state');
      if (!signal.aborted && requested === generation && next) receive(next);
    } catch (error) {
      if (!signal.aborted && requested === generation && dialog.element.open) {
        problem = errorText(error);
        render();
      }
    } finally { reading = false; }
  }

  async function perform(work: () => Promise<void>) {
    if (busy || signal.aborted) return;
    busy = true;
    generation++;
    problem = '';
    render();
    try { await work(); }
    catch (error) { if (!signal.aborted) problem = errorText(error); }
    finally { busy = false; if (!signal.aborted) render(); }
  }

  function setEnabled(enabled: boolean) {
    return perform(async () => {
      const next = await c.call<PhoneConnectionState>('phone.setEnabled', [enabled]);
      if (!signal.aborted) receive(next);
    });
  }

  function revoke(id: string) {
    return perform(async () => {
      const next = await c.call<PhoneConnectionState>('phone.revoke', [id]);
      if (!signal.aborted) {
        confirmedDevice = '';
        receive(next);
      }
    });
  }

  function generateCode() {
    return perform(async () => {
      clearCode();
      const next = await c.call<PhonePairCode>('phone.pair', [address.value]);
      if (signal.aborted || !dialog.element.open) return;
      ticket = next;
      qrImage.src = next.qr;
      qr.hidden = false;
      qrNote.textContent = t('配对码五分钟内有效，可使用一次。', 'The code expires in five minutes and can be used once.');
    });
  }

  async function downloadApk() {
    downloading = true;
    render();
    try {
      const apk = await invokePanelBinary(WORKSPACE_PROVIDER, 'framework', 'phone.apk', [], { signal });
      if (signal.aborted) return;
      const url = view.URL.createObjectURL(apk);
      const link = c.node('a');
      link.href = url;
      link.download = 'figure-pet-1.0.0.apk';
      link.click();
      view.setTimeout(() => view.URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (!signal.aborted) {
        problem = errorText(error);
        if (!dialog.element.open) dialog.open(download);
      }
    } finally { downloading = false; if (!signal.aborted) render(); }
  }

  dialog.element.addEventListener('close', () => {
    clearCode();
    problem = confirmedDevice = '';
    render();
  }, { signal });
  address.addEventListener('change', clearCode, { signal });
  ctx.lifecycle.interval(() => {
    if (!dialog.element.open) return;
    if (ticket && ticket.expires <= Date.now()) {
      clearCode();
      problem = t('配对码已过期，请重新生成。', 'The pairing code expired. Generate a new one.');
      render();
    }
    void update();
  }, 2500);
  render();
  return { element, update };
}
