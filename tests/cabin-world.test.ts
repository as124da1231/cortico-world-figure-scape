import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { createCabinWorld, type CabinConfig } from '../src/framework/cabin-world.ts';

function catalog(...names: string[]) {
  return {tools:names.map(name => ({type:'function',function:{name}}))};
}

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
