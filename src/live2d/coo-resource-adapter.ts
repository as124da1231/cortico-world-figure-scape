import type {DirectModelResource} from '../framework/model-contract.ts';
import type {FigurePack} from '../packs.ts';
/** Metadata projection for existing Coo tools/skin only. Never written to a
 * manifest or used to choose renderer code. Raw resources remain independent. */
export function modelForCoo(resource:DirectModelResource):FigurePack{
 return{id:resource.id,dir:'',base:`/model-assets/${resource.id}/`,rawModel:resource,
  manifest:{manifest:2,api:2,id:resource.id,version:'1',name:{zh:resource.title,en:resource.title},about:{zh:'Live2D 模型 '+resource.title,en:'Live2D model '+resource.title},
   entry:'',export:'',axes:resource.appearance,presets:[],vocab:resource.actions,sounds:{},can:{walk:resource.walk},moves:[],needs:[],voice:{pitch:1},effects:{reach:resource.effectsReach??.5}},
 };
}
