/** Coordinates walks through a scene's waypoints using the existing body's locomotion. */
export function createSceneMovement({ current, body, receipt }) {
  let active = null, sequence = 0, recent = null, seatedAt = null;
  const position = () => body.body?.layout;
  function finish(status, reason) {
    const order = active;
    if (!order) return;
    active = null;
    const point = position();
    recent = { id: order.id, status, ...(reason ? { reason } : {}) };
    receipt({ t: 'scene-result', ...recent });
    if (order.tool) receipt({ t: status === 'completed' ? 'arrived' : 'interrupted', walkId: order.id,
      ...(point ? current().normalize(point) : { x: .5 }), by: reason });
  }
  function next() {
    const order = active;
    if (!order) return;
    const point = order.path.shift();
    if (!point) {
      if (order.pose) body.body.place(order.pose.x, position()?.facing, order.pose.y, true);
      if (order.posture) {
        order.awaitingPosture = true;
        body.body.do(order.posture);
      } else finish('completed');
      return;
    }
    order.segment = 'scene-waypoint-' + ++sequence;
    body.body.walk(point.x, order.run, order.segment, point.y);
  }
  function cancel(reason, id) {
    if (!active || id && id !== active.id) return false;
    const segment = active.segment;
    finish('cancelled', reason);
    body.body?.stopWalk(segment);
    return true;
  }
  return {
    start(command) {
      const scene = current(), figure = body.body, from = position();
      if (!scene.plan || !figure || !from) throw Error('scene-unavailable');
      const { path, posture, pose } = scene.plan(from, command.target, command.interact);
      if (posture && !figure.supportsWord?.(posture)) throw Error('posture-unsupported');
      cancel('replaced');
      active = { ...command, path, posture, pose, segment: null, elapsed: 0 };
      if (from.mode === 'sit' || from.mode === 'sleep') {
        const exit = scene.postureExit?.(seatedAt);
        figure.do('stand');
        if (exit) figure.place(exit.x, from.facing, exit.y, true);
      }
      seatedAt = null;
      next();
    },
    event(kind, detail) {
      if (kind === 'mode' && active?.awaitingPosture && detail?.mode === active.posture) {
        seatedAt = active.target;
        finish('completed');
        return false;
      }
      if (!String(detail?.walkId ?? '').startsWith('scene-waypoint-')) return false;
      if (detail.walkId === active?.segment) {
        if (kind === 'arrived') next();
        if (kind === 'interrupted') finish('failed', detail.by ?? 'interrupted');
      }
      return true;
    },
    tick(dt) {
      if (!active) return;
      if (active.awaitingPosture) {
        active.postureWait = (active.postureWait ?? 0) + dt;
        if (position()?.mode === active.posture) { seatedAt = active.target; finish('completed'); }
        else if (active.postureWait > 2) finish('failed', 'posture-not-applied');
      } else if ((active.elapsed += dt) > 30) cancel('timed-out');
    },
    cancel,
    reset(reason) { cancel(reason); seatedAt = null; },
    drop(point) {
      if (!current().drop || !body.body) return false;
      cancel('dragged');
      const target = current().drop(point);
      const posture = target.posture && body.body.supportsWord?.(target.posture);
      const landing = posture && target.pose ? target.pose : target.point;
      body.body.place(landing.x, position()?.facing, landing.y, true);
      seatedAt = posture ? target.target : null;
      if (posture) body.body.do(target.posture);
      return true;
    },
    snapshot: () => ({ active: active && { id: active.id, target: active.target, status: 'running' }, recent,
      position: position() ? current().normalize(position()) : null,
      posture: ['sit', 'sleep'].includes(position()?.mode) ? { mode: position().mode, target: seatedAt } : null }),
  };
}
