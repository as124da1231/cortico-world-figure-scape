import AStar from '../vendor/rot-astar.js';
import { phoneRect } from './phone-layout.js';
import { createSceneFrame } from './scene-frame.js';
import { droppedInside, hitRect, sceneBounds, sceneRect, validateHouse } from '../vendor/feiyu-house/house-core.js';
import { ART, FURNITURE, POSES, pixelBox, poseFloor, targetFloor } from '../vendor/feiyu-house/house-geometry.js';
import layout from '../vendor/feiyu-house/house.json' with { type: 'json' };

const house = validateHouse(layout);
const columns = 48, rows = 24;
const targets = new Map(house.hits.filter(hit => ['door', 'center', 'chair', 'sofa', 'bed'].includes(hit.id))
  .map(hit => [hit.id, { ...hit, ...(POSES[hit.id] ? { walk: POSES[hit.id].x, poseFloor: poseFloor(hit.id, house) } : {}) }]));
const artBox = ([x, y, w, h]) => [x / ART.w, y / ART.h, w / ART.w, h / ART.h];
const furniture = [
  { id: 'chair', label: targets.get('chair').label, box: targets.get('chair').box },
  { id: 'sofa', label: targets.get('sofa').label, box: targets.get('sofa').box },
  { id: 'bed', label: targets.get('bed').label, box: targets.get('bed').box },
  { id: 'table', label: '桌子', box: artBox(FURNITURE.table.box), art: FURNITURE.table.box },
];
const foregrounds = [
  { id: 'table', image: 'table-front.png', art: FURNITURE.table.box },
  { id: 'coffee', image: 'coffee-front.png', art: FURNITURE.coffee.box },
  { id: 'bed', image: 'bed-cover.png', art: FURNITURE.cover.box },
];
const projectArt = (rect, art) => {
  const { left: x, top: y, width: w, height: h } = pixelBox(rect, art);
  return { x, y, w, h };
};
const within = (r, p) => droppedInside(p, { expanded: true, room: r });

export function createRoomSpace({ viewport, framePlacement = {} }) {
  const frame = createSceneFrame(viewport, ({ width, height }) => {
    // The original room uses a top area for its chrome. Scale the whole frame for a short work area.
    const source = sceneRect(width, Math.max(180, height), house);
    const ratio = Math.min(.9, (height - Math.min(20, height / 2)) / source.h);
    const w = source.w * ratio, h = source.h * ratio;
    return { x: (width - w) / 2, y: source.y + (source.h - h) / 2, w, h };
  }, framePlacement, { minWidth: 320 });
  const { rect } = frame;
  const project = (x, y) => { const r = rect(); return { x: r.x + x * r.w, y: r.y + y * r.h }; };
  const normalized = ({ x, y }) => { const r = rect(); return { x: (x - r.x) / r.w, y: (y - r.y) / r.h }; };
  const toCell = point => { const { x, y } = normalized(point); return [Math.floor(x * columns), Math.floor(y * rows)]; };
  const toPoint = ([x, y]) => project((x + .5) / columns, (y + .5) / rows);
  const obstacle = (f, point) => {
    const [x, y, w, h] = f.box;
    return point.x >= x && point.x <= x + w && point.y >= y + h * .36 && point.y <= y + h;
  };
  const walkable = (x, y) => {
    const point = { x: (x + .5) / columns, y: (y + .5) / rows };
    return point.x >= .045 && point.x <= .955 && point.y >= .57 && point.y <= house.floor
      && !furniture.some(item => obstacle(item, point));
  };
  function nearest(point) {
    const [cx, cy] = toCell(point);
    let result, distance = Infinity;
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const next = (x - cx) ** 2 + (y - cy) ** 2;
      if (next < distance && walkable(x, y)) { result = [x, y]; distance = next; }
    }
    return result;
  }
  const approach = hit => {
    const item = furniture.find(value => value.id === hit.id);
    const depth = item ? Math.min(.93, item.box[1] + item.box[3] + .045) : targetFloor(hit, house);
    return nearest(project(hit.walk, depth));
  };
  const pose = hit => POSES[hit.id] ? project(hit.walk, targetFloor(hit, house)) : undefined;
  function targetAt(point) {
    const r = rect();
    return ['chair', 'sofa', 'bed', 'door', 'center'].find(id => within(hitRect(r, targets.get(id).box), point));
  }
  return {
    rect, moveFrame: frame.move, resizeFrame: frame.resize,
    bounds() {
      const { width: W, height: H } = viewport();
      const area = rect();
      return sceneBounds({
        W, H, freeGround: true,
        minX: area.x + area.w * .04, maxX: area.x + area.w * .96, minY: area.y + area.h * .54,
      }, area, house);
    },
    contains(point) { return !!within(rect(), point); },
    normalize: normalized,
    restore(x, y) {
      const cell = Number.isFinite(x) && Number.isFinite(y) ? nearest(project(x, y)) : approach(targets.get('door'));
      return toPoint(cell);
    },
    drop(point) {
      const target = targetAt(point), hit = targets.get(target);
      return { point: toPoint(hit ? approach(hit) : nearest(point)), pose: hit && pose(hit), posture: POSES[target]?.act, target };
    },
    postureExit(target) { const hit = targets.get(target); return hit ? toPoint(approach(hit)) : null; },
    targetAt,
    plan(from, target, interact) {
      if (target === 'room-center') target = 'center';
      const hit = typeof target === 'string' ? targets.get(target) : null;
      const cell = hit ? approach(hit) : typeof target === 'object' && target ? toCell(target) : null;
      if (!cell || !walkable(...cell)) throw Error('target-unreachable');
      const route = [];
      const fromTarget = targetAt(from);
      const exit = ['sit', 'sleep'].includes(from.mode) && POSES[fromTarget] ? approach(targets.get(fromTarget)) : null;
      new AStar(...cell, walkable, { topology: 4 }).compute(...(exit || nearest(from)), (x, y) => route.push([x, y]));
      if (!route.length) throw Error('target-unreachable');
      const turns = route.filter((_point, index) => {
        if (index === 0 || index === route.length - 1) return true;
        const before = route[index - 1], after = route[index + 1];
        return before[0] !== after[0] && before[1] !== after[1];
      });
      return { path: turns.map(toPoint), posture: interact ? POSES[target]?.act : undefined, pose: interact && hit ? pose(hit) : undefined };
    },
    furniture() {
      const r = rect();
      return furniture.map(item => {
        if (!item.art) return { ...item, rect: hitRect(r, item.box) };
        return { ...item, rect: projectArt(r, item.art) };
      });
    },
    foregrounds: () => foregrounds.map(item => ({ ...item, rect: projectArt(rect(), item.art) })),
    snapshot: () => ({ implementation: 'room-space', status: 'mounted', targets: [...targets.keys()], rect: rect() }),
  };
}

export function createPhoneSpace({ viewport, framePlacement = {} }) {
  const frame = createSceneFrame(viewport, phoneRect, framePlacement, { minWidth: 230 });
  const { rect } = frame;
  const minRelativeX = .32, maxRelativeX = .68;
  const limitX = x => Math.min(maxRelativeX, Math.max(minRelativeX, x));
  const dialogueLine = .78;
  return {
    rect, moveFrame: frame.move, resizeFrame: frame.resize,
    bounds() {
      const { width, height } = viewport(), area = rect();
      return {
        W: width, H: height,
        minX: area.x + area.w * minRelativeX, maxX: area.x + area.w * maxRelativeX,
        floorY: area.y + area.h, freeGround: false,
      };
    },
    contains(point) { const r = rect(); return point.x >= r.x && point.x < r.x + r.w && point.y >= r.y && point.y < r.y + r.h; },
    normalize(point) { const r = rect(); return { x: limitX((point.x - r.x) / r.w), y: dialogueLine }; },
    restore(x) {
      const r = rect();
      // Old saved positions can lie outside the portrait's current movement range.
      const localX = Number.isFinite(x) && x >= minRelativeX && x <= maxRelativeX ? x : .5;
      return { x: r.x + r.w * localX, y: r.y + r.h * dialogueLine };
    },
    plan(_from, target) {
      if (!target || typeof target !== 'object') throw Error('target-unreachable');
      return { path: [this.restore(this.normalize(target).x)] };
    },
    snapshot: () => ({ implementation: 'phone-space', status: 'mounted', rect: rect(), targets: [] }),
  };
}
