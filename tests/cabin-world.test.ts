import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { createCabinWorld, type CabinConfig } from '../src/framework/cabin-world.ts';
import { CabinInstallError } from '../src/framework/cabin-bundle.ts';
import { createCabinStage, recoverCabinStages, removeCabinStage } from '../host/cabin-stage.mjs';

function catalog(...names: string[]) {
  return {tools:names.map(name => ({type:'function',function:{name}}))};
}

test('cleans the owned launch directory without following a junction or touching another install', async () => {
  const root = await mkdtemp(join(tmpdir(),'figure-cabin-stage-'));
  try {
    const current = join(root,'current'), other = join(root,'other');
    const stage = await createCabinStage(current);
    const otherStage = await createCabinStage(other);
    const file = join(otherStage,'fixture.txt');
    await writeFile(file,'keep');
    const junction = join(current,'.figure-scape-linked');
    await symlink(otherStage,junction,process.platform === 'win32' ? 'junction' : 'dir');

    await removeCabinStage(current,otherStage);
    await removeCabinStage(current,junction);
    await removeCabinStage(current,stage);
    await removeCabinStage(current,stage);

    await expect(stat(stage)).rejects.toMatchObject({code:'ENOENT'});
    await expect(readFile(file,'utf8')).resolves.toBe('keep');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('recovers a launch directory only after both recorded processes have exited', async () => {
  const root = await mkdtemp(join(tmpdir(),'figure-cabin-orphans-'));
  try {
    const live = await createCabinStage(root);
    const closing = await createCabinStage(root);
    const orphan = await createCabinStage(root);
    const unknown = await mkdtemp(join(root,'.figure-scape-'));
    const missingPid = '2147483647';
    await Promise.all([
      writeFile(join(closing,'owner.pid'),missingPid),
      writeFile(join(closing,'bridge.pid'),String(process.pid)),
      writeFile(join(orphan,'owner.pid'),missingPid),
      writeFile(join(orphan,'bridge.pid'),missingPid),
    ]);

    await recoverCabinStages(root);

    await expect(stat(orphan)).rejects.toMatchObject({code:'ENOENT'});
    for (const directory of [live,closing,unknown]) expect((await stat(directory)).isDirectory()).toBe(true);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('shares and cancels engine preparation without opening a scene', async () => {
  let ensureCount = 0;
  const world = createCabinWorld({
    config:() => undefined, persist:() => {}, changed:() => { throw Error('Engine preparation opened a scene'); },
    bundled:{root:'runtime',dataDir:'save'},
    ensureRuntime:signal => new Promise<void>((_resolve, reject) => {
      ensureCount++;
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
      if (signal.aborted) reject(signal.reason);
    }),
  });
  const first = world.prepare();
  expect(world.prepare()).toBe(first);
  expect(world.state()).toMatchObject({phase:'idle',preparing:true});
  expect(() => world.enter()).toThrow('组件正在准备');
  await expect(world.configure(null)).rejects.toThrow('先结束');
  const cancelled = world.cancelPreparation();
  await expect(first).rejects.toMatchObject({name:'AbortError'});
  await expect(cancelled).resolves.toMatchObject({phase:'idle',preparing:false});
  expect(ensureCount).toBe(1);
});

test('keeps a preparation failure in shared state and clears it on retry or source change', async () => {
  let ready = false, fail = true;
  const world = createCabinWorld({
    config:() => undefined, persist:() => {}, changed:() => {},
    bundled:{root:'runtime', dataDir:'save'},
    resourceState:() => ({phase:ready ? 'ready' : 'needed', done:0, total:42}),
    ensureRuntime:async () => {
      if (fail) throw new CabinInstallError('network','Connection lost');
      ready = true;
    },
  });
  expect(() => world.enter()).toThrow('先安装组件');
  await expect(world.prepare()).rejects.toThrow('Connection lost');
  expect(world.state()).toMatchObject({canEnter:false, resources:{failure:'network'}});
  await world.configure(null);
  expect(world.state().resources?.failure).toBeUndefined();
  await expect(world.prepare()).rejects.toThrow('Connection lost');
  fail = false;
  await expect(world.prepare()).resolves.toMatchObject({canEnter:true, resources:{phase:'ready'}});
  expect(world.state().resources?.failure).toBeUndefined();
});

test('switches an external installation back to managed under the host’s partial config updates', async () => {
  const config: CabinConfig = { root:'D:/old', source:'external', actor:'favorite' };
  const world = createCabinWorld({
    config:() => config, persist:value => { Object.assign(config, value); }, changed:() => {},
    bundled:{root:'managed',dataDir:'save'},
    resourceState:() => ({phase:'ready',done:42,total:42}), ensureRuntime:async () => {},
  });
  await expect(world.configure(null)).resolves.toMatchObject({bundled:true, canEnter:true});
  expect(config).toEqual({root:'managed',source:'managed',actor:'favorite'});
});

test('verifies managed runtime before launching and reports the same repair state to all callers', async () => {
  let damaged = false;
  const world = createCabinWorld({
    config:() => undefined, persist:() => {}, changed:() => {},
    bundled:{root:'managed',dataDir:'save'},
    resourceState:() => damaged ? {phase:'needed',repair:true,done:0,total:42} : {phase:'ready',done:42,total:42},
    verifyRuntime:async () => { damaged = true; throw new CabinInstallError('integrity','Install is damaged'); },
    ensureRuntime:async () => { damaged = false; },
    prepareBody:async () => { throw Error('Invalid runtime started a body'); },
  });
  await expect(world.enter()).resolves.toMatchObject({phase:'error',canEnter:false,resources:{repair:true,failure:'integrity'}});
  await expect(world.prepare()).resolves.toMatchObject({phase:'idle',canEnter:true,resources:{phase:'ready'}});
});

test('waits for the resident, binds every action to the selected actor and detaches an existing bridge', async () => {
  const root = await mkdtemp(join(tmpdir(),'figure-cabin-'));
  await mkdir(join(root,'bridge'));
  await mkdir(join(root,'data'));
  await Promise.all([
    writeFile(join(root,'CabinWorld.exe'),''),
    writeFile(join(root,'bridge','bridge.mjs'),''),
    writeFile(join(root,'bridge','bridge.config.json'),JSON.stringify({resident:'first'})),
  ]);
  const token = 'a'.repeat(48), changes: boolean[] = [];
  const sent: unknown[] = [];
  let statusReads = 0;
  let liveCatalog = catalog('cabin_status','cabin_residents','cabin_go');
  const residents = [{key:'first',name:'First'},{key:'second',name:'Second'}];
  const bridge = createServer(async (req,res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const reply = (value: unknown, status = 200) =>
      res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(value));
    if (path === '/v1/health') return reply({ok:true,game:true});
    if (req.headers.authorization !== 'Bearer '+token) return reply({error:'unauthorized'},401);
    if (path === '/v1/tools') return reply(liveCatalog);
    if (path === '/v1/residents') return reply({residents});
    if (path === '/v1/status') return reply({connected:true,wallet:++statusReads > 1 ? 30 : null,position:{space:'park'}});
    let text = '';
    for await (const chunk of req) text += chunk;
    sent.push(JSON.parse(text));
    return reply({taskId:'walk-1',status:'running'});
  });
  await new Promise<void>(done => bridge.listen(0,'127.0.0.1', done));
  const address = bridge.address();
  if (!address || typeof address === 'string') throw Error('Mock bridge has no port');
  await writeFile(join(root,'data','bridge.json'),JSON.stringify({url:'http://127.0.0.1:'+address.port,token}));
  let config: CabinConfig | undefined;
  let bodyPreparations = 0;
  const cabin = createCabinWorld({config:()=>config,persist:value=>{config=value;},changed:value=>changes.push(value),
    prepareBody:async () => { bodyPreparations++; return undefined; }});
  const toolFile = join(root,'bridge','openai-tools.json');
  try {
    await writeFile(toolFile,JSON.stringify(catalog('cabin_status','cabin_go')));
    await expect(cabin.configure(join(root,'CabinWorld.exe'))).rejects.toThrow('缺少住户接口');
    expect(config).toBeUndefined();
    config = {root};
    await expect(cabin.enter()).resolves.toMatchObject({phase:'error',actor:null,detail:expect.stringContaining('缺少住户接口')});
    expect(bodyPreparations).toBe(0);
    await writeFile(toolFile,JSON.stringify(catalog('cabin_status','cabin_residents','cabin_go','cabin_stop')));
    await cabin.configure(join(root,'CabinWorld.exe'));
    const usable = liveCatalog;
    liveCatalog = catalog('cabin_status','cabin_go');
    await expect(cabin.enter()).resolves.toMatchObject({phase:'error',owner:null,actor:null});
    expect(changes).toEqual([]);
    liveCatalog = usable;
    const ready = await cabin.enter();
    expect(ready).toMatchObject({owner:'external',phase:'active',actor:'first'});
    expect(statusReads).toBe(2);
    expect(JSON.stringify(ready)).not.toContain(token);
    expect(ready.tools).toEqual(expect.arrayContaining(['cabin_status','cabin_residents','cabin_go']));
    expect(ready.tools).not.toContain('cabin_stop');
    await expect(cabin.run('cabin_stop',{})).rejects.toThrow('未提供');
    await writeFile(join(root,'data','bridge.json'),JSON.stringify({url:'http://127.0.0.1:1',token:'b'.repeat(48)}));
    await cabin.setActor('second');
    await expect(cabin.run('cabin_go',{place:'park',actor:'first',waitMs:1000})).resolves.toMatchObject({status:'running'});
    expect(sent).toEqual([{name:'cabin_go',arguments:{place:'park',actor:'second',waitMs:0}}]);
    await expect(cabin.leave()).resolves.toMatchObject({phase:'idle',owner:null});
    expect(bridge.listening).toBe(true);
    expect(changes).toEqual([true,false]);
  } finally {
    await cabin.leave(null,false);
    bridge.closeAllConnections();
    await new Promise<void>(done => bridge.close(() => done()));
    await rm(root,{recursive:true,force:true});
  }
});
