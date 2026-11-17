import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { cabinFigureSources, writeCabinFigure } from '../src/framework/cabin-figures.ts';
import { createFigureLibrary } from '../src/framework/figure-library.ts';
// @ts-expect-error The same frame sampler runs as a browser ES module in the figure sandbox.
import { cabinClipFrame, cabinOctant } from '../web/cabin-sprite-body.js';

describe('Cabin World pixel characters', () => {
  it('imports the original data twice to one card, retains the source and generates a cropped cover', async () => {
    const work = await mkdtemp(join(tmpdir(),'cabin-figures-'));
    try {
      const assets = join(work,'game','assets');
      const actors = join(assets,'actors');
      await mkdir(join(actors,'motion','whale'),{recursive:true});
      const png = new PNG({width:40,height:40});
      for (let y=2; y<9; y++) for (let x=3; x<8; x++) png.data[(y*40+x)*4+3] = 255;
      const configuration = {
        actors:{whale:{walk:{file:'base.png',scale:.22,cell:10,anchors:Array.from({length:16},()=>[5,9])}}},
      };
      const pngBytes = PNG.sync.write(png);
      await Promise.all([
        writeFile(join(assets,'world.json'),JSON.stringify(configuration)),
        writeFile(join(assets,'residents.json'),JSON.stringify({residents:[{key:'whale',name:'小鲸鱼',art:'whale'}]})),
        writeFile(join(actors,'base.png'),pngBytes),
        writeFile(join(actors,'body-language.json'),JSON.stringify({cell:10,anchor:[5,9],
          sheets:{pick_up:{frames:4,rows:4,seconds:.07,loop:false}}})),
        writeFile(join(actors,'motion','whale','pick_up.png'),pngBytes),
      ]);
      expect(await cabinFigureSources(work)).toEqual([{key:'whale',name:'小鲸鱼'}]);
      const library = createFigureLibrary(join(work,'library'));
      const importWhale = () => library.importGenerated((dir, signal)=>writeCabinFigure(work,'whale',dir,signal));
      const id = await importWhale();
      expect(await importWhale()).toBe(id);
      expect(library.list().map(pack=>pack.manifest.source)).toEqual(['cabin-world']);
      expect(library.find(id)?.manifest.vocab.find(word=>word.id==='cabin-pick')?.names.en).toEqual(['Pickup']);
      const cover = PNG.sync.read(await readFile(library.asset(id,'cover.png')!));
      expect([cover.width,cover.height]).toEqual([5,7]);
      expect(await readFile(join(actors,'base.png'))).toEqual(pngBytes);
      await expect(library.importGenerated((dir,signal)=>writeCabinFigure(work,'missing',dir,signal))).rejects.toThrow('原版外观');
      expect(library.list()).toHaveLength(1);
    } finally { await rm(work,{recursive:true,force:true}); }
  });

  it('follows the original octant order and hold-frame timing', () => {
    expect([[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1],[1,0],[1,1]].map(([x,y])=>cabinOctant(x,y))).toEqual([0,1,2,3,4,5,6,7]);
    const clip = {file:'pick_up.png',rows:4,frames:5,seconds:.08,loop:false,holdFrame:3,holdSeconds:.16};
    expect(cabinClipFrame(clip,2,.31)).toBe(13);
    expect(cabinClipFrame(clip,2,.38)).toBe(13);
    expect(cabinClipFrame(clip,2,.51)).toBe(14);
    expect(cabinClipFrame(clip,2,.57)).toBeNull();
    expect(cabinClipFrame({...clip,loop:true},0,.57)).toBe(0);
  });
});
