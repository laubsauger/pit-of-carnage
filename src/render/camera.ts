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
 * - Shake: a "trauma" value fed by kills only (`eventTrauma`, off in the "no shake" view setting),
 *   capped at 1 and decaying; the offset grows with trauma squared, so one kill is a short jolt and
 *   a multi-kill lands harder.
 * Camera easing runs on real time (`dt` = wall-clock seconds), so the camera settles while paused.
 */

import { clamp } from '../core';
import type { GameEvent, ShakeMode } from '../core';

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
};

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
  private clock = 0;
  private targetX = 0;
  private targetY = 0;
  private targetZoom = 1;

  /** Zoom that shows the whole map with a margin. */
  static fitZoom(input: FrameInput): number {
    const w = Math.max(1, input.viewW);
    const h = Math.max(1, input.viewH);
    return Math.min(w / (input.mapW + MAP_MARGIN * 2), h / (input.mapH + MAP_MARGIN * 2));
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
    const current = this.momentLeft > 0 ? this.momentStrength * (this.momentLeft / MOMENT_SECONDS) : 0;
    if (s < current) return;
    this.momentX = x;
    this.momentY = y;
    this.momentStrength = s;
    this.momentLeft = MOMENT_SECONDS;
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
    const age = MOMENT_SECONDS - this.momentLeft;
    const rise = Math.min(1, age / 0.18);
    const fall = this.momentLeft / MOMENT_SECONDS;
    return this.momentStrength * rise * Math.sqrt(fall);
  }

  private computeTarget(input: FrameInput): void {
    const fit = CameraDirector.fitZoom(input);
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
      zoom = clamp(Math.min(input.viewW / bw, input.viewH / bh), fit, fit * DIRECTOR_MAX_ZOOM);
    }
    const m = this.momentWeight();
    if (m > 0) {
      cx += (this.momentX - cx) * 0.45 * m;
      cy += (this.momentY - cy) * 0.45 * m;
      zoom *= 1 + (MOMENT_ZOOM - 1) * m;
    }
    this.targetZoom = clamp(zoom, fit, fit * MAX_ZOOM);
    this.targetX = cx;
    this.targetY = cy;
    // Clamp the target with its own zoom so the eased camera never chases an out-of-map centre.
    const halfW = input.viewW / (2 * this.targetZoom);
    const halfH = input.viewH / (2 * this.targetZoom);
    this.targetX = clampAxis(this.targetX, halfW, input.mapW);
    this.targetY = clampAxis(this.targetY, halfH, input.mapH);
  }

  /** Manual view: stay put (or on the followed fighter) at the viewer's zoom, kept inside the limits. */
  private manualTarget(input: FrameInput): void {
    const fit = CameraDirector.fitZoom(input);
    this.targetZoom = clamp(this.zoom, fit * MANUAL_MIN_ZOOM, fit * MANUAL_MAX_ZOOM);
    this.targetX = input.followX ?? this.x;
    this.targetY = input.followY ?? this.y;
    this.targetX = clampAxis(this.targetX, input.viewW / (2 * this.targetZoom), input.mapW);
    this.targetY = clampAxis(this.targetY, input.viewH / (2 * this.targetZoom), input.mapH);
  }

  private clampCentre(input: FrameInput, zoom: number): void {
    this.x = clampAxis(this.x, input.viewW / (2 * zoom), input.mapW);
    this.y = clampAxis(this.y, input.viewH / (2 * zoom), input.mapH);
  }
}

/** Keep a view of half-size `half` inside [−margin, size + margin]; centre it when it cannot fit. */
function clampAxis(c: number, half: number, size: number): number {
  const lo = half - MAP_MARGIN;
  const hi = size - half + MAP_MARGIN;
  if (lo >= hi) return size / 2;
  return clamp(c, lo, hi);
}
