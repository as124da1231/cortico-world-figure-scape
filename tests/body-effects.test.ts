import { describe, expect, it, vi } from 'vitest';
// Browser modules are shipped as JS and intentionally excluded from TS compilation.
// @ts-expect-error no declarations for browser JS
import { createBodyEffects } from '../web/kit/body-effects.js';
// @ts-expect-error no declarations for browser JS
import { createPet } from '../web/kit/body.js';
// @ts-expect-error Browser-only scene module.
import { createWallpaperSpace } from '../web/framework/wallpaper-presentation.js';
// @ts-expect-error Browser-only scene module.
import { createDesktopSpace } from '../web/framework/desktop-space.js';

function fixture(ground?: 'free', bounds = () => ({ W: 1000, H: 800, floorY: 700, S: 1 }), geometry = {}) {
  const element = () => ({ setAttribute: vi.fn(), innerHTML: '', textContent: '' });
  const els = { petG: element(), shadowEl: element(), fxG: element() };
  const onEvent = vi.fn();
  const ctl = createPet(els, { ground, onEvent,
    bounds,
    sfx: { play: vi.fn() }, figure: { draw: vi.fn(), ...geometry }, roam: 'off',
  });
  return { ctl, els, onEvent };
}

describe('body-local effects', () => {
  it('keeps the same desktop floor across a taskbar overlap toggle and tracks a moved work area', () => {
    let height = 862, floor = 815;
    const scene = createDesktopSpace({ viewport: () => ({ width: 1536, height }), floorInset: () => height - floor });
    const { ctl } = fixture(undefined, () => ({ ...scene.bounds(), S: 1 }));
    expect(ctl.pet.fy).toBe(815);
    height = 817;
    ctl.resize();
    expect(ctl.pet.fy).toBe(815);
    ctl.pet.mode = 'air';
    ctl.pet.fy = 660;
    floor = 790;
    ctl.resize();
    expect(ctl.pet.gy - ctl.pet.fy).toBe(155);
  });
  it('carries a narrow desktop model to the screen edge and down to the floor', () => {
    const scene = createDesktopSpace({ viewport: () => ({ width: 1536, height: 862 }), floorInset: () => 47 });
    const S = 1.25;
    const { ctl } = fixture(undefined, () => ({ ...scene.bounds(), S }), {
      extent: [74, 30, 209, 256],
    });
    ctl.setBodyEffects({ squash: false, dragStretch: false, breathing: false });
    expect(ctl.bounds.maxX).toBe(1536 - 8 - 81 * S);
    expect(ctl.bounds.minX).toBe(8 + 54 * S);
    ctl.render();
    const { x, y } = ctl.layout().hit[0];
    expect(ctl.pointerDown({ x, y, t: 20 })).toBe(true);
    const edge = { x: 1535, y: 860 };
    for (let i = 1; i <= 120; i++) {
      ctl.pointerMove({ ...edge, t: 20 + i * 16 });
      ctl.step(1 / 60);
      ctl.render();
    }
    const box = ctl.layout().box;
    expect(Math.abs(box.x + box.w - (1536 - 8))).toBeLessThan(1);
    expect(Math.abs(box.y + box.h - 815)).toBeLessThan(1);
    ctl.pointerUp({ ...edge, t: 1950 });
    expect(ctl.pressing).toBe(false);
    expect(Math.abs(ctl.pet.x - (1536 - 8 - 81 * S))).toBeLessThan(1);
    ctl.pet.facing = -1;
    expect(ctl.bounds.maxX).toBe(1536 - 8 - 54 * S);
    expect(ctl.bounds.minX).toBe(8 + 81 * S);
  });
  it('uses the portrait scene limits even when the desktop limits would keep the body out of the frame', () => {
    const viewport = { W: 1536, H: 862, floorY: 1300, S: 5.6 };
    let bounds: typeof viewport & { minX?: number; maxX?: number } = { ...viewport, minX: 1220, maxX: 1370 };
    const { ctl } = fixture(undefined, () => bounds);
    expect(ctl.layout().x).toBe(1220);
    expect(ctl.bounds.maxX).toBe(1370);
    bounds = { ...viewport, minX: 138, maxX: 284 };
    ctl.resize();
    expect(ctl.layout().x).toBe(284);
    bounds = { ...viewport, S: 1 };
    ctl.resize();
    expect(ctl.bounds).toMatchObject({ minX: 112, maxX: 1424 });
  });
  it('acknowledges a bounded drag released before the next frame, without throwing', () => {
    const { ctl, onEvent } = fixture('free');
    ctl.render();
    const { x, y } = ctl.layout().hit[0];
    ctl.pointerDown({ x, y, t: 10 });
    ctl.pointerMove({ x: x + 90, y: y - 20, t: 20 });
    expect(ctl.pointerUp({ x: x + 90, y: y - 20, t: 21, sceneDrop: 3 })).toBe(true);
    expect(onEvent).toHaveBeenCalledWith('touch', { kind: 'drop', x: x + 90 });
    expect(ctl.pet.vx).toBe(0);
    expect(ctl.pressing).toBe(false);
  });
  it('releases the body above the wallpaper and lands on the configured line', () => {
    const scene = createWallpaperSpace({viewport:()=>({width:1200,height:800}),composition:{x:.45,groundY:.76}});
    const { ctl } = fixture(undefined, () => ({ ...scene.bounds(), S:1 }));
    const anchor = scene.restore();
    ctl.pet.x = anchor.x;
    ctl.render();
    const { x,y } = ctl.layout().hit[0];
    expect(ctl.pointerDown({x,y,t:10})).toBe(true);
    ctl.pointerMove({x:x+12,y:y-240,t:310});
    for (let i=0; i<24; i++) { ctl.step(1/60); ctl.render(); }
    ctl.pointerMove({x:x+12,y:y-240,t:710});
    ctl.pointerMove({x:x+12,y:y-240,t:810});
    ctl.pointerUp({x:x+12,y:y-240,t:811});
    expect(ctl.pet.mode).toBe('air');
    expect(ctl.pet.fy).toBeLessThan(anchor.y-100);
    for (let i=0; i<120; i++) ctl.step(1/60);
    expect(ctl.pet.fy).toBeCloseTo(anchor.y);
    expect(scene.plan(anchor,{x:-100,y:-100}).path).toEqual([{x:scene.bounds().minX,y:anchor.y}]);
  });
  it('uses the full model to identify the torso when only the upper body is shown', () => {
    const { ctl, onEvent } = fixture(undefined, undefined, {
      extent: [80, 0, 176, 140],
      touchExtent: [80, 0, 176, 256],
      hits: [[128, 116, 25]],
    });
    ctl.render();
    const { x, y } = ctl.layout().hit[0];
    expect(ctl.pointerDown({ x, y, t: 10, tapOnly: true })).toBe(true);
    ctl.pointerUp({ x, y, t: 20 });
    expect(onEvent).toHaveBeenCalledWith('touch', { kind: 'poke', region: 'body' });
  });
  it('releases speech immediately without resetting expression, motion, or disabled body effects', () => {
    const { ctl }=fixture();
    ctl.setBodyEffects({squash:false,dragStretch:false,breathing:false});
    ctl.pet.expr='happy';ctl.pet.tilt=7;const gap=[...ctl.pet.gap];
    ctl.talk();expect(ctl.pet.talkK).toBe(1);
    ctl.releaseSpeech();expect(ctl.pet.talkK).toBe(0);
    expect(ctl.pet.expr).toBe('happy');expect(ctl.pet.tilt).toBe(7);expect(ctl.pet.gap).toEqual(gap);
    expect(ctl.bodyEffects).toEqual({squash:false,dragStretch:false,breathing:false});
    ctl.talk();expect(ctl.pet.talkK).toBe(1);
  });
  it('preserves the legacy formulas by default', () => {
    const effects = createBodyEffects();
    for (const sq of [-.35, 0, .45]) for (const st of [0, .5, 1]) for (const br of [-1, 0, 1]) {
      expect(effects.compose(sq, st, br)).toEqual({
        sx: (1 + sq * .7) * (1 - .05 * st) * (1 - .009 * br),
        sy: (1 - sq) * (1 + .09 * st) * (1 + .016 * br), shadowScale: 1 + sq * .5,
      });
    }
  });
  it('controls each effect independently and does not leak mutable policy', () => {
    const effects = createBodyEffects({ squash: false });
    expect(effects.compose(.3, 1, 1)).toEqual({ sx: .95 * .991, sy: 1.09 * 1.016, shadowScale: 1 });
    effects.configure({ dragStretch: false, breathing: false, squash: 'yes', unknown: true });
    expect(effects.compose(.3, 1, 1)).toEqual({ sx: 1, sy: 1, shadowScale: 1 });
    const copy = effects.snapshot(); copy.squash = true;
    expect(effects.snapshot().squash).toBe(false);
  });
  it('resets only disabled effect state', () => {
    const effects = createBodyEffects({ squash: false, dragStretch: false });
    const state = { sq: .3, sqv: 4, stretch: 1, vx: 19, tilt: 8 };
    effects.resetDisabled(state);
    expect(state).toEqual({ sq: 0, sqv: 0, stretch: 0, vx: 19, tilt: 8 });
  });
  it('applies to the real kit render transform, hit geometry and shadow', () => {
    const { ctl, els } = fixture();
    ctl.pet.sq = .3; ctl.pet.stretch = 1; ctl.render();
    expect(ctl.pet.xf.kx).not.toBe(1);
    ctl.setBodyEffects({ squash: false, dragStretch: false, breathing: false });
    ctl.render();
    expect(ctl.pet.xf.kx).toBe(1); expect(ctl.pet.xf.ky).toBe(1);
    expect(els.shadowEl.setAttribute).toHaveBeenLastCalledWith('opacity', 1);
    expect(els.shadowEl.setAttribute).toHaveBeenCalledWith('rx', 72);
    const layout = ctl.layout();
    expect(Number.isFinite(layout.box.w)).toBe(true);
    expect(ctl.pet.x).toBe(700);
  });
  it('discards latent impulses even when re-enabled before the next tick', () => {
    const { ctl } = fixture();
    ctl.setBodyEffects({ squash: false });
    ctl.pet.sqv = 5; // Existing cue/landing writers may still produce impulses.
    ctl.setBodyEffects({ squash: true });
    expect(ctl.pet.sqv).toBe(0);
    ctl.setBodyEffects({ squash: false, dragStretch: false });
    ctl.pet.sqv = 3; ctl.pet.stretch = 1;
    ctl.step(1 / 60);
    expect(ctl.pet.sq).toBe(0); expect(ctl.pet.sqv).toBe(0); expect(ctl.pet.stretch).toBe(0);
  });
});
