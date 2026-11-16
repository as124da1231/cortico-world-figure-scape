/** Routes one drag across displays; a late host reply can only move the initiating body. */
export function createDisplayDrag({ scene, currentBody, followCursor, refresh, now, frame }) {
  let following = null, shifting = false, epoch = 0;

  async function move(body, ticket) {
    const target = await followCursor().catch(() => null);
    if (epoch !== ticket || currentBody() !== body) return null;
    return target;
  }

  async function settle(target) {
    await scene.waitForViewport(target, { now, frame });
    refresh();
  }

  return {
    get shifting() { return shifting; },
    cancel() { epoch++; shifting = false; },
    follow(point) {
      const body = currentBody();
      if (following || body?.layout?.mode !== 'drag' || !followCursor || scene.contains(point)) return;
      const ticket = epoch;
      shifting = true;
      following = (async () => {
        const target = await move(body, ticket);
        shifting = false;
        if (!target) return;
        body.shift(target.dx, target.dy);
        await settle(target);
      })().finally(() => { following = null; shifting = false; });
    },
    async release(point, ordinary, crossDisplay) {
      const body = currentBody(), ticket = epoch;
      const current = () => epoch === ticket && currentBody() === body;
      if (following) {
        await following;
        if (current()) ordinary();
        return;
      }
      if (scene.contains(point) || body?.layout?.mode !== 'drag' || !followCursor) { ordinary(point); return; }
      const target = await move(body, ticket);
      if (!current()) return;
      if (!target) { ordinary(point); return; }
      await crossDisplay(async () => {
        await settle(target);
        if (current()) body.drop({ x: target.x, y: target.y });
      });
    },
  };
}
