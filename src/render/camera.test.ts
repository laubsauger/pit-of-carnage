import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../core';
import { CameraDirector, DIRECTOR_MAX_ZOOM, MANUAL_MAX_ZOOM, MAP_MARGIN, MAX_SHAKE_PX, eventMoment, eventTrauma } from './camera';
import type { FrameInput } from './camera';

function input(points: number[], follow: [number, number] | null = null): FrameInput {
  return {
    viewW: 1600, viewH: 900, mapW: 1360, mapH: 860,
    points: new Float32Array(points), count: points.length / 2,
    followX: follow ? follow[0] : null, followY: follow ? follow[1] : null,
  };
}

/** Run the director long enough to settle. */
function settle(cam: CameraDirector, inp: FrameInput, seconds = 6): void {
  for (let t = 0; t < seconds; t += 1 / 60) cam.update(1 / 60, inp);
}

function visible(cam: CameraDirector, inp: FrameInput, x: number, y: number): boolean {
  const hw = inp.viewW / (2 * cam.zoom);
  const hh = inp.viewH / (2 * cam.zoom);
  return Math.abs(x - cam.x) <= hw && Math.abs(y - cam.y) <= hh;
}

describe('CameraDirector', () => {
  it('keeps every living fighter in frame (you always see who is fighting)', () => {
    const pts = [200, 150, 1150, 700, 680, 430, 300, 690];
    const inp = input(pts);
    const cam = new CameraDirector();
    cam.snap(inp);
    settle(cam, inp);
    for (let i = 0; i < pts.length; i += 2) expect(visible(cam, inp, pts[i]!, pts[i + 1]!)).toBe(true);
  });

  it('zooms in on a tight fight but never past the director limit', () => {
    const inp = input([680, 430, 700, 440]);
    const cam = new CameraDirector();
    cam.snap(inp);
    settle(cam, inp);
    const fit = CameraDirector.fitZoom(inp);
    expect(cam.zoom).toBeGreaterThan(fit * 1.2);
    expect(cam.zoom).toBeLessThanOrEqual(fit * DIRECTOR_MAX_ZOOM + 1e-6);
  });

  it('never zooms out beyond the whole map', () => {
    const inp = input([0, 0, 1360, 860]);
    const cam = new CameraDirector();
    cam.snap(inp);
    settle(cam, inp);
    expect(cam.zoom).toBeGreaterThanOrEqual(CameraDirector.fitZoom(inp) - 1e-6);
  });

  it('follows the chosen fighter and keeps the view inside the map margin', () => {
    const inp = input([100, 100, 1200, 700], [1300, 820]);
    const cam = new CameraDirector();
    cam.snap(inp);
    settle(cam, inp);
    expect(visible(cam, inp, 1300, 820)).toBe(true);
    const hw = inp.viewW / (2 * cam.zoom);
    const hh = inp.viewH / (2 * cam.zoom);
    expect(cam.x + hw).toBeLessThanOrEqual(inp.mapW + MAP_MARGIN + 1e-6);
    expect(cam.y + hh).toBeLessThanOrEqual(inp.mapH + MAP_MARGIN + 1e-6);
  });

  it('eases toward a kill moment and lets go afterwards', () => {
    const inp = input([200, 200, 1100, 650]);
    const cam = new CameraDirector();
    cam.snap(inp);
    settle(cam, inp, 2);
    const base = cam.zoom;
    cam.addMoment(1100, 650, 1);
    settle(cam, inp, 0.5);
    expect(cam.zoom).toBeGreaterThan(base * 1.05);
    settle(cam, inp, 5);
    expect(cam.zoom).toBeCloseTo(base, 3);
  });

  it('caps shake no matter how many impacts stack, and decays it to rest', () => {
    const inp = input([680, 430]);
    const cam = new CameraDirector();
    cam.snap(inp);
    for (let i = 0; i < 50; i++) cam.addTrauma(0.6);
    expect(cam.trauma).toBe(1);
    let peak = 0;
    for (let t = 0; t < 3; t += 1 / 60) {
      cam.update(1 / 60, inp);
      peak = Math.max(peak, Math.hypot(cam.shakeX, cam.shakeY) * cam.zoom);
    }
    expect(peak).toBeLessThanOrEqual(MAX_SHAKE_PX * Math.SQRT2 + 1e-6);
    expect(peak).toBeGreaterThan(1);
    expect(Math.hypot(cam.shakeX, cam.shakeY)).toBe(0);
  });

  // User feedback: hits and projectile impacts shook the screen into constant rumbling. Shake is
  // reserved for kills; everything else gets its weight locally.
  it('shakes only for kills, never for hits, explosions, parries, skills or sudden death', () => {
    const pos = { x: 0, y: 0 };
    const calm: GameEvent[] = [
      { type: 'hit', tick: 1, attackerId: 'f0', victimId: 'f1', amount: 90, pos, dir: 0, crit: true, backstab: true, weapon: 'WARHAMMER', knockback: 9, source: 'weapon' },
      { type: 'explosion', tick: 1, pos, radius: 106 },
      { type: 'parry', tick: 1, fighterId: 'f1', attackerId: 'f0', pos },
      { type: 'skill', tick: 1, fighterId: 'f0', skill: 'SHOCKWAVE', pos },
      { type: 'projectile_end', tick: 1, projectileId: 'p0', pos, hitId: 'f1' },
      { type: 'sudden_death', tick: 1, reason: 'time' },
    ];
    for (const e of calm) expect(eventTrauma(e), e.type).toBe(0);
    const kill = { type: 'kill', tick: 1, killerId: 'f0', victimId: 'f1', cause: 'weapon', pos, dir: 0, title: 'BONK', killerBehaviour: null, victimBehaviour: 'x', weapon: 'WARHAMMER', flags: [], hazard: null } as GameEvent;
    expect(eventTrauma(kill)).toBeGreaterThan(0);
    // The viewer's "no shake" setting (motion-sensitive viewers) silences kills too.
    expect(eventTrauma(kill, 'off')).toBe(0);
    expect(eventTrauma(kill, 'kills')).toBeGreaterThan(0);
  });

  // "The camera itself stays calm": even a critical hit must not ease the zoom toward itself.
  it('pulls the camera toward kills and explosions, never toward ordinary hits', () => {
    const pos = { x: 0, y: 0 };
    const crit: GameEvent = { type: 'hit', tick: 1, attackerId: 'f0', victimId: 'f1', amount: 60, pos, dir: 0, crit: true, backstab: false, weapon: 'GREATSWORD', knockback: 9, source: 'weapon' };
    expect(eventMoment(crit)).toBe(0);
    expect(eventMoment({ type: 'explosion', tick: 1, pos, radius: 106 })).toBeGreaterThan(0);
    const kill = { type: 'kill', tick: 1, killerId: 'f0', victimId: 'f1', cause: 'weapon', pos, dir: 0, title: 'BONK', killerBehaviour: null, victimBehaviour: 'x', weapon: 'WARHAMMER', flags: [], hazard: null } as GameEvent;
    expect(eventMoment(kill)).toBe(1);
  });

  it('keeps easing while the match is paused (camera runs on real time)', () => {
    const cam = new CameraDirector();
    cam.snap(input([200, 200]));
    const before = cam.x;
    const inp = input([1100, 650]);
    for (let i = 0; i < 30; i++) cam.update(1 / 60, inp);
    expect(cam.x).toBeGreaterThan(before);
  });

  // User feedback: the wheel did nothing. Zooming must go toward what the viewer points at, or
  // they lose the fight they wanted a closer look at.
  it('wheel zoom keeps the world point under the cursor in place and stays inside the limits', () => {
    const inp = input([200, 200, 1100, 650]);
    const cam = new CameraDirector();
    cam.snap(inp);
    const sx = 1100;
    const sy = 300;
    const before = { x: cam.x + (sx - inp.viewW / 2) / cam.zoom, y: cam.y + (sy - inp.viewH / 2) / cam.zoom };
    cam.zoomAt(sx, sy, 1.6, inp);
    expect(cam.manual).toBe(true);
    expect(cam.x + (sx - inp.viewW / 2) / cam.zoom).toBeCloseTo(before.x, 6);
    expect(cam.y + (sy - inp.viewH / 2) / cam.zoom).toBeCloseTo(before.y, 6);
    const fit = CameraDirector.fitZoom(inp);
    for (let i = 0; i < 40; i++) cam.zoomAt(sx, sy, 1.5, inp);
    expect(cam.zoom).toBeCloseTo(fit * MANUAL_MAX_ZOOM, 6);
    for (let i = 0; i < 40; i++) cam.zoomAt(sx, sy, 0.5, inp);
    expect(cam.zoom).toBeCloseTo(fit, 6);
  });

  // "Any manual camera input pauses the director until Reset camera": framing, kill moments and a
  // seek's re-snap must all leave the viewer's view alone; release hands it back.
  it('leaves a panned and zoomed view alone until released, then frames the fight again', () => {
    const inp = input([200, 200, 1100, 650]);
    const cam = new CameraDirector();
    cam.snap(inp);
    cam.zoomAt(800, 450, 2, inp);
    cam.panBy(-120, 40, inp);
    const held = { x: cam.x, y: cam.y, zoom: cam.zoom };
    cam.addMoment(1100, 650, 1);
    settle(cam, inp, 2);
    cam.snap(inp);
    expect(cam.x).toBeCloseTo(held.x, 6);
    expect(cam.y).toBeCloseTo(held.y, 6);
    expect(cam.zoom).toBeCloseTo(held.zoom, 6);

    cam.release();
    const director = new CameraDirector();
    director.snap(inp);
    settle(cam, inp, 8);
    expect(cam.manual).toBe(false);
    expect(cam.zoom).toBeCloseTo(director.zoom, 2);
    expect(cam.x).toBeCloseTo(director.x, 0);
  });

  it('drag pan moves the world with the pointer and never leaves the map margin', () => {
    const inp = input([680, 430]);
    const cam = new CameraDirector();
    cam.snap(inp);
    cam.zoomAt(800, 450, 2, inp);
    const x0 = cam.x;
    cam.panBy(100, 0, inp);
    // Dragging right shows what was to the left: the centre moves left by 100 screen px.
    expect(cam.x).toBeCloseTo(x0 - 100 / cam.zoom, 6);
    cam.panBy(1e6, 1e6, inp);
    const hw = inp.viewW / (2 * cam.zoom);
    expect(cam.x - hw).toBeGreaterThanOrEqual(-MAP_MARGIN - 1e-6);
  });
});
