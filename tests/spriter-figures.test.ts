import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { PNG } from 'pngjs';
import { expect, it } from 'vitest';
import { createFigureLibrary } from '../src/framework/figure-library.ts';
import { createModelIntake } from '../src/live2d/model-intake.ts';
import { writeSpriterFigure } from '../src/framework/spriter-figures.ts';
import { characterEditorTask, live2dCharacter, packagedCharacter } from '../src/framework/character-source.ts';
import { spriterPose, type SpriterModel } from '../web/spriter-body.js';

function sprite(red: number, green: number) {
  const png = new PNG({width:8,height:12});
  for (let i = 0; i < png.data.length; i += 4) png.data.set([red,green,30,255],i);
  return PNG.sync.write(png);
}

const source = `<?xml version="1.0" encoding="UTF-8"?>
<spriter_data scml_version="1.0">
  <folder id="0">
    <file id="16" name="art/red.png" pivot_x=".5" pivot_y="0"/>
    <file id="25" name="art/green.png" pivot_x=".5" pivot_y="0"/>
  </folder>
  <entity id="0" name="Lantern">
    <character_map id="8" name="Green">
      <map folder="0" file="16" target_folder="0" target_file="25"/>
    </character_map>
    <animation id="3" name="walk" length="800">
      <mainline>
        <key id="0"><bone_ref id="4" timeline="7" key="3"/><object_ref id="2" parent="4" timeline="14" key="9"/></key>
        <key id="1" time="400"><bone_ref id="4" timeline="7" key="6"/><object_ref id="2" parent="4" timeline="14" key="9"/></key>
      </mainline>
      <timeline id="7" object_type="bone">
        <key id="3" spin="1"><bone x="0" angle="350"/></key>
        <key id="6" time="400" spin="-1"><bone x="20" angle="10"/></key>
      </timeline>
      <timeline id="14"><key id="9"><object folder="0" file="16" x="4" y="3"/></key></timeline>
    </animation>
  </entity>
</spriter_data>`;

it('imports a SCML source through folder and ZIP discovery into one Figure library snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(),'spriter-'));
  try {
    const incoming = join(root,'incoming'), entry = join(incoming,'sample.scml');
    const red = sprite(255,20), green = sprite(20,255);
    await mkdir(join(incoming,'art'),{recursive:true});
    await Promise.all([writeFile(entry,source), writeFile(join(incoming,'art','red.png'),red), writeFile(join(incoming,'art','green.png'),green)]);
    const intake = createModelIntake(join(root,'uploads'));
    const library = createFigureLibrary(join(root,'library'));
    const direct = await intake.importPaths([incoming,entry]);
    expect(direct.problems).toEqual([]);
    expect(direct.models).toMatchObject([{ kind:'spriter', title:'sample', file:'sample.scml' }]);
    const archive = await intake.importUpload('zip',zipSync({'sample.scml':Buffer.from(source),'art/red.png':red,'art/green.png':green}));
    const importCandidate = (id: string) => {
      const {dir,file} = intake.candidate(id);
      return library.importGenerated((destination,signal) => writeSpriterFigure(join(dir,file),destination,signal));
    };
    const id = await importCandidate(direct.models[0].id);
    expect(await importCandidate(archive.models[0].id)).toBe(id);
    const pack = library.find(id)!;
    expect(pack.manifest).toMatchObject({source:'spriter', name:{en:'Lantern'}, can:{walk:true}, thumb:'cover.png'});
    const character = packagedCharacter(pack);
    expect(character).toEqual({id, sourceId:id, kind:'figure-pack', origin:'spriter', tasks:['framing','bindings','wardrobe','touch','source']});
    expect(characterEditorTask(character,'wardrobe')).toBe('wardrobe');
    expect(characterEditorTask(character,'mouth')).toBe('framing');
    expect(characterEditorTask(live2dCharacter('raw','source'),'mouth')).toBe('mouth');
    expect(pack.manifest.vocab).toContainEqual(expect.objectContaining({id:'spriter-3',about:{en:'walk',zh:'walk'}}));
    expect(pack.manifest.presets.map(preset => preset.id)).toEqual(['original','map8']);
    expect(library.settings(id)).toEqual({});
    await library.save(id,{scheme:'map8'});
    expect(library.settings(id)).toEqual({scheme:'map8'});
    const model = JSON.parse(await readFile(library.asset(id,'spriter.json')!,'utf8')) as SpriterModel;
    const clip = model.clips[model.modes.walk];
    expect(spriterPose(model,clip,200)[0]).toMatchObject({sprite:0,x:expect.closeTo(14),y:expect.closeTo(3),angle:360});
    expect(spriterPose(model,clip,600,'map8')[0]).toMatchObject({sprite:1,x:14,y:3,angle:0});
    const cover = PNG.sync.read(await readFile(library.asset(id,'cover.png')!));
    expect(cover.data.some((channel,index) => index % 4 === 3 && channel === 255)).toBe(true);

    await writeFile(entry,source.replace('art/red.png','../red.png'));
    await expect(importCandidate(direct.models[0].id)).rejects.toThrow('工程目录内的 PNG');
    await writeFile(entry,source.replace('<spriter_data','<!DOCTYPE spriter_data SYSTEM "example.dtd"><spriter_data'));
    await expect(importCandidate(direct.models[0].id)).rejects.toThrow('DTD');
    expect(library.list().map(pack => pack.id)).toEqual([id]);
  } finally { await rm(root,{recursive:true,force:true}); }
});
