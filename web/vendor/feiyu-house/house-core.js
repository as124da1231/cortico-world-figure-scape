export function sceneRect(W, H, config) {
  const ratio = config.canvas.w / config.canvas.h;
  const w = Math.max(1, Math.min(W - 48, Math.max(1, H - 112) * ratio));
  const h = w / ratio;
  return { x: (W - w) / 2, y: Math.max(76, (H - h + 52) / 2), w, h };
}
export function sceneBounds(base, rect, config) {
  return { ...base, floorY: rect.y + rect.h * config.floor, S: Math.max(.14, Math.min(1.5, rect.h * .27 / 244)) };
}
export function hitRect(rect, box) {
  return { x: rect.x + box[0] * rect.w, y: rect.y + box[1] * rect.h, w: box[2] * rect.w, h: box[3] * rect.h };
}
export function droppedInside(point,{expanded,room,portal}) {
  if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y))return null;
  const within=r=>r&&point.x>=r.x&&point.x<=r.x+r.w&&point.y>=r.y&&point.y<=r.y+r.h;
  return !!within(expanded?room:portal);
}
export function validateHouse(c) {
  if (!c || c.version !== 1 || !Number.isFinite(c.canvas?.w) || !Number.isFinite(c.canvas?.h) || c.canvas.w <= 0 || c.canvas.h <= 0 || !Number.isFinite(c.floor) || c.floor < .5 || c.floor > 1 || !Array.isArray(c.hits) || c.hits.length < 7 || c.hits.length > 12) throw new Error('住宅布局格式不正确');
  const ids = new Set();
  for (const h of c.hits) {
    if (h.poseFloor !== undefined && (!Number.isFinite(h.poseFloor) || h.poseFloor < (h.id==='bed'?.55:.6) || h.poseFloor > c.floor)) throw new Error('家具落脚位置不正确');
    if (!['door','fridge','bowl','sofa','window','bed','lamp','chair','record','rug','board','center'].includes(h.id) || ids.has(h.id) || typeof h.label !== 'string' || !Array.isArray(h.box) || h.box.length !== 4 || !h.box.every(n => Number.isFinite(n) && n >= 0 && n <= 1) || h.box[0]+h.box[2] > 1 || h.box[1]+h.box[3] > 1 || !Number.isFinite(h.walk) || h.walk < 0 || h.walk > 1 || !['bow','look','eat','sit','sleep','happy','dance','stand'].includes(h.act) || typeof h.say !== 'string' || !Number.isFinite(h.cool) || h.cool < 0) throw new Error('住宅互动点格式不正确');
    ids.add(h.id);
  }
  for (const name of ['interior','exterior']) if (c.assets?.[name] !== `/api/house/assets/${name}.png`) throw new Error('住宅图片地址不正确');
  return c;
}
