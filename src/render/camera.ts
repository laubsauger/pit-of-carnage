/**
 * Camera director: decides where the orthographic camera looks and how far it is zoomed in.
 * Pure state + math, no three.js (the renderer copies the result into the camera).
 *
 * - Director framing: keeps every living fighter in view, centred on the action, never zoomed out
 *   past the whole map and never zoomed in so far that a fight loses its context.
 * - Follow: centres the chosen fighter at a closer zoom.
 * - Moments: a kill or an explosion eases the zoom toward the spot for a moment, then lets go
 *   (`eventMoment`). Ordinary hits never move the camera; their weight is local to the fighters.
 * - Manual: wheel zoom toward the cursor and drag pan take the camera from the director (no
 *   framing, no moments) until `release()`. Following still works, at the viewer's zoom.
 * - View insets: UI panels cover parts of the canvas (inspector, timeline, top bar). Framing,
 *   follow and moments centre on the uncovered rectangle and fit inside it, and the map limits
 *   apply to it, so the action never sits under a panel. Manual zoom and pan are not moved by them.
 * - Shake: a "trauma" value fed by kills only (`eventTrauma`, off in the "no shake" view setting),
 *   capped at 1 and decaying; the offset grows with trauma squared, so one kill is a short jolt and
 *   a multi-kill lands harder.
 * Camera easing runs on real time (`dt` = wall-clock seconds), so the camera settles while paused.
 */

import { clamp } from '../core';
import type { GameEvent, ShakeMode, ViewInsets } from '../core';

/** Shake added by one kill (trauma is capped at 1, so stacked kills never exceed MAX_SHAKE_PX). */
export const KILL_TRAUMA = 0.45;

/**
 * Shake an event adds. Only kills shake the camera: hits, impacts, explosions and parries get
 * their weight locally (hit-stop, flash, squash, sparks, knockback), so ordinary fighting never
 * turns into rumbling. With the viewer's shake setting off, nothing shakes.
 */
export function eventTrauma(e: GameEvent, mode: ShakeMode = 'kills'): number {
  return mode === 'kills' && e.type === 'kill' ? KILL_TRAUMA : 0;
}

/** How hard an event pulls the camera toward it (0..1): kills fully, explosions partly, nothing else. */
export function eventMoment(e: GameEvent): number {
  if (e.type === 'kill') return 1;
  if (e.type === 'explosion') return 0.6;
  return 0;
}

/** Padding around the fighters' bounding box (world px). */
export const FRAME_PAD = 150;
/** Map margin kept visible when fully zoomed out (world px). */
export const MAP_MARGIN = 40;
/** Director never zooms in past this multiple of the fit-the-map zoom. */
export const DIRECTOR_MAX_ZOOM = 1.9;
/** Follow mode zoom, as a multiple of the fit-the-map zoom. */
export const FOLLOW_ZOOM = 2.1;
/** Absolute zoom-in limit, as a multiple of the fit-the-map zoom. */
export const MAX_ZOOM = 2.8;
/** Manual zoom range (wheel), as multiples of the fit-the-map zoom. */
export const MANUAL_MIN_ZOOM = 1;
export const MANUAL_MAX_ZOOM = 4;
/** Largest shake offset, in screen px. */
export const MAX_SHAKE_PX = 12;
/** Trauma lost per second. */
export const TRAUMA_DECAY = 1.5;
/** How long a moment pulls the camera (seconds). */
export const MOMENT_SECONDS = 1.3;
/** Zoom multiplier at the peak of a full-strength moment. */
export const MOMENT_ZOOM = 1.22;
/** How far a full-strength moment pulls the framing centre toward its spot (0..1). */
export const MOMENT_PULL = 0.45;
/**
 * The final kill: the camera eases onto the kill and stays there while the slow motion plays and
 * the moment is admired, then lets the framing settle on the winner.
 */
export const FINAL_MOMENT = { seconds: 3.4, zoom: 1.55, pull: 0.9 } as const;
/**
 * Panels may cover at most this fraction of the canvas on each axis; bigger insets are scaled
 * down (a full-screen overlay must not collapse the arena to nothing).
 */
export const MAX_COVERED = 0.7;

export type FrameInput = {
  /** Canvas size in CSS px. */
  viewW: number;
  viewH: number;
  mapW: number;
  mapH: number;
  /** Living fighter positions as x, y pairs (first `count` pairs are used). */
  points: Float32Array;
  count: number;
  /** Fighter to follow (its interpolated position), or null for director framing. */
  followX: number | null;
  followY: number | null;
  /** Canvas edges covered by UI panels (CSS px). */
  insets: ViewInsets;
};

/** The uncovered part of the canvas: size and the offset of its centre from the canvas centre (CSS px). */
export type Uncovered = { w: number; h: number; ox: number; oy: number };

const _u: Uncovered = { w: 1, h: 1, ox: 0, oy: 0 };

/** The rectangle the viewer can actually see (not under a panel), written into `out`. */
export function uncovered(input: FrameInput, out: Uncovered = _u): Uncovered {
  const w = Math.max(1, input.viewW);
  const h = Math.max(1, input.viewH);
  const ins = input.insets;
  let l = Math.max(0, ins.left);
  let r = Math.max(0, ins.right);
  let t = Math.max(0, ins.top);
  let b = Math.max(0, ins.bottom);
  const sx = l + r > w * MAX_COVERED ? (w * MAX_COVERED) / (l + r) : 1;
  const sy = t + b > h * MAX_COVERED ? (h * MAX_COVERED) / (t + b) : 1;
  l *= sx;
  r *= sx;
  t *= sy;
  b *= sy;
  out.w = w - l - r;
  out.h = h - t - b;
  out.ox = (l - r) / 2;
  out.oy = (t - b) / 2;
  return out;
}

export class CameraDirector {
  /** Camera centre (world px). */
  x = 0;
  y = 0;
  /** Screen px per world px. */
  zoom = 1;
  /** Shake offset in world px (already scaled by zoom). */
  shakeX = 0;
  shakeY = 0;
  trauma = 0;
  /** The viewer took the camera (wheel or drag); the director stays out until `release()`. */
  manual = false;
  private momentX = 0;
  private momentY = 0;
  private momentLeft = 0;
  private momentStrength = 0;
  private momentSeconds = MOMENT_SECONDS;
  private momentZoom = MOMENT_ZOOM;
  private momentPull = MOMENT_PULL;
  private momentFinal = false;
  private clock = 0;
  private targetX = 0;
  private targetY = 0;
  private targetZoom = 1;

  /** Zoom that shows the whole map with a margin inside the uncovered part of the canvas. */
  static fitZoom(input: FrameInput): number {
    const u = uncovered(input);
    return Math.min(u.w / (input.mapW + MAP_MARGIN * 2), u.h / (input.mapH + MAP_MARGIN * 2));
  }

  /**
   * Jump straight to the framing target (new match, seek, resize before the first frame). A
   * manual view stays where the viewer put it (scrubbing the timeline must not undo a zoom).
   */
  snap(input: FrameInput): void {
    if (this.manual) this.manualTarget(input);
    else this.computeTarget(input);
    this.x = this.targetX;
    this.y = this.targetY;
    this.zoom = this.targetZoom;
    this.trauma = 0;
    this.momentLeft = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }

  /** Add shake. Trauma is capped at 1, so stacked impacts never exceed MAX_SHAKE_PX. */
  addTrauma(amount: number): void {
    this.trauma = clamp(this.trauma + Math.max(0, amount), 0, 1);
  }

  /** Ease toward a big moment at (x, y); `strength` 0..1. A stronger moment replaces a weaker one. */
  addMoment(x: number, y: number, strength: number): void {
    const s = clamp(strength, 0, 1);
    const current = this.momentLeft > 0 ? this.momentStrength * (this.momentLeft / this.momentSeconds) : 0;
    if (s < current) return;
    this.startMoment(x, y, s, MOMENT_SECONDS, MOMENT_ZOOM, MOMENT_PULL, false);
  }

  /** The match-deciding kill at (x, y): a long, close moment that nothing else replaces. */
  finalMoment(x: number, y: number): void {
    this.startMoment(x, y, 1, FINAL_MOMENT.seconds, FINAL_MOMENT.zoom, FINAL_MOMENT.pull, true);
  }

  private startMoment(x: number, y: number, s: number, seconds: number, zoom: number, pull: number, final: boolean): void {
    // The final kill's moment holds: a later kill or explosion never cuts it short.
    if (this.momentLeft > 0 && this.momentFinal && !final) return;
    this.momentFinal = final;
    this.momentX = x;
    this.momentY = y;
    this.momentStrength = s;
    this.momentSeconds = seconds;
    this.momentZoom = zoom;
    this.momentPull = pull;
    this.momentLeft = seconds;
  }

  /**
   * Wheel: zoom by `factor` toward the screen point (sx, sy) in CSS px from the canvas top-left,
   * keeping the world point under it in place. Applied at once: direct input never lags.
   */
  zoomAt(sx: number, sy: number, factor: number, input: FrameInput): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    const fit = CameraDirector.fitZoom(input);
    const ox = sx - input.viewW / 2;
    const oy = sy - input.viewH / 2;
    const wx = this.x + ox / this.zoom;
    const wy = this.y + oy / this.zoom;
    const zoom = clamp(this.zoom * factor, fit * MANUAL_MIN_ZOOM, fit * MANUAL_MAX_ZOOM);
    this.zoom = zoom;
    this.x = wx - ox / zoom;
    this.y = wy - oy / zoom;
    this.manual = true;
    this.clampCentre(input, zoom);
  }

  /** Drag: move the view by (dx, dy) CSS px; the world under the pointer moves with it. */
  panBy(dx: number, dy: number, input: FrameInput): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.manual = true;
    this.clampCentre(input, this.zoom);
  }

  /** Back to director framing; the camera eases there from wherever the viewer left it. */
  release(): void {
    this.manual = false;
  }

  update(dt: number, input: FrameInput): void {
    const step = Math.max(0, Math.min(dt, 0.1));
    this.clock += step;
    this.momentLeft = Math.max(0, this.momentLeft - step);
    if (this.manual) this.manualTarget(input);
    else this.computeTarget(input);
    const follow = input.followX !== null;
    const kPos = 1 - Math.exp(-step * (follow ? 5 : 2.6));
    const kZoom = 1 - Math.exp(-step * 2.2);
    this.x += (this.targetX - this.x) * kPos;
    this.y += (this.targetY - this.y) * kPos;
    this.zoom = Math.exp(Math.log(this.zoom) + (Math.log(this.targetZoom) - Math.log(this.zoom)) * kZoom);
    this.clampCentre(input, this.zoom);

    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * step);
    const amp = (MAX_SHAKE_PX * this.trauma * this.trauma) / this.zoom;
    const t = this.clock;
    this.shakeX = amp * (0.6 * Math.sin(t * 41.3) + 0.4 * Math.sin(t * 67.1 + 1.3));
    this.shakeY = amp * (0.6 * Math.sin(t * 37.9 + 2.1) + 0.4 * Math.sin(t * 59.7 + 0.4));
  }

  /** Current moment weight 0..1 (eases in fast, out slowly). */
  momentWeight(): number {
    if (this.momentLeft <= 0) return 0;
    const age = this.momentSeconds - this.momentLeft;
    const rise = Math.min(1, age / 0.18);
    const fall = this.momentLeft / this.momentSeconds;
    return this.momentStrength * rise * Math.sqrt(fall);
  }

  private computeTarget(input: FrameInput): void {
    const fit = CameraDirector.fitZoom(input);
    const u = uncovered(input);
    let cx = input.mapW / 2;
    let cy = input.mapH / 2;
    let zoom = fit;
    if (input.followX !== null && input.followY !== null) {
      cx = input.followX;
      cy = input.followY;
      zoom = fit * FOLLOW_ZOOM;
    } else if (input.count > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < input.count; i++) {
        const px = input.points[i * 2]!;
        const py = input.points[i * 2 + 1]!;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      const bw = maxX - minX + FRAME_PAD * 2;
      const bh = maxY - minY + FRAME_PAD * 2;
      cx = (minX + maxX) / 2;
      cy = (minY + maxY) / 2;
      zoom = clamp(Math.min(u.w / bw, u.h / bh), fit, fit * DIRECTOR_MAX_ZOOM);
    }
    const m = this.momentWeight();
    if (m > 0) {
      cx += (this.momentX - cx) * this.momentPull * m;
      cy += (this.momentY - cy) * this.momentPull * m;
      zoom *= 1 + (this.momentZoom - 1) * m;
    }
    this.targetZoom = clamp(zoom, fit, fit * MAX_ZOOM);
    // (cx, cy) is what the uncovered rectangle centres on. Clamp it with the target's own zoom so
    // the eased camera never chases an out-of-map centre, then shift to the canvas centre.
    const z = this.targetZoom;
    this.targetX = clampAxis(cx, u.w / (2 * z), input.mapW) - u.ox / z;
    this.targetY = clampAxis(cy, u.h / (2 * z), input.mapH) - u.oy / z;
  }

  /** Manual view: stay put (or on the followed fighter) at the viewer's zoom, kept inside the limits. */
  private manualTarget(input: FrameInput): void {
    const fit = CameraDirector.fitZoom(input);
    const u = uncovered(input);
    const z = clamp(this.zoom, fit * MANUAL_MIN_ZOOM, fit * MANUAL_MAX_ZOOM);
    this.targetZoom = z;
    // A followed fighter sits in the middle of the uncovered rectangle; otherwise the view stays put.
    const cx = input.followX ?? this.x + u.ox / z;
    const cy = input.followY ?? this.y + u.oy / z;
    this.targetX = clampAxis(cx, u.w / (2 * z), input.mapW) - u.ox / z;
    this.targetY = clampAxis(cy, u.h / (2 * z), input.mapH) - u.oy / z;
  }

  /** Keep the uncovered part of the view inside the map margin (the covered part may show beyond it). */
  private clampCentre(input: FrameInput, zoom: number): void {
    const u = uncovered(input);
    this.x = clampAxis(this.x + u.ox / zoom, u.w / (2 * zoom), input.mapW) - u.ox / zoom;
    this.y = clampAxis(this.y + u.oy / zoom, u.h / (2 * zoom), input.mapH) - u.oy / zoom;
  }
}

/** Keep a view of half-size `half` inside [−margin, size + margin]; centre it when it cannot fit. */
function clampAxis(c: number, half: number, size: number): number {
  const lo = half - MAP_MARGIN;
  const hi = size - half + MAP_MARGIN;
  if (lo >= hi) return size / 2;
  return clamp(c, lo, hi);
}
