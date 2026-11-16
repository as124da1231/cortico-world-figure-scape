/** A bounded overview; a single-resource request pages through every channel. */
export function catalogPage(c,start,request) {
 const ids=request.resources;
 if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.length>3||ids.some(id=>typeof id!=='string'||!c.resources.some(r=>r.id===id))))throw Error('请选择最多三个有效资源 ID');
 const offset=Number(request.parameter_offset??0);
 if(!Number.isInteger(offset)||offset<0||offset>2048||offset>0&&ids?.length!==1)throw Error('参数分页须指定一个资源和有效偏移');
 const source=ids?[...new Set(ids)].map(id=>c.resources.find(r=>r.id===id)):c.resources.slice(start);
 const rows=[];
 for(const r of source.slice(0,ids?3:12)) {
  const {raw,parameters,...meta}=r;
  const limit=ids?16:6;
  const row={...meta,parameterCount:parameters.length,parameterOffset:offset,parameters:parameters.slice(offset,offset+limit)};
  row.nextParameterOffset=offset+row.parameters.length<parameters.length?offset+row.parameters.length:null;
  // Leave room for policy, supported words, warnings and frame metadata.
  while(row.parameters.length>1&&JSON.stringify(row).length>4200){row.parameters.pop();row.nextParameterOffset=offset+row.parameters.length;}
  if(rows.length&&JSON.stringify([...rows,row]).length>5100)break;
  rows.push(row);
 }
 return {resources:rows,total:c.resources.length,next:ids?null:start+rows.length<c.resources.length?start+rows.length:null,
  nextResourceOffset:ids&&rows.length<source.length?rows.length:null,
  truncated:c.truncated===true,warnings:(c.warnings||[]).slice(0,3).map(w=>String(w).slice(0,180)),warningCount:(c.warnings||[]).length};
}

export function confirmationReasons(c,bindings) {
 if(!bindings.length)return [];
 const reasons=[];
 for(const b of bindings){
  const r=c.resources.find(r=>r.id===b.resource);
  if(b.confidence<.7||r.classification==='appearance')reasons.push('存在不确定或外观映射');
  if(r.suggestion?.word!==b.word)reasons.push('缺少明确的语义名称对应，需要人工确认');
  if(b.overlays?.length)reasons.push('原生表情组合尚未提供整体对照，需要人工确认');
 }
 if(c.truncated)reasons.push('资源扫描已截断');
 return [...new Set(reasons)];
}
