import {expect,it,vi} from 'vitest';
import {createAppearanceDomain,migrateAppearanceScheme} from '../src/framework/appearance-domain.ts';
it('changes only the selected axis using the canonical scheme and distinguishes persistence from receipt',()=>{
 let scheme='red-default',seen={figure:'model',scheme},connected=true;
 const persist=vi.fn((next:string)=>{scheme=next;});
 const domain=createAppearanceDomain({selected:()=> 'model',axes:()=>[{id:'model',name:{en:'Model'},options:[{id:'red',name:{en:'Red'}}]},{id:'outfit',name:{en:'Outfit'},options:[{id:'default',name:{en:'Default'}},{id:'hat',name:{en:'Hat'}}]}],scheme:()=>scheme,available:()=>connected,busy:()=>false,observed:()=>seen,persist});
 expect(domain.select('model',{outfit:'hat'})).toMatchObject({desired:{scheme:'red-hat'},observed:{status:'pending'}});
 seen={figure:'model',scheme:'red-hat'};expect(domain.read().observed.status).toBe('applied');
 expect(()=>domain.select('other',{outfit:'default'})).toThrow();expect(()=>domain.select('model',{outfit:'missing'})).toThrow();expect(persist).toHaveBeenCalledTimes(1);
 connected=false;expect(domain.read().observed.status).toBe('offline');
});

it('retains same-source wardrobe choices when axes are inserted or reordered',()=>{
 const axis=(id:string,ids:string[])=>({id,name:{en:id},options:ids.map(id=>({id,name:{en:id}}))});
 expect(migrateAppearanceScheme([axis('model',['red']),axis('outfit',['default','hat'])],'red-hat',[axis('model',['red']),axis('parts',['default','tail']),axis('outfit',['default','hat'])])).toBe('red-default-hat');
});
