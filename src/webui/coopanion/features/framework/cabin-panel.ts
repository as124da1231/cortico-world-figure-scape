import type { PageContext } from '../../base/page.ts';
import type { CabinState } from '../../../../framework/cabin-world.ts';
import { errorText, studioControls, studioText as t } from './controls.ts';
import { sceneTile } from './scene-workspace.ts';
import { SCENE_CHAT_TEXT_MAX, chatTextLengthNote } from '../../../../../web/framework/chat-text.js';

type GameStatus = { position?: { place?: string }; doing?: { label?: string }; wallet?: number; connected?: boolean };
type Receipt = { taskId?: string; status?: string; label?: string; error?: string; ok?: boolean };

export function cabinPanel(ctx: PageContext, refreshRuntime: () => Promise<void>, openSettings: () => void) {
  const c = studioControls(ctx);
  const title = t('小屋世界', 'Cabin World');
  const hint = t('在像素世界里串门、游玩和生活', 'Visit, play and live in a pixel world');
  const setupTitle = t('连接状态', 'Connection status');
  const section = c.section(setupTitle);
  const heading = section.querySelector('h2')!;
  section.classList.add('studio-cabin', 'studio-scene-settings');
  const {button:card, chip} = sceneTile(ctx, 'cabin', title, hint, openSettings);

  const commands = c.node('div','','studio-inline');
  const action = c.node('div','','studio-inline');
  const status = c.status();
  const failure = c.status();
  failure.hidden = true;
  const setup = c.link(t('安装小屋组件','Install Cabin World'),'engines','cabin');
  const open = c.button(t('进入小屋世界','Enter Cabin World'),() => void change('enter'),true);
  open.disabled = true;
  const leave = c.button(t('离开小屋世界','Leave Cabin World'),() => void change('leave'));
  leave.hidden = true;
  const downloadMeter = c.node('progress');
  downloadMeter.setAttribute('aria-label', t('小屋世界下载进度', 'Cabin World download progress'));
  downloadMeter.hidden = true;
  const conversation = c.button(t('对话','Conversation'),() => {
    chat.hidden = !chat.hidden;
    conversation.setAttribute('aria-expanded',String(!chat.hidden));
    if (!chat.hidden) { input.focus(); void readChat().catch(report); }
  });
  conversation.setAttribute('aria-expanded','false');
  commands.append(setup,conversation);
  action.append(open,leave);
  const reloadResidents = c.button(t('刷新住户','Refresh residents'),() => void change('residents'));

  const resident = c.node('select');
  const residentField = c.field(t('切换住户','Change resident'),resident);
  const activeResident = c.node('strong');
  const residentName = c.field(t('当前角色','Current character'),activeResident);
  const bodyActions = c.node('span');
  const bodyActionsField = c.field(t('动作控制','Action control'),bodyActions);
  bodyActionsField.hidden = true;
  const actionResult = c.node('span');
  const actionResultField = c.field(t('最近动作','Latest action'),actionResult);
  actionResultField.hidden = true;
  resident.addEventListener('change',() => void change('actor',[resident.value]),{signal:ctx.signal});
  const play = c.node('div','','studio-inline');
  const place = c.node('select');
  place.setAttribute('aria-label',t('目的地','Destination'));
  for (const [key,label] of [
    ['xjhome',t('回家','Home')],['park',t('公园','Park')],['shop',t('小卖部','Shop')],
    ['onsen',t('汤屋','Onsen')],['arcade',t('电玩城','Arcade')],['restaurant',t('餐厅','Restaurant')],
  ]) {
    const option = c.node('option',label); option.value = key; place.append(option);
  }
  const go = c.button(t('前往','Go'),() => void run('cabin_go',{place:place.value}));
  const stop = c.button(t('停止活动','Stop activity'),() => void run('cabin_stop',{action:'stop'}));
  play.append(place,go,stop,reloadResidents);
  const taskStatus = c.status();
  const chat = c.node('div','','studio-cabin-chat');
  chat.hidden = true;
  const messages = c.node('div','','studio-cabin-messages');
  messages.setAttribute('role','log');
  messages.setAttribute('aria-label',t('会话消息','Conversation messages'));
  const form = c.node('form','','studio-cabin-compose');
  const input = c.node('textarea');
  input.rows = 2;
  input.setAttribute('aria-label',t('给 Coo 发消息','Message Coo'));
  input.placeholder = t('给 Coo 发消息…','Message Coo…');
  const send = c.node('button',t('发送','Send'),'studio-button is-primary');
  send.type = 'submit';
  send.disabled = true;
  const chatStatus = c.status();
  form.append(input,send);
  chat.append(messages,form,chatStatus);
  section.append(status,downloadMeter,commands,residentName,bodyActionsField,actionResultField,residentField,play,taskStatus,chat,failure);
  let sending = false, chatKey = '';
  let draft: {value:string; id:string} | undefined;
  function updateComposer() {
    const lengthNote = chatTextLengthNote(input.value, SCENE_CHAT_TEXT_MAX, t);
    send.disabled = sending || !!lengthNote || !input.value.trim();
    return lengthNote;
  }
  input.addEventListener('input',() => {
    const lengthNote = updateComposer();
    if (!sending || lengthNote) chatStatus.textContent = lengthNote;
  },{signal:ctx.signal});
  input.addEventListener('keydown',event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  },{signal:ctx.signal});
  form.addEventListener('submit',event => {
    event.preventDefault();
    void sendChat();
  },{signal:ctx.signal});

  async function sendChat() {
    const value = input.value.trim();
    if (!value || sending) return;
    const lengthNote = updateComposer();
    if (lengthNote) { chatStatus.textContent = lengthNote; return; }
    if (draft?.value !== value) draft = {value,id:c.doc.defaultView!.crypto.randomUUID()};
    sending = send.disabled = true;
    chatStatus.textContent = t('正在发送…','Sending…');
    try {
      await c.call('cabin.sendMessage',[draft.id,value]);
      if (input.value.trim() === value) input.value = '';
      draft = undefined;
      chatStatus.textContent = t('已发送','Sent');
      await readChat();
    } catch (error) {
      if (!ctx.signal.aborted) chatStatus.textContent = errorText(error);
    } finally {
      sending = false;
      const lengthNote = updateComposer();
      if (lengthNote) chatStatus.textContent = lengthNote;
    }
  }

  async function readChat() {
    const {messages:items} = await c.call<{messages: {cursor:number;side:string;text:string}[]}>('cabin.conversation');
    if (ctx.signal.aborted || chat.hidden) return;
    const key = items.map(item => item.cursor).join(',');
    if (key === chatKey) return;
    chatKey = key;
    messages.replaceChildren(...items.map(item => {
      const line = c.node('p',item.text);
      line.dataset.side = item.side;
      return line;
    }));
    messages.scrollTop = messages.scrollHeight;
  }

  let state: CabinState | undefined, reading: Promise<void> | undefined;
  let pending = '', taskId: string | undefined, statusKey = '', stateRevision = 0;
  const isOpen = () => state?.phase === 'active' && state.presented !== false;
  function report(error: unknown) {
    if (ctx.signal.aborted) return;
    failure.hidden = false;
    failure.textContent = errorText(error);
  }

  function render(next: CabinState) {
    if (ctx.signal.aborted) return;
    if (state?.actor !== next.actor) { taskId = undefined; taskStatus.textContent = ''; }
    state = next;
    const active = isOpen();
    const switching = next.phase === 'active' && next.presented === false;
    const connecting = next.phase === 'connecting' || switching || !active && pending === 'enter';
    const resources = next.resources;
    const needsDownload = resources?.phase === 'needed';
    const needsInstall = !!resources && resources.phase !== 'ready';
    const canEnter = next.canEnter ?? (next.configured && !needsInstall);
    const downloading = resources?.phase === 'downloading' || resources?.phase === 'verifying';
    const preparing = downloading || resources?.phase === 'installing';
    heading.textContent = active ? t('住户与活动', 'Residents and activities') : setupTitle;
    chip.textContent = active ? t('使用中','In use') : resources?.phase === 'downloading' ? t('正在下载','Downloading')
      : resources?.phase === 'verifying' ? t('正在校验','Verifying')
      : next.externalUnavailable ? t('安装不可用','Installation unavailable')
      : connecting || preparing || next.preparing ? t('正在准备','Preparing')
      : resources?.repair ? t('待修复','Repair needed')
      : needsDownload ? t('可下载','Download available') : needsInstall ? t('待安装','Install needed')
      : next.configured ? t('已安装','Installed') : t('待连接','Setup needed');
    card.dataset.current = String(active);
    setup.hidden = active || connecting;
    setup.textContent = next.externalUnavailable ? t('重新选择已有安装','Choose installation again')
      : preparing || next.preparing ? t('查看安装进度','View installation progress')
        : resources?.repair ? t('修复安装','Repair installation')
        : canEnter ? t('管理安装','Manage installation') : t('安装小屋组件','Install Cabin World');
    open.hidden = active || connecting || next.phase === 'leaving' || !canEnter || !!next.preparing;
    open.disabled = !!pending;
    leave.hidden = !active && !connecting;
    leave.disabled = pending === 'leave';
    leave.textContent = connecting ? t('取消进入','Cancel entry') : t('离开小屋世界','Leave Cabin World');
    downloadMeter.hidden = !preparing;
    if (resources?.total) {
      downloadMeter.max = resources.total;
      downloadMeter.value = resources.done;
    } else downloadMeter.removeAttribute('value');
    conversation.hidden = residentName.hidden = play.hidden = !active;
    if (!active) { chat.hidden = true; conversation.setAttribute('aria-expanded','false'); }
    residentField.hidden = reloadResidents.hidden = !active || next.residents.length < 2;
    activeResident.textContent = active ? next.residents.find(item => item.key === next.actor)?.name ?? '' : '';
    bodyActionsField.hidden = !active || !next.body;
    bodyActions.textContent = next.body?.kind === 'figure'
      ? next.body.wordSource === 'renderer'
        ? t(`梦境角色 · ${next.body.words.length} 个可用动作`, `Figure Scape · ${next.body.words.length} available actions`)
        : t(`梦境角色 · 形象包声明 ${next.body.words.length} 个动作`, `Figure Scape · ${next.body.words.length} declared actions`)
      : t('小屋世界原生活动', 'Cabin World activities');
    actionResultField.hidden = !active || !next.action;
    if (next.action) {
      const labels = {
        queued:t('排队中','Queued'), running:t('正在播放','Playing'), completed:t('身体已报告结束','Body reported completion'),
        elapsed:t('已到预计时长','Estimated time elapsed'), failed:t('播放失败','Playback failed'),
        interrupted:t('已中断','Interrupted'), unconfirmed:t('未确认完成','Completion unconfirmed'),
      };
      const label = `${labels[next.action.status]} · ${next.action.words.join(' → ')}`;
      if (actionResult.textContent !== label) actionResult.textContent = label;
    }
    resident.disabled = !!pending;
    const canGo = active && next.tools?.includes('cabin_go') !== false;
    const canStop = active && next.tools?.includes('cabin_stop') !== false;
    place.hidden = go.hidden = !canGo;
    stop.hidden = !canStop;
    go.disabled = stop.disabled = reloadResidents.disabled = !!pending;
    const key = JSON.stringify(next.residents);
    if (key !== statusKey) {
      statusKey = key;
      resident.replaceChildren(...next.residents.map(item => {
        const option = c.node('option',item.name); option.value = item.key; return option;
      }));
    }
    if (next.actor) resident.value = next.actor;
    const totalMB = Math.ceil((resources?.total ?? 0) / 1_000_000);
    const doneMB = Math.floor((resources?.done ?? 0) / 1_000_000);
    const preparingText = resources?.phase === 'downloading' ? t('正在下载小屋世界', 'Downloading Cabin World') + ` · ${doneMB} / ${totalMB} MB`
      : resources?.phase === 'verifying' ? t('正在校验小屋资源…', 'Verifying Cabin World resources…')
      : t('正在安装小屋世界…', 'Installing Cabin World…');
    if (!active || !section.isConnected) status.textContent = active ? t('小屋世界已连接','Cabin World connected')
      : switching ? t('正在切换窗口…','Switching windows…')
      : preparing ? preparingText
      : connecting ? t('等待游戏窗口和住户就绪…','Waiting for the game and resident…')
      : next.externalUnavailable ? t('请在引擎页重新选择小屋世界的安装。','Choose the Cabin World installation again in Engines.')
      : resources?.failure ? t('组件未安装完成，请到引擎页查看和重试。','Setup did not finish. See details and retry in Engines.')
      : needsDownload && !next.detail ? t('请到引擎页安装 · ', 'Install from Engines · ') + `${totalMB} MB`
      : needsInstall && !next.detail ? t('请在引擎页完成安装。','Complete setup from Engines.')
      : next.detail ?? (next.configured ? t('进入后可切换住户和安排活动。','Enter to switch residents and choose activities.')
        : t('请在引擎页选择小屋世界的安装来源。','Choose an installation from Engines.'));
    if (!active) { taskId = undefined; taskStatus.textContent = ''; }
  }

  async function selectStatus() {
    const requestedActor = state?.actor;
    const [current,receipt] = await Promise.all([
      c.call<GameStatus>('cabin.tool',['cabin_status',{}]),
      taskId ? c.call<Receipt>('cabin.tool',['cabin_task',{taskId}]) : Promise.resolve(undefined),
    ]);
    if (!isOpen() || ctx.signal.aborted || state?.actor !== requestedActor) return;
    const facts = [current.position?.place,current.doing?.label,
      typeof current.wallet === 'number' ? t('余额 ','Balance ') + current.wallet : ''].filter(Boolean);
    status.textContent = facts.length ? facts.join(' · ') : t('小屋世界已连接','Cabin World connected');
    if (receipt) showReceipt(receipt);
  }

  function showReceipt(receipt: Receipt) {
    taskId = receipt.status === 'running' ? receipt.taskId : undefined;
    taskStatus.textContent = receipt.error ?? (receipt.status === 'done' ? t('已完成','Completed')
      : receipt.status === 'running' ? receipt.label ?? t('进行中','In progress') : '');
  }

  function refresh() {
    const revision = stateRevision;
    reading ??= c.call<CabinState>('cabin.state').then(async value => {
      if (ctx.signal.aborted || revision !== stateRevision) return;
      render(value);
      if (isOpen() && !pending && section.isConnected) {
        await Promise.all([selectStatus(),...(chat.hidden ? [] : [readChat()])]);
      }
    }).catch(report).finally(() => { reading = undefined; });
    return reading;
  }

  async function change(method: string,args: unknown[] = []) {
    if (pending && !(method === 'leave' && pending === 'enter')) return;
    const revision = ++stateRevision;
    pending = method;
    failure.hidden = true;
    if (state) render(state);
    try {
      const next = await c.call<CabinState>('cabin.'+method,args);
      if (revision === stateRevision) render(next);
    } catch (error) { if (revision === stateRevision) report(error); }
    finally {
      if (revision === stateRevision) { pending = ''; stateRevision++; }
      await reading;
      await Promise.all([refresh(),refreshRuntime()]);
    }
  }

  async function run(tool: string,args: Record<string,unknown>) {
    if (pending) return;
    pending = tool;
    failure.hidden = true;
    if (state) render(state);
    try { showReceipt(await c.call<Receipt>('cabin.tool',[tool,args])); }
    catch (error) { report(error); }
    finally { pending = ''; await refresh(); }
  }

  return {title,hint,card,section,action,refresh};
}
