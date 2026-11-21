import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CABIN_TOOLS, cabinArguments } from './cabin-tools.ts';
import { CABIN_BOOT_FILES, CabinInstallError, type CabinInstallFailure, type CabinResourceState } from './cabin-bundle.ts';
import type { SpeechOrder } from './speech-handoff.ts';
import { createCabinStage, recoverCabinStages, removeCabinStage } from '../../host/cabin-stage.mjs';

export type CabinConfig = { root: string; actor?: string; source?: 'external' | 'managed' };
export type CabinRuntime = { root: string; dataDir: string };
type RenderedCabinBody = { kind: 'figure'; figure: string; generation: string; words: string[]; wordSource: 'renderer' | 'manifest' };
type CabinActionReceipt = 'queued' | 'rejected' | 'unconfirmed';
export type CabinAction = {
  id: string;
  generation: string;
  words: string[];
  status: 'queued' | 'running' | 'completed' | 'elapsed' | 'failed' | 'interrupted' | 'unconfirmed';
  completion?: 'duration' | 'body-event';
  reason?: string;
};
export type CabinState = {
  configured: boolean;
  name: string | null;
  bundled?: boolean;
  resources?: CabinResourceState;
  preparing?: boolean;
  managedAvailable?: boolean;
  canEnter?: boolean;
  externalUnavailable?: boolean;
  phase: 'idle'|'connecting'|'active'|'leaving'|'error';
  owner: 'managed'|'external'|null;
  actor: string | null;
  residents: { key: string; name: string }[];
  detail: string | null;
  presented?: boolean;
  body?: RenderedCabinBody | { kind: 'resident' };
  action?: CabinAction;
  tools?: string[];
};
type Row = Record<string, unknown>;
type Install = CabinRuntime & { resident: string; bundled: boolean };
type Connection = { url: string; token: string };
export type CabinBody = { key: string; name: string; url: string; electron: string };
type CabinConversation = {phase:string; messages:{cursor:number;side:string;text:string}[]};
const workerPath = fileURLToPath(new URL('../../host/cabin-world.mjs', import.meta.url));
const childEnvKeys = new Set(['systemroot','windir','systemdrive','path','temp','tmp','userprofile','appdata','localappdata','programdata']);
const supportedCommands = new Set(CABIN_TOOLS.map(tool => tool.name));
const incompatibleBridge = '此版本的小屋世界缺少住户接口。请选择小屋世界 1.1 的完整安装。';

function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Cabin World returned an invalid response');
  return value as Row;
}

async function jsonFile(file: string) {
  if ((await stat(file)).size > 128 * 1024) throw Error('Cabin World configuration is too large');
  return record(JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/, '')));
}

function bridgeCommands(catalog: Row): string[] {
  const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
  const names = new Set(tools.map(tool => tool?.function?.name));
  if (!names.has('cabin_residents') || !names.has('cabin_status')) throw Error(incompatibleBridge);
  return Array.from(supportedCommands).filter(name => names.has(name));
}

async function installation(directory: unknown, bundledDataDir?: string): Promise<Install> {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw Error('Choose the Cabin World installation folder');
  const root = await realpath(basename(directory).toLowerCase() === 'cabinworld.exe' ? dirname(directory) : directory);
  const bridge = join(root,'bridge');
  for (const file of [join(root,'CabinWorld.exe'),join(bridge,'bridge.mjs')]) {
    if (!(await stat(file).catch(() => null))?.isFile()) throw Error('请选择完整解压的小屋世界安装，包含 CabinWorld.exe 和 bridge。');
  }
  const cfg = await jsonFile(join(bridge,'bridge.config.json')).catch(() => {
    throw Error('小屋世界的桥接配置无法读取，请重新解压官方安装包。');
  });
  bridgeCommands(await jsonFile(join(bridge,'openai-tools.json')).catch(() => {
    throw Error('小屋世界的桥接工具清单无法读取，请重新解压官方安装包。');
  }));
  return { root, bundled: !!bundledDataDir,
    dataDir:bundledDataDir ?? resolve(root,'bridge',typeof cfg.dataDir === 'string' && cfg.dataDir ? cfg.dataDir : '../data'),
    resident:typeof cfg.resident === 'string' && cfg.resident ? cfg.resident : 'xiaojingyu' };
}

async function discovery(install: Install): Promise<Connection> {
  const row = await jsonFile(join(install.dataDir,'bridge.json'));
  if (typeof row.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(row.url)
    || typeof row.token !== 'string' || !/^[a-f0-9]{48}$/.test(row.token)) throw Error('Cabin World discovery file is invalid');
  return { url:new URL(row.url).origin, token:row.token };
}

async function request(connection: Connection, path: string, opts: { body?: Row; signal?: AbortSignal } = {}) {
  const timeout = AbortSignal.timeout(5000);
  const response = await fetch(connection.url + path, {
    method:opts.body ? 'POST' : 'GET', redirect:'error',
    headers:{ authorization:'Bearer ' + connection.token, ...(opts.body ? {'content-type':'application/json'} : {}) },
    body:opts.body ? JSON.stringify(opts.body) : undefined,
    signal:opts.signal ? AbortSignal.any([timeout,opts.signal]) : timeout,
  });
  if (response.status === 401) throw Error('Cabin World bridge restarted. Reconnect before issuing another command.');
  const result = record(await response.json());
  if (!response.ok) {
    const detail = typeof result.error === 'string' ? result.error.replaceAll(connection.token,'').slice(0,280) : '';
    throw Error(detail || 'Cabin World bridge returned HTTP ' + response.status);
  }
  return result;
}

async function bridgeHealth(connection: Connection, signal?: AbortSignal) {
  const health = await request(connection,'/v1/health',{signal});
  if (health.ok !== true || typeof health.game !== 'boolean') throw Error('Cabin World bridge is unavailable');
  return { connection, game:health.game };
}

async function discoverBridge(value: Install, signal: AbortSignal) {
  return bridgeHealth(await discovery(value),signal);
}

function residentList(row: Row) {
  if (!Array.isArray(row.residents)) throw Error('Cabin World did not report its residents');
  return row.residents.flatMap(value => {
    const resident = record(value);
    return typeof resident.key === 'string' && typeof resident.name === 'string'
      ? [{ key:resident.key, name:resident.name }] : [];
  });
}

export function createCabinWorld(ports: {
  config: () => CabinConfig | undefined;
  persist: (value: CabinConfig) => void;
  bundled?: CabinRuntime;
  ensureRuntime?: (signal: AbortSignal) => Promise<void>;
  verifyRuntime?: (signal: AbortSignal) => Promise<void>;
  resourceState?: () => CabinResourceState;
  reserveScene?: () => () => void;
  changed: (active: boolean) => void;
  presented?: () => void;
  conversation?: () => CabinConversation;
  sendMessage?: (id:unknown, text:unknown) => Promise<{cursor:number}>;
  speechReport?: (report: Row) => void;
  speechCheckpoint?: (request: unknown, rows: unknown) => void;
  beforeLeave?: () => Promise<ReadonlySet<string> | undefined>;
  headless?: boolean;
  prepareBody?(signal: AbortSignal, model?: string): Promise<CabinBody | undefined>;
}) {
  let phase: CabinState['phase'] = 'idle', owner: CabinState['owner'] = null;
  let local: Install | undefined, actor: string | null = null;
  let activeConnection: Connection | undefined, commands: string[] = [];
  let worker: ChildProcess | undefined, controller: AbortController | undefined;
  let workerCleanup: Promise<void> | undefined;
  let entering: Promise<CabinState> | undefined, leaving: Promise<CabinState> | undefined;
  let heartbeat: NodeJS.Timeout | undefined, failures = 0, polling = false;
  let preparation: { controller: AbortController; task: Promise<CabinState> } | undefined;
  let prepareFailure: CabinInstallFailure | undefined;
  let residents: CabinState['residents'] = [], detail: string | null = null;
  let launchIssue: string | null = null;
  let bodyReady = false, managedBody = false, bodyPresented = false;
  let managedFigure: string | null = null;
  let rendererBody: RenderedCabinBody | undefined;
  const pendingActions = new Map<string,{ generation: string; finish: (result: CabinActionReceipt) => void }>();
  const actionReceipts = new Map<string, CabinAction>();
  const speechClips = new Set<string>();
  const speechOrders = new Set<string>();
  let speechProgress: { at: number; rows: unknown[] } | undefined;
  let revealTimer: NodeJS.Timeout | undefined;

  function selectedRuntime() {
    const cfg = ports.config();
    const bundled = ports.bundled;
    const available = bundled && (ports.ensureRuntime || existsSync(join(bundled.root,'CabinWorld.exe')));
    if (cfg?.source !== 'external' && bundled && available) {
      return { root:bundled.root, dataDir:bundled.dataDir };
    }
    return { root:cfg?.root, dataDir:undefined };
  }

  function state(): CabinState {
    const runtime = selectedRuntime();
    const resource = runtime.dataDir && ports.resourceState?.();
    const externalRoot = runtime.root && !runtime.dataDir
      ? basename(runtime.root).toLowerCase() === 'cabinworld.exe' ? dirname(runtime.root) : runtime.root : undefined;
    const externalUnavailable = !!externalRoot && CABIN_BOOT_FILES.some(file => !existsSync(join(externalRoot, file)));
    const body = phase !== 'active' ? undefined : managedBody ? confirmedBody() : {kind:'resident' as const};
    const action = body?.kind === 'figure' ? [...actionReceipts.values()].reverse().find(item => item.generation === body.generation) : undefined;
    return { configured:!!runtime.root, name:runtime.root ? basename(runtime.root) : null, bundled:!!runtime.dataDir, phase, owner, actor, residents, detail,
      preparing:!!preparation, managedAvailable:!!ports.bundled,
      canEnter:!!runtime.root && !externalUnavailable && (!resource || resource.phase === 'ready'),
      externalUnavailable,
      ...(resource ? {resources:{ ...resource, ...(prepareFailure ? {failure:prepareFailure} : {}) }} : {}),
      ...(phase === 'active' ? {tools:commands} : {}), ...(managedBody ? {presented:bodyPresented} : {}), ...(body ? {body} : {}),
      ...(action ? {action: structuredClone(action)} : {}) };
  }

  function conversationChanged() {
    if (phase !== 'active' || !bodyPresented || !worker?.connected || !ports.conversation) return;
    const {phase: chatPhase,messages} = ports.conversation();
    worker.send({type:'chat-state',phase:chatPhase,messages:messages.map(item => ({...item,text:item.text.slice(0,4000)}))}, () => {});
  }

  function confirmedBody() {
    return phase === 'active' && bodyPresented && worker?.connected ? rendererBody : undefined;
  }
  function speechFigure() {
    return confirmedBody()?.figure ?? null;
  }
  function reportSpeech(report: Row) {
    if (typeof report.id !== 'string' || !speechClips.has(report.id)) return;
    if (report.status === 'finished' || report.status === 'failed' || report.status === 'cancelled') speechClips.delete(report.id);
    ports.speechReport?.(report);
  }
  function speak(speech: SpeechOrder, actionDeadline?: number) {
    const body = confirmedBody();
    if (!body || speech.figure !== body.figure || !worker?.connected) return false;
    const order = {type:'speech-play',speech,generation:body.generation,actionDeadline};
    if (Buffer.byteLength(JSON.stringify(order)) > 256 * 1024) return false;
    speechOrders.add(speech.id);
    if (speechOrders.size > 64) speechOrders.delete(speechOrders.values().next().value!);
    for (const clip of speech.clips) if (clip) speechClips.add(clip);
    worker.send(order, error => {
      if (!error) return;
      pendingActions.get(speech.id)?.finish('unconfirmed');
      for (const id of speech.clips) if (id) reportSpeech({id,status:'failed',reason:'renderer-disconnected'});
    });
    return true;
  }
  function enqueueAction(speech: SpeechOrder): Promise<CabinActionReceipt> {
    const body = confirmedBody();
    const active = [...actionReceipts.values()].filter(actionPending).length;
    if (!body || pendingActions.size + active >= 16 || pendingActions.has(speech.id) || actionReceipts.has(speech.id)) return Promise.resolve('rejected');
    const { generation } = body;
    return new Promise(resolve => {
      const waitMs = 2200;
      const timer = setTimeout(() => finish('unconfirmed'),waitMs);
      function finish(result: CabinActionReceipt) {
        clearTimeout(timer);
        pendingActions.delete(speech.id);
        if (result === 'queued') {
          actionReceipts.set(speech.id,{id:speech.id,generation,words:speech.beats.flatMap(beat=>beat.actions),status:'queued'});
          if (actionReceipts.size > 32) {
            const oldest = [...actionReceipts.values()].find(action => !actionPending(action));
            if (oldest) actionReceipts.delete(oldest.id);
          }
        }
        resolve(result);
      }
      pendingActions.set(speech.id,{generation,finish});
      if (!speak(speech,Date.now() + waitMs)) finish('rejected');
    });
  }
  function actionPending(action: CabinAction) { return action.status === 'queued' || action.status === 'running'; }
  function actionReceipt(id: string) {
    const receipt = actionReceipts.get(id);
    return receipt ? structuredClone(receipt) : null;
  }
  function settleActions(reason: string, status: 'interrupted' | 'unconfirmed') {
    for (const request of pendingActions.values()) request.finish('unconfirmed');
    for (const action of actionReceipts.values()) if (actionPending(action)) { action.status = status; action.reason = reason; }
  }
  function takeSpeech(request: string, deadline: number) {
    if (!managedFigure || !bodyPresented || !worker?.connected) return false;
    worker.send({type:'speech-take',request,deadline}, error => {
      if (error) ports.speechCheckpoint?.(request,recoverSpeech());
    });
    return true;
  }
  function recoverSpeech() {
    if (!speechProgress || Date.now() - speechProgress.at > 2500) return [];
    return speechProgress.rows.flatMap(row => {
      if (!row || typeof row !== 'object') return [];
      const checkpoint = row as Row;
      if (typeof checkpoint.id !== 'string' || !speechOrders.has(checkpoint.id)) return [];
      const audio = checkpoint.audio === true && typeof checkpoint.clip === 'string' && speechClips.has(checkpoint.clip);
      return [{...checkpoint,audio}];
    });
  }
  function stopSpeech(reason: string, unknownOutcome = false) {
    settleActions(reason,unknownOutcome ? 'unconfirmed' : 'interrupted');
    speechProgress = undefined;
    speechOrders.clear();
    if (worker?.connected) worker.send({type:'speech-stop',reason}, () => {});
    for (const id of speechClips) reportSpeech({id,status:'cancelled',reason});
  }

  async function startWorker(target: Install, signal: AbortSignal, body?: CabinBody) {
    launchIssue = null;
    bodyReady = bodyPresented = false;
    rendererBody = undefined;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => childEnvKeys.has(key.toLowerCase())));
    // The World owns this directory even when the fork cannot run its shutdown handlers.
    const stageParent = target.bundled ? target.dataDir : target.root;
    await recoverCabinStages(stageParent);
    signal.throwIfAborted();
    const stage = body ? await createCabinStage(stageParent) : undefined;
    let child: ChildProcess;
    try {
      signal.throwIfAborted();
      child = spawn(process.execPath,[workerPath,target.root,target.dataDir,ports.headless ? '--headless' : '--graphical',
        body ? JSON.stringify(body) : '',target.bundled ? '--bundled' : '--external',stage ?? ''],{
        cwd:target.root, env:{...env,ELECTRON_RUN_AS_NODE:'1'}, stdio:['ignore','ignore','inherit','ipc'], windowsHide:true,
      });
    } catch (error) {
      await removeCabinStage(stageParent,stage);
      throw error;
    }
    workerCleanup = new Promise<void>(done => child.once('close',() => {
      if (worker === child) worker = undefined;
      void removeCabinStage(stageParent,stage).then(done,done);
    }));
    child.on('message', value => {
      if (worker !== child) return;
      if (value === 'bridge-launch-failed' || value === 'game-launch-failed') launchIssue = value;
      if (value && typeof value === 'object' && 'type' in value && value.type === 'game-exited') {
        launchIssue = 'game-exited';
        if (phase === 'active') void leave('小屋世界游戏进程意外退出。');
      }
      if (value === 'body-ready') bodyReady = true;
      if (value && typeof value === 'object' && 'type' in value && value.type === 'body-capabilities') {
        const report = value as Row;
        if (managedFigure && report.figure === managedFigure && typeof report.generation === 'string' &&
            /^[0-9a-f-]{36}$/.test(report.generation) && Array.isArray(report.words) && report.words.every(word => typeof word === 'string') &&
            (report.wordSource === 'renderer' || report.wordSource === 'manifest')) {
          if (rendererBody && rendererBody.generation !== report.generation) {
            settleActions('body-changed','interrupted');
          }
          rendererBody = {kind:'figure',figure:managedFigure,generation:report.generation,words:report.words,wordSource:report.wordSource};
        }
      }
      if (value === 'body-presented' && phase === 'active' && !bodyPresented) {
        bodyPresented = true;
        clearInterval(revealTimer);
        revealTimer = undefined;
        ports.presented?.();
      }
      if (value === 'body-lost') {
        launchIssue = 'body-lost';
        if (phase === 'active') void leave('小屋世界的角色渲染已断开。');
      }
      if (value === 'game-closed') {
        launchIssue = 'game-closed';
        if (phase === 'active') void leave();
      }
      if ((phase === 'active' || phase === 'leaving') && bodyPresented && value && typeof value === 'object' && 'type' in value) {
        const report = value as Row;
        if (value.type === 'speech-accepted' && typeof report.id === 'string') {
          const request = pendingActions.get(report.id);
          if (request && report.generation === request.generation && typeof report.accepted === 'boolean') {
            request.finish(report.accepted ? 'queued' : 'rejected');
          }
        }
        if (value.type === 'body-action' && typeof report.id === 'string') {
          const action = actionReceipts.get(report.id);
          if (action && actionPending(action) && report.generation === action.generation && report.generation === rendererBody?.generation) {
            if (report.status === 'completed' && (report.completion === 'body-event' || report.completion === 'duration')) {
              action.status = report.completion === 'body-event' ? 'completed' : 'elapsed';
              action.completion = report.completion;
            } else if (report.status === 'running' || report.status === 'failed' || report.status === 'interrupted') {
              action.status = report.status;
              if (typeof report.reason === 'string') action.reason = report.reason.slice(0,160);
            }
          }
        }
        if (value.type === 'speech-report') reportSpeech(report);
        if (value.type === 'speech-checkpoint') ports.speechCheckpoint?.(report.request, report.rows);
        if (value.type === 'speech-progress' && Array.isArray(report.rows)) {
          speechProgress = {at:Date.now(),rows:report.rows.slice(0,64)};
        }
      }
      if (phase !== 'active' || !bodyPresented || !value || typeof value !== 'object' || !('type' in value)) return;
      if (value.type === 'chat-read') conversationChanged();
      if (value.type === 'chat-send' && 'id' in value && 'text' in value && ports.sendMessage && typeof value.id === 'string') {
        const id = value.id;
        void ports.sendMessage(id,value.text).then(
          result => ({type:'chat-result',id,ok:true,cursor:result.cursor}),
          error => ({type:'chat-result',id,ok:false,error:error instanceof Error ? error.message : '消息发送失败，请重试。'}),
        ).then(result => {
          if (worker === child && child.connected) child.send(result, () => {});
        });
      }
    });
    child.once('error', () => { launchIssue = 'bridge-launch-failed'; });
    child.once('exit', () => {
      if (worker !== child) return;
      worker = undefined;
      if (phase === 'active') void leave('小屋世界的桥接进程已退出。');
    });
    return child;
  }

  async function stopWorker() {
    const child = worker, cleanup = workerCleanup;
    const timer = child && child.exitCode === null && child.signalCode === null
      ? setTimeout(() => child.kill(),7500) : undefined;
    try {
      if (child?.connected) child.send('stop', () => {});
      await cleanup;
    } finally {
      clearTimeout(timer);
      if (workerCleanup === cleanup) workerCleanup = undefined;
    }
  }

  async function connect(target: Install, signal: AbortSignal, body?: CabinBody) {
    const initial = await discoverBridge(target,signal).catch(() => null);
    signal.throwIfAborted();
    if (initial) {
      if (body) throw Error('小屋世界已由外部程序打开。关闭原窗口和桥接后，可从梦境带角色进入。');
      if (!initial.game) throw Error('The existing bridge is running. Open its Cabin World window, then enter again.');
      owner = 'external';
      return initial.connection;
    }
    owner = 'managed';
    if (worker) throw Error('小屋世界的上一次启动仍在退出，请稍后重试。');
    worker = await startWorker(target,signal,body);
    const deadline = Date.now() + 85000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (launchIssue === 'body-lost') throw Error('小屋世界的角色渲染启动失败，请检查角色能否正常预览。');
      if (launchIssue === 'game-exited') throw Error('小屋世界游戏进程在启动时意外退出。');
      if (launchIssue === 'game-closed') throw Error('小屋世界窗口在启动时关闭。');
      if (!worker || launchIssue) throw Error('小屋世界启动失败，请检查安装目录和已打开的游戏窗口。');
      const health = await discoverBridge(target,signal).catch(() => null);
      if (health?.game) return health.connection;
      await delay(220,undefined,{signal});
    }
    throw Error('小屋世界窗口未连接，已结束本次启动，可以重试。');
  }

  async function check() {
    const connection = activeConnection;
    if (!connection || phase !== 'active' || polling) return;
    polling = true;
    try {
      const online = (await bridgeHealth(connection).catch(() => null))?.game;
      if (phase === 'active' && activeConnection === connection) {
        if (online === false && owner === 'external') { await leave(); return; }
        failures = online ? 0 : failures + 1;
        if (failures >= 2) await leave('Cabin World disconnected');
      }
    } finally { polling = false; }
  }

  async function configure(directory: unknown) {
    function assertIdle() {
      if (entering || leaving || preparation || phase === 'active') throw Error('请先结束小屋世界的运行或安装。');
    }
    assertIdle();
    if (directory === null) {
      if (!ports.bundled) throw Error('梦境管理的小屋世界资源不可用。');
      ports.persist({root:ports.bundled.root,source:'managed'});
    } else {
      const target = await installation(directory);
      assertIdle();
      ports.persist({root:target.root,source:'external'});
    }
    prepareFailure = undefined;
    detail = null;
    phase = 'idle';
    return state();
  }

  function prepare(): Promise<CabinState> {
    if (preparation) return preparation.task;
    if (entering || leaving || phase === 'active') throw Error('小屋世界正在使用。');
    if (!selectedRuntime().dataDir || !ports.ensureRuntime) throw Error('请选择由梦境管理的安装来源。');
    prepareFailure = undefined;
    if (phase === 'error') { phase = 'idle'; detail = null; }
    const controller = new AbortController();
    const task = Promise.resolve().then(() => ports.ensureRuntime!(controller.signal))
      .catch(error => {
        if (!controller.signal.aborted) prepareFailure = error instanceof CabinInstallError ? error.code : 'install';
        throw error;
      })
      .finally(() => { preparation = undefined; }).then(state);
    preparation = {controller, task};
    return task;
  }

  async function cancelPreparation() {
    const operation = preparation;
    operation?.controller.abort();
    await operation?.task.catch(() => undefined);
    return state();
  }

  function enter(model?: string): Promise<CabinState> {
    if (entering) return entering;
    if (preparation) throw Error('小屋世界组件正在准备，请稍后进入。');
    if (leaving) throw Error('Cabin World is closing');
    if (phase === 'active') return Promise.resolve(state());
    const selected = state();
    if (selected.externalUnavailable) throw Error('找不到原来的小屋世界安装，请在「引擎 → 小屋世界」重新选择程序。');
    if (selected.resources && selected.resources.phase !== 'ready') {
      throw Error('请在「引擎 → 小屋世界」先安装组件。');
    }
    controller = new AbortController();
    const signal = controller.signal;
    phase = 'connecting';
    detail = null;
    entering = (async () => {
      let releaseScene: (() => void) | undefined;
      try {
        const runtime = selectedRuntime();
        if (runtime.dataDir) {
          if (ports.verifyRuntime) await ports.verifyRuntime(signal);
          else if (!ports.resourceState) await ports.ensureRuntime?.(signal);
        }
        signal.throwIfAborted();
        releaseScene = ports.reserveScene?.();
        const cfg = ports.config();
        local = await installation(runtime.root,runtime.dataDir);
        const body = await ports.prepareBody?.(signal,model);
        managedBody = !!body;
        managedFigure = body ? new URL(body.url).searchParams.get('model') : null;
        signal.throwIfAborted();
        const connection = await connect(local,signal,body);
        commands = bridgeCommands(await request(connection,'/v1/tools',{signal}));
        const list = residentList(await request(connection,'/v1/residents',{signal}));
        actor = body?.key ?? list.find(item => !local?.bundled && item.key === cfg?.actor)?.key
          ?? list.find(item => item.key === local?.resident)?.key ?? list[0]?.key ?? null;
        if (!actor) throw Error('Cabin World has no available resident');
        const readyDeadline = Date.now() + (body ? 30000 : 12000);
        for (;;) {
          if (launchIssue === 'game-exited') throw Error('小屋世界游戏进程在载入住户时意外退出。');
          if (launchIssue === 'game-closed') throw Error('小屋世界窗口在载入住户时关闭。');
          if (launchIssue || (body && !worker)) throw Error('小屋世界的角色渲染启动失败。');
          const status = await request(connection,'/v1/status?actor='+encodeURIComponent(actor),{signal}).catch(error => {
            if (signal.aborted || !body) throw error;
            return null;
          });
          if (status?.connected === true && typeof status.wallet === 'number'
            && status.position && typeof record(status.position).space === 'string' && (!body || (bodyReady && rendererBody))) break;
          if (Date.now() >= readyDeadline) throw Error(body && (!bodyReady || !rendererBody) ? '小屋世界未确认角色首帧或动作能力，可以重试。' : '小屋世界未确认住户位置，可以重试。');
          await delay(250,undefined,{signal});
        }
        signal.throwIfAborted();
        residents = body ? residentList(await request(connection,'/v1/residents',{signal})).filter(row => row.key === body.key) : list;
        if (!residents.some(item => item.key === actor)) throw Error('小屋世界未完成当前住户的登记，可以重试。');
        signal.throwIfAborted();
        activeConnection = connection;
        phase = 'active';
        failures = 0;
        heartbeat = setInterval(() => void check(),1700);
        heartbeat.unref();
        ports.changed(true);
      } catch (error) {
        if (!signal.aborted && error instanceof CabinInstallError) prepareFailure = error.code;
        await stopWorker();
        local = activeConnection = undefined;
        commands = [];
        managedBody = bodyPresented = false;
        managedFigure = null;
        owner = null;
        actor = null;
        residents = [];
        phase = signal.aborted ? 'idle' : 'error';
        detail = signal.aborted ? null : error instanceof Error ? error.message : 'Cabin World could not connect';
      } finally {
        releaseScene?.();
      }
      return state();
    })().finally(() => { entering = undefined; controller = undefined; });
    return entering;
  }

  function leave(reason: string | null = null, restore = true): Promise<CabinState> {
    if (leaving) return leaving;
    const wasActive = phase === 'active';
    controller?.abort();
    clearInterval(heartbeat);
    heartbeat = undefined;
    clearInterval(revealTimer);
    revealTimer = undefined;
    const pending = entering;
    phase = 'leaving';
    leaving = (async () => {
      if (wasActive && restore && managedFigure && bodyPresented) {
        const keep = await ports.beforeLeave?.().catch(() => undefined);
        for (const id of keep ?? []) speechClips.delete(id);
      }
      stopSpeech('scene-closed',reason !== null);
      await pending;
      await stopWorker();
      phase = reason ? 'error' : 'idle';
      detail = reason;
      owner = null;
      actor = null;
      residents = [];
      managedBody = bodyPresented = false;
      managedFigure = null;
      local = activeConnection = undefined;
      commands = [];
      if (wasActive && restore) ports.changed(false);
      return state();
    })().finally(() => { leaving = undefined; });
    return leaving;
  }

  async function setActor(key: unknown) {
    const connection = activeConnection;
    if (!local || !connection || phase !== 'active' || typeof key !== 'string') throw Error('Enter Cabin World before choosing a resident');
    if (managedBody) {
      if (key === actor) return state();
      throw Error('请在梦境工作台切换角色后再进入小屋世界。');
    }
    const list = residentList(await request(connection,'/v1/residents'));
    if (!list.some(item => item.key === key) || phase !== 'active' || activeConnection !== connection) throw Error('The resident is no longer available');
    if (!local.bundled) ports.persist({root:local.root,actor:key,source:'external'});
    residents = list;
    actor = key;
    return state();
  }

  async function refreshResidents() {
    const connection = activeConnection;
    if (!local || !connection || phase !== 'active') return state();
    const target = local;
    const list = residentList(await request(connection,'/v1/residents'));
    if (phase === 'active' && activeConnection === connection) {
      residents = managedBody ? list.filter(item => item.key === actor) : list;
      if (!list.some(item => item.key === actor)) {
        if (managedBody) return leave('小屋世界里的当前住户已移除。');
        actor = list.find(item => item.key === target.resident)?.key ?? list[0]?.key ?? null;
      }
    }
    return state();
  }

  async function run(name: string, args: Row, signal?: AbortSignal) {
    if (!activeConnection || !actor || phase !== 'active' || (managedBody && !bodyPresented)) {
      throw Error('Enter Cabin World from the scene panel first');
    }
    if (!commands.includes(name)) throw Error('当前小屋世界未提供这个功能。');
    return request(activeConnection,'/v1/tool',{signal,body:{name,arguments:cabinArguments(name,args,actor)}});
  }

  function reveal() {
    const owner = worker;
    if (phase !== 'active' || !managedBody || bodyPresented || revealTimer) return;
    if (!owner?.connected) {
      void leave('小屋世界的桥接进程已断开。');
      return;
    }
    let attempts = 0;
    const send = () => {
      if (!owner.connected || worker !== owner || ++attempts > 10) {
        void leave('小屋世界未确认窗口显示，已恢复原场景。');
        return;
      }
      owner.send('reveal-body', () => {});
    };
    revealTimer = setInterval(send,350);
    revealTimer.unref();
    send();
  }

  return { state, installationRoot: () => selectedRuntime().root, configure, prepare, cancelPreparation, enter, leave, setActor, refreshResidents, run, reveal,
    conversationChanged, speechFigure, speak, enqueueAction, actionReceipt, takeSpeech, recoverSpeech, stopSpeech };
}
