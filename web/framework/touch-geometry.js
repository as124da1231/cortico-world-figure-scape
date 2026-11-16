/** DSH Superpet's default height bands in normalized model coordinates. */
export const TOUCH_REGION_CUTS = Object.freeze([.32, .71]);
export const TOUCH_REGIONS = Object.freeze({ head: ['头部', 'head'], body: ['躯干', 'torso'], legs: ['腿部', 'legs'] });
export const TOUCH_GESTURES = Object.freeze(['poke', 'pet', 'drop', 'shake']);
const coordinate = value => Number.isFinite(value) && value >= 0 && value <= 1;
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
const resourceId = value => typeof value === 'string' && /^(motion|expr)-[a-f0-9]{16}$/.test(value);
const pt = value => {
  if (!value || !coordinate(value.x) || !coordinate(value.y)) throw Error('触碰区域坐标超出模型画布');
  return { x: value.x, y: value.y };
};
export function readTouchRegion(value) {
  return typeof value === 'string' && Object.hasOwn(TOUCH_REGIONS, value) ? value : undefined;
}
export function touchRegion(bounds, y) {
  if (!bounds || !(bounds.h > 0) || !Number.isFinite(y) || !Number.isFinite(bounds.y)) return undefined;
  const position = (y - bounds.y) / bounds.h;
  return position < TOUCH_REGION_CUTS[0] ? 'head' : position < TOUCH_REGION_CUTS[1] ? 'body' : 'legs';
}
export function readTouchProfile(value) {
  if (!value || !Array.isArray(value.areas) || value.areas.length > 27
      || value.areas.filter(area => !readTouchRegion(area?.id)).length > 24
      || !Array.isArray(value.rules) || value.rules.length > 96) throw Error('触碰配置无效');
  const ids = new Set(['all']);
  const areas = value.areas.map(area => {
    if (!area || !identifier(area.id) || ids.has(area.id) || typeof area.name !== 'string' || !area.name.trim() || area.name.length > 40) throw Error('触碰区域名称或编号无效');
    ids.add(area.id);
    let shape;
    if (area.shape?.kind === 'ellipse') {
      const center = pt(area.shape.center), radius = pt(area.shape.radius);
      if (radius.x < .005 || radius.y < .005) throw Error('椭圆触碰区过小');
      shape = { kind: 'ellipse', center, radius };
    } else if (area.shape?.kind === 'polygon' && Array.isArray(area.shape.points) && area.shape.points.length >= 3 && area.shape.points.length <= 32) {
      const points = area.shape.points.map(pt);
      const signedArea = points.reduce((sum, point, i) => {
        const next = points[(i + 1) % points.length];
        return sum + point.x * next.y - point.y * next.x;
      }, 0);
      if (Math.abs(signedArea) < .0001) throw Error('多边形触碰区没有有效面积');
      shape = { kind: 'polygon', points };
    } else throw Error('请选择有效的椭圆或多边形');
    return { id: area.id, name: area.name.trim(), shape };
  });
  for (const id of Object.keys(TOUCH_REGIONS)) ids.add(id);
  const seen = new Set();
  const rules = value.rules.map(rule => {
    if (!rule || !TOUCH_GESTURES.includes(rule.gesture) || !ids.has(rule.area)
        || (rule.gesture === 'drop' || rule.gesture === 'shake') && rule.area !== 'all'
        || !['inherit', 'auto', 'default', 'action', 'none'].includes(rule.reaction)
        || !['local', 'next', 'inherit'].includes(rule.send)) throw Error('触发规则无效');
    const key = rule.gesture + ':' + rule.area;
    if (seen.has(key)) throw Error('触发规则重复');
    seen.add(key);
    const record = { gesture: rule.gesture, area: rule.area, reaction: rule.reaction, send: rule.send };
    if (rule.note !== undefined) {
      if (typeof rule.note !== 'string' || rule.note.length > 160) throw Error('触碰说明最多 160 字');
      if (rule.note.trim()) record.note = rule.note.trim();
    }
    if (rule.reaction === 'action') {
      const action = rule.action;
      if (action?.word && identifier(action.word)) record.action = { word: action.word };
      else if (resourceId(action?.resource) && (action.overlays === undefined || Array.isArray(action.overlays)
        && action.overlays.length <= 7 && action.overlays.every(resourceId)
        && new Set([action.resource, ...action.overlays]).size === action.overlays.length + 1)) {
        if (action.release !== undefined && !resourceId(action.release)) throw Error('触碰反应的复位资源无效');
        record.action = { resource: action.resource, overlays: action.overlays ?? [], ...(action.release ? {release:action.release} : {}) };
      } else throw Error('请为触碰反应选择动作或表情');
    }
    return record;
  });
  const areaNotes = {};
  if (value.areaNotes !== undefined) {
    if (!value.areaNotes || typeof value.areaNotes !== 'object' || Array.isArray(value.areaNotes)) throw Error('部位说明无效');
    for (const [id, note] of Object.entries(value.areaNotes)) {
      if (id === 'all' || !ids.has(id) || typeof note !== 'string' || note.length > 160) throw Error('部位说明无效');
      if (note.trim()) areaNotes[id] = note.trim();
    }
  }
  return { areas, rules, ...(Object.keys(areaNotes).length ? { areaNotes } : {}) };
}

const LIMITS = [0, ...TOUCH_REGION_CUTS, 1];
const DEFAULT_AREAS = Object.entries(TOUCH_REGIONS).map(([id, [name]], index) => {
  const top = LIMITS[index], bottom = LIMITS[index + 1];
  return { id, name, shape: touchRectangle({ left:0, top, right:1, bottom }) };
});

export function touchRectangle({ left, top, right, bottom }) {
  return { kind: 'polygon', points: [
    { x:left, y:top }, { x:right, y:top }, { x:right, y:bottom }, { x:left, y:bottom },
  ] };
}

export function touchShapeFromDrag(tool, start, end) {
  if ((tool !== 'rectangle' && tool !== 'ellipse') || !start || !end) return undefined;
  const left = Math.min(start.x, end.x), top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x), bottom = Math.max(start.y, end.y);
  if (right - left < .01 || bottom - top < .01) return undefined;
  if (tool === 'rectangle') return touchRectangle({ left, top, right, bottom });
  return { kind:'ellipse', center:{ x:(left+right)/2, y:(top+bottom)/2 }, radius:{ x:(right-left)/2, y:(bottom-top)/2 } };
}

export function resolvedTouchAreas(areas = []) {
  return [...areas, ...DEFAULT_AREAS.filter(area => !areas.some(saved => saved.id === area.id))];
}

// The same ellipse outline is used for collision, hit testing and drawing.
export function touchShapeVertices(shape) {
  if (shape.kind === 'polygon') return shape.points;
  return Array.from({ length: 64 }, (_, i) => {
    const angle = i * Math.PI / 32;
    return { x: shape.center.x + shape.radius.x * Math.cos(angle), y: shape.center.y + shape.radius.y * Math.sin(angle) };
  });
}

const EPS = 1e-9;
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const edges = points => points.map((a, i) => [a, points[(i + 1) % points.length]]);
const onEdge = (a, b, p) => Math.abs(cross(a, b, p)) < EPS
  && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS
  && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;
const orientation = points => Math.sign(edges(points).reduce((sum, [a, b]) => sum + a.x * b.y - b.x * a.y, 0));
const opposite = (a, b) => a > EPS && b < -EPS || b > EPS && a < -EPS;

function containsPoint(points, point, boundary) {
  let inside = false;
  for (const [a, b] of edges(points)) {
    if (onEdge(a, b, point)) return boundary;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < a.x + (b.x - a.x) * (point.y - a.y) / (b.y - a.y)) inside = !inside;
  }
  return inside;
}

export function pointInTouchShape(shape, point) {
  return containsPoint(touchShapeVertices(shape), point, true);
}

function outlineEnters(a, b) {
  const otherEdges = edges(b), winding = orientation(a) * orientation(b);
  return edges(a).some(([p, q]) => {
    if (containsPoint(b, p, false)) return true;
    const dx = q.x - p.x, dy = q.y - p.y, length = dx * dx + dy * dy;
    if (length < EPS * EPS) return false;
    const stops = [0, 1];
    for (const [r, s] of otherEdges) {
      const cr = cross(p, q, r), cs = cross(p, q, s);
      if (opposite(cr, cs) && opposite(cross(r, s, p), cross(r, s, q))) return true;
      const at = point => ((point.x - p.x) * dx + (point.y - p.y) * dy) / length;
      if (onEdge(p, q, r)) stops.push(at(r));
      if (Math.abs(cr) < EPS && Math.abs(cs) < EPS) {
        const rAt = at(r), sAt = at(s);
        // Same inward side along a shared edge means the interiors overlap.
        if (winding * (sAt - rAt) > EPS && Math.min(1, Math.max(rAt, sAt)) - Math.max(0, Math.min(rAt, sAt)) > EPS) return true;
      }
    }
    stops.sort((left, right) => left - right);
    return stops.some((end, i) => {
      if (i === 0 || end - stops[i - 1] <= EPS) return false;
      const middle = (end + stops[i - 1]) / 2;
      return containsPoint(b, { x: p.x + dx * middle, y: p.y + dy * middle }, false);
    });
  });
}

function footprintsOverlap(a, b) {
  const left = touchShapeVertices(a), right = touchShapeVertices(b);
  for (const axis of ['x', 'y']) {
    const first = left.map(p => p[axis]), second = right.map(p => p[axis]);
    if (Math.min(Math.max(...first), Math.max(...second)) - Math.max(Math.min(...first), Math.min(...second)) <= EPS) return false;
  }
  return outlineEnters(left, right) || outlineEnters(right, left);
}

export function touchAreaConflict(areas, previous = [], only) {
  const oldShapes = new Map(resolvedTouchAreas(previous).map(area => [area.id, JSON.stringify(area.shape)]));
  const current = resolvedTouchAreas(areas);
  for (const [index, area] of current.entries()) for (const other of current.slice(index + 1)) {
    if (only && area.id !== only && other.id !== only) continue;
    // Existing saved overlaps remain readable while the user fixes them.
    if (!only && oldShapes.get(area.id) === JSON.stringify(area.shape) && oldShapes.get(other.id) === JSON.stringify(other.shape)) continue;
    if (footprintsOverlap(area.shape, other.shape)) return [area, other];
  }
}

export function assertTouchOutline(shape) {
  if (shape.kind !== 'polygon') return;
  const lines = edges(shape.points);
  for (const [i, [start, end]] of lines.entries()) {
    if (Math.hypot(end.x - start.x, end.y - start.y) <= EPS) throw Error('顶点重合，请调整多边形');
    for (let j = i + 2; j < lines.length; j++) {
      if (i === 0 && j === lines.length - 1) continue;
      const [a, b] = lines[j];
      if (onEdge(start, end, a) || onEdge(start, end, b) || onEdge(a, b, start) || onEdge(a, b, end)
        || opposite(cross(start, end, a), cross(start, end, b)) && opposite(cross(a, b, start), cross(a, b, end))) {
        throw Error('多边形的边不能交叉');
      }
    }
  }
}

export function assertTouchAreaChange(areas, previous = []) {
  const oldShapes = new Map(resolvedTouchAreas(previous).map(area => [area.id, JSON.stringify(area.shape)]));
  for (const area of areas) if (oldShapes.get(area.id) !== JSON.stringify(area.shape)) assertTouchOutline(area.shape);
  const conflict = touchAreaConflict(areas, previous);
  if (conflict) throw Error('触碰区域重叠：' + conflict.map(area => area.name).join(' / '));
}
export function touchLocal(frame, point) {
  if (!frame) return undefined;
  const dx = point.x - frame.origin.x, dy = point.y - frame.origin.y;
  const det = frame.x.x * frame.y.y - frame.x.y * frame.y.x;
  if (!Number.isFinite(det) || Math.abs(det) < .00001) return undefined;
  return { x: (dx * frame.y.y - dy * frame.y.x) / det, y: (dy * frame.x.x - dx * frame.x.y) / det };
}
export function touchScreen(frame, point) {
  return { x: frame.origin.x + frame.x.x * point.x + frame.y.x * point.y, y: frame.origin.y + frame.x.y * point.x + frame.y.y * point.y };
}
export function touchArea(profile, frame, point) {
  const local = touchLocal(frame, point);
  return local && profile?.areas.find(area => pointInTouchShape(area.shape, local));
}

export function touchRegionAt(profile, frame, bounds, point) {
  const local = touchLocal(frame, point);
  const authored = local && profile?.areas.find(area => pointInTouchShape(area.shape, local));
  if (authored) return authored.id;
  if (local && !(coordinate(local.x) && coordinate(local.y))) return undefined;
  const region = local ? touchRegion({ y: 0, h: 1 }, local.y) : touchRegion(bounds, point.y);
  return profile?.areas.some(area => area.id === region) ? undefined : region;
}
// The author's exact group or resource label can designate an automatic reaction.
const defaultTouchNames = {
  'poke:head':['taphead','headtap','pokehead','headpoke','touchhead','戳头','戳头部','点击头部','触碰头部','頭タップ'],
  'poke:body':['tapbody','bodytap','pokebody','bodypoke','touchbody','tap','poke','戳身体','戳躯干','点击身体','体タップ'],
  'poke:legs':['tapleg','taplegs','legstap','pokeleg','pokelegs','touchlegs','tapfeet','戳腿','戳脚','点击腿部','足タップ'],
  'pet:all':['pet','pat','stroke','petting','抚摸','摸摸'],
  'drop:all':['drop','putdown','land','放下','落地'],
  'shake:all':['shake','摇晃'],
};
export function touchSuggestion(resources, gesture, area) {
  const names = defaultTouchNames[gesture+':'+area] ?? defaultTouchNames[gesture+':all'];
  if (!names) return undefined;
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{Letter}\p{Number}]/gu,'');
  const available = resources?.find(item => item && ['gesture','expression'].includes(item.classification)
    && [item.group,item.title].some(label=>names.includes(normalize(label))));
  return available ? { resource:available.id } : undefined;
}

export function touchRule(profile, gesture, area) {
  const own = profile?.rules.find(rule => rule.gesture === gesture && rule.area === area);
  const fallback = profile?.rules.find(rule => rule.gesture === gesture && rule.area === 'all');
  const rule = own ?? fallback;
  if (rule?.reaction !== 'inherit') return rule;
  return { ...rule, reaction: fallback && fallback !== rule && fallback.reaction !== 'inherit' ? fallback.reaction : 'auto',
    ...(fallback?.reaction === 'action' && fallback.action ? { action:fallback.action } : {}) };
}
