import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { createWallpaperLibrary } from '../src/framework/wallpaper-library.ts';

const cleanups: string[] = [];
const dir = async () => {
  const root = await mkdtemp(join(tmpdir(), 'live2d-wallpaper-'));
  cleanups.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(root => rm(root, {recursive:true,force:true})));
});

describe('wallpaper library', () => {
  it('reuses a direct source and persists its selection and playback settings', async () => {
    const root = await dir(), catalog = join(root, 'catalog'), image = join(root, 'sunset.png');
    const library = createWallpaperLibrary(() => catalog);
    await writeFile(image, 'local data');
    const item = await library.importPath(image);
    expect(await library.importPath(image)).toEqual(item);
    expect(await library.state()).toMatchObject({items:[item],selected:null});
    await library.select(item.id);
    await expect(library.remove(item.id)).rejects.toThrow('current one');
    await library.configure({volume:3,scale:.25,fit:'contain',interactive:true});
    const reopened = createWallpaperLibrary(() => catalog);
    expect(await reopened.prepare()).toMatchObject({id:item.id,kind:'image',options:{volume:1,scale:.5,fit:'contain',interactive:true}});
    expect(await reopened.cover(item.id)).toMatchObject({file:image,size:10});
    expect(await reopened.asset(item.id,'catalog.json')).toBeNull();
    await reopened.select(null);
    await reopened.remove(item.id);
    expect(await readFile(image,'utf8')).toBe('local data');
  });

  it('retains a separate composition for each wallpaper and rejects stale edits', async () => {
    const root = await dir(), catalog = join(root,'data');
    const library = createWallpaperLibrary(() => catalog);
    const firstPath = join(root,'first.png'), secondPath = join(root,'second.png');
    await writeFile(firstPath,'first');
    await writeFile(secondPath,'second');
    const first = await library.importPath(firstPath), second = await library.importPath(secondPath);
    expect(first.composition).toEqual({placement:{x:.63,groundY:.88},revision:0});
    const placement = {x:.318,groundY:.754};
    const results = await Promise.allSettled([
      library.setComposition(first.id,placement,0),
      library.setComposition(first.id,{x:.51,groundY:.8},0),
    ]);
    expect(results[0]).toMatchObject({status:'fulfilled',value:{placement,revision:1}});
    expect(results[1]).toMatchObject({status:'rejected',reason:Error('wallpaper-placement-conflict')});
    await library.importPath(firstPath);
    const reopened = createWallpaperLibrary(() => catalog);
    expect((await reopened.prepare(first.id)).composition).toEqual({placement,revision:1});
    expect((await reopened.prepare(second.id)).composition).toEqual(second.composition);
  });

  it('keeps project and fallback paths inside the imported folder', async () => {
    const root = await dir(), project = join(root,'project'), library = createWallpaperLibrary(() => join(root,'data'));
    await mkdir(project);
    await writeFile(join(root,'escape.html'),'outside');
    await writeFile(join(project,'index.html'),'<h1>wallpaper</h1>');
    await writeFile(join(project,'preview.jpg'),'cover');
    await writeFile(join(project,'wallpaper.mp4'),'video');
    await writeFile(join(project,'project.json'),JSON.stringify({type:'web',file:'../escape.html',title:'Leaves',preview:'preview.jpg'}));
    const item = await library.importPath(project);
    expect(await library.prepare(item.id)).toMatchObject({kind:'web',title:'Leaves',
      media:expect.stringContaining('/index.html'),video:expect.stringContaining('/wallpaper.mp4'),poster:expect.stringContaining('/preview.jpg')});
    expect(await library.asset(item.id,'../escape.html')).toBeNull();
    expect(await library.asset(item.id,'project.json')).toEqual({json:{type:'web',file:'index.html',title:'Leaves',preview:'preview.jpg'}});
  });

  it('imports browser project folders deterministically and discovers Steam downloads without duplicates', async () => {
    const root = await dir(), library = createWallpaperLibrary(() => join(root,'data'));
    const enc = new TextEncoder();
    const bytes = zipSync({
      'project/project.json':enc.encode('{"type":"scene","file":"scene.json","title":"Night sky"}'),
      'project/scene.json':enc.encode('{"objects":[]}'),
    });
    const first = await library.importUpload('zip',bytes);
    expect(await library.importUpload('zip',bytes)).toEqual(first);
    const steamFolder = join(root,'SteamLibrary','steamapps','workshop','content','431960','847');
    await mkdir(steamFolder,{recursive:true});
    await writeFile(join(steamFolder,'project.json'),'{"type":"video","file":"snow.webm"}');
    await writeFile(join(steamFolder,'snow.webm'),'snow');
    expect(await library.scan(join(root,'SteamLibrary'))).toEqual({found:1,added:1,skipped:0});
    expect(await library.scan(join(root,'SteamLibrary'))).toEqual({found:1,added:0,skipped:0});
    expect((await library.state()).items).toHaveLength(2);
  });
});

