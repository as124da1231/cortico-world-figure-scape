import { MAX_LOOK_NAME, MAX_SAVED_LOOKS, type PetSkin, type SavedLook } from '../config.ts';

type Axis={id:string;name:Record<string,string>;options:Array<{id:string;name:Record<string,string>}>};
/** Appearance owns option selection; source model owns option definitions and channel composition. */
export function createAppearanceDomain(ports:{
 selected:()=>string; axes:()=>Axis[]; scheme:()=>string; available:()=>boolean; busy:()=>boolean;
 observed:()=>{figure:string;scheme:string}|null; persist:(scheme:string)=>void;
 looks?: () => SavedLook[]; saveLooks?: (looks: SavedLook[]) => void;
 applyLook?: (skin: PetSkin) => Promise<void>;
}) {
 function read(){
  const axes=structuredClone(ports.axes()),values=ports.scheme().split('-');
  const picks=Object.fromEntries(axes.map((axis,i)=>[axis.id,axis.options.some(o=>o.id===values[i])?values[i]:axis.options[0]?.id??'']));
  const scheme=axes.map(a=>picks[a.id]).join('-'),figure=ports.selected(),seen=ports.observed();
  return {figure,available:ports.available(),busy:ports.busy(),axes,desired:{scheme,picks},
   observed:{status:!ports.available()?'offline':seen?.figure===figure&&seen.scheme===scheme?'applied':'pending',scheme:seen?.figure===figure?seen.scheme:null}};
 }
 function selection(figure: unknown, raw: unknown) {
  if(figure!==ports.selected()||ports.busy())throw Error('The active model changed or is loading');
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Appearance picks must be an object');
  const state=read(),picks={...state.desired.picks};
  for(const [key,value]of Object.entries(raw)){
   const axis=state.axes.find(a=>a.id===key);
   if(!axis||typeof value!=='string'||!axis.options.some(o=>o.id===value))throw Error('Unknown appearance option');
   picks[key]=value;
  }
  return state.axes.map(axis => picks[axis.id]).join('-');
 }
 function presets() { return structuredClone(ports.looks?.() ?? []); }
 function savePresets(raw: unknown) {
  if (!Array.isArray(raw)) return presets();
  const seen = new Set<string>(), looks: SavedLook[] = [];
  for (const value of raw) {
   if (!value || typeof value !== 'object') continue;
   const { id, name, skin } = value as Record<string, unknown>;
   if (typeof id !== 'string' || !id || seen.has(id) || typeof name !== 'string' || !skin || typeof skin !== 'object' || Array.isArray(skin)) continue;
   seen.add(id);
   looks.push({ id, name: name.trim().slice(0, MAX_LOOK_NAME) || id, skin: skin as PetSkin });
   if (looks.length === MAX_SAVED_LOOKS) break;
  }
  ports.saveLooks?.(looks);
  return presets();
 }
 return {
  read, selection, presets, savePresets,
  select(figure: unknown, raw: unknown) {
   const scheme = selection(figure, raw);
   if (Object.keys(raw as object).length) ports.persist(scheme);
   return read();
  },
  async applyPreset(id: unknown) {
   const look = ports.looks?.().find(value => value.id === id);
   if (!look || !ports.applyLook) throw Error('The appearance preset is unavailable');
   await ports.applyLook(look.skin);
   return read();
  },
 };
}

/** Keep user picks across immutable revisions by stable axis IDs, never by shifted positions. */
export function migrateAppearanceScheme(previous:Axis[],scheme:string,next:Axis[]):string {
 const values=scheme.split('-'),picks=new Map(previous.map((axis,i)=>[axis.id,values[i]]));
 return next.map(axis=>{const value=picks.get(axis.id);return axis.options.some(option=>option.id===value)?value:axis.options[0]?.id??'';}).join('-');
}
