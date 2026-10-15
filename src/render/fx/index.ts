// Owned by: render-fx
/**
 * The effects module: gore, particles, debris and popups driven by sim events.
 *
 * - Persistent gore goes into the floor decal target (multiply colour, see decals.ts): splats,
 *   sprays, streaks from sliding pieces, bloody footprints, scorch marks. It never covers a fighter
 *   and stays for the whole match; old blood darkens to maroon and loses its sheen, never greys.
 * - Every hit stamps blood; big hits gush; a death is a comic explosion (gib burst, blood fountain,
 *   radial splatter painted far across the floor). The View setting "blood amount" scales it all.
 * - Blood drops, mist, sparks, dust, debris and embers are GPU particles (TSL compute); landed drops
 *   stamp themselves into the floor on the GPU.
 * - Projectiles are colour-coded (impacts.ts): trail, impact and sparks share one colour per type,
 *   and every type has its own impact (splinters, sparks and a clang, an arcane burst, a fireball).
 * - Hits get local weight (impact ring, knockback dust, weapon sparks); the camera stays calm.
 * - Gibs, severed limbs, helmets and dropped weapons are CPU-simulated pieces drawn from a part
 *   atlas; wet gibs ooze a pool where they come to rest.
 * - Kill stamps and barks are pooled canvas-texture popups; damage numbers are atlas glyphs.
 *
 * Everything is cosmetic (Math.random is fine here), pooled, and advanced with the scaled frame time
 * the renderer passes in, so slow motion and pause apply to effects too.
 */

import * as THREE from 'three/webgpu';
import { DEFAULT_VIEW_SETTINGS, LIVE_EVENT_TICKS, SKILLS, WEAPONS } from '../../core';
import type { FighterState, FxModule, GameEvent, Limb, Rect, RenderContext, ViewSettings, WeaponId, WorldState } from '../../core';
import { createPartAtlas } from './atlas';
import { barkShown } from './barks';
import { fountainStep, poolStep, spurtStep, startFountain, startPool, startSpurt } from './bleeders';
import type { Fountain, GrowingPool, Spurt } from './bleeders';
import { DecalPainter } from './decals';
import { BloodGrid, BootPrints } from './density';
import { KEG_FX, PROJECTILE_FX, isProjectileWeapon, projectileColor } from './impacts';
import type { ProjectileWeapon } from './impacts';
import { DECAL } from './masks';
import { DamageNumbers } from './numbers';
import { DUST_COLORS, bloodColor, hexToLinear } from './palette';
import type { Rgb } from './palette';
import { PARTS, deathGibs } from './parts';
import type { GibKind, PartId } from './parts';
import { PK, bloodLanding } from './particleRules';
import type { ParticleKind } from './particleRules';
import { GpuParticles } from './particles';
import { PieceRenderer } from './pieceRender';
import { createPiece, launchPiece, stepPiece } from './pieces';
import type { Piece, PieceSink } from './pieces';
import { FixedPool } from './pool';
import { Popups, findFighter } from './popups';
import { Shapes } from './shapes';
import { BLOOD_AMOUNT, deathSplatter } from './splatter';
import type { SplatterStamp } from './splatter';
import type { StreakStamp } from './streaks';

const MAX_PIECES = 192;
const MAX_PARTICLES = 16384;
/** Arm that holds the weapon (losing it drops the weapon). */
const WEAPON_ARM: Limb = 'armR';
/** Seconds a landed gib keeps oozing. */
const OOZE_SECONDS = 1.7;
/** Trail particles per second of game time, per projectile type. */
const TRAIL_RATE: Readonly<Record<ProjectileWeapon, number>> = { LONGBOW: 45, THROWING_AXES: 34, ARCANE_STAFF: 80 };
/** Damage numbers for hits nobody landed (hazards, the closing wall). */
const HAZARD_NUMBER: Rgb = { r: 1, g: 0.62, b: 0.28 };

type Gpu = {
  renderer: THREE.WebGPURenderer;
  camera: THREE.Camera;
  root: THREE.Group;
  atlas: THREE.Texture;
  decals: DecalPainter;
  particles: GpuParticles;
  pieces: PieceRenderer;
  shapes: Shapes;
  popups: Popups;
  numbers: DamageNumbers;
};

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** Roughly normal in [-1.5, 1.5]: sum of three uniforms. */
function spread(): number {
  return Math.random() + Math.random() + Math.random() - 1.5;
}

/** Random sign. */
function sign(): number {
  return Math.random() < 0.5 ? -1 : 1;
}

function makeSpurt(): Spurt {
  return { active: false, serial: 0, fighterId: '', limb: 'armL', t: 0, next: 0 };
}

function makePool(): GrowingPool {
  return { active: false, serial: 0, x: 0, y: 0, radius: 0, angle: 0, seed: 0, duration: 1, t: 0, next: 0 };
}

function makeFountain(): Fountain {
  return { active: false, serial: 0, x: 0, y: 0, power: 1, t: 0, next: 0 };
}

export function createFx(): FxModule {
  let gpu: Gpu | null = null;
  /** Live context: the renderer mutates map and floorSize in place on a map change, then resets. */
  let context: RenderContext | null = null;
  let walls: Rect[] = [];
  let dust: Rgb = DUST_COLORS.sand;
  let grid = new BloodGrid(1, 1);
  let time = 0;
  /** View settings; may arrive before init. */
  let view: ViewSettings = { ...DEFAULT_VIEW_SETTINGS };
  let amount = BLOOD_AMOUNT[view.blood];

  const pieces = new FixedPool<Piece>(MAX_PIECES, createPiece);
  const spurts = new FixedPool<Spurt>(24, makeSpurt);
  const pools = new FixedPool<GrowingPool>(64, makePool);
  const fountains = new FixedPool<Fountain>(8, makeFountain);
  const boots = new BootPrints();
  const helmetOn = new Map<string, boolean>();
  const lastHitDir = new Map<string, number>();
  const nextDrip = new Map<string, number>();
  const projWeapon = new Map<string, WeaponId>();
  const projOwner = new Map<string, string>();
  const projDir = new Map<string, number>();
  /** Spell colour (linear) per caster id, computed once. */
  const spellOf = new Map<string, Rgb>();
  const gibList: GibKind[] = [];
  const splatter: SplatterStamp[] = [];
  const col: Rgb = { r: 0, g: 0, b: 0 };
  const tint: Rgb = { r: 0, g: 0, b: 0 };
  const pcol: Rgb = { r: 0, g: 0, b: 0 };
  const land = { x: 0, y: 0 };
  const viewSize = new THREE.Vector2();

  // ---- Painting helpers -----------------------------------------------------------------------

  /** Persistent blood stamp + fresh-blood bookkeeping for footprints. `t` picks the colour ramp. */
  function bloodStamp(kind: number, x: number, y: number, angle: number, halfLen: number, halfWid: number, t: number, alpha: number, wet: number): void {
    if (!gpu) return;
    bloodColor(col, t);
    gpu.decals.stamp(kind, x, y, angle, halfLen, halfWid, col.r, col.g, col.b, alpha, wet);
    grid.add(x, y, (halfLen + halfWid) * 0.5, alpha * (kind === DECAL.print ? 0 : 1));
  }

  function particle(kind: ParticleKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, c: Rgb, a: number): void {
    gpu?.particles.spawn(kind, x, y, z, vx, vy, vz, size, life, c.r, c.g, c.b, a);
  }

  /** One blood drop: GPU particle, plus where it will land in the fresh-blood grid. */
  function drop(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, t: number): void {
    bloodColor(col, t);
    particle(PK.blood, x, y, z, vx, vy, vz, size, 3, col, 1);
    bloodLanding(land, x, y, z, vx, vy, vz);
    grid.add(land.x, land.y, size, 0.5);
  }

  /** A cone of blood drops along `dir` (radians) with `cone` spread. */
  function sprayDrops(x: number, y: number, z: number, dir: number, cone: number, n: number, speedMin: number, speedMax: number, sizeMul = 1): void {
    for (let i = 0; i < n; i++) {
      const a = cone >= Math.PI ? Math.random() * Math.PI * 2 : dir + spread() * cone;
      const s = rnd(speedMin, speedMax);
      drop(x, y, z + rnd(-3, 3), Math.cos(a) * s, Math.sin(a) * s, rnd(40, 150), rnd(1.5, 3.6) * sizeMul, rnd(0.5, 1));
    }
  }

  /**
   * Catch-up stand-in for a spray of drops (after a seek no particles fly): flecks stamped straight
   * into the floor over the same cone and reach.
   */
  function flecks(x: number, y: number, dir: number, cone: number, n: number, near: number, far: number, sizeMul = 1): void {
    for (let i = 0; i < n; i++) {
      const a = cone >= Math.PI ? Math.random() * Math.PI * 2 : dir + spread() * cone;
      const d = rnd(near, far);
      const r = rnd(1.8, 4.2) * sizeMul;
      bloodStamp(DECAL.drop, x + Math.cos(a) * d, y + Math.sin(a) * d, a, r * rnd(1, 1.6), r, rnd(0.6, 1), 0.9, 1);
    }
  }

  function mist(x: number, y: number, dir: number, n: number, size: number): void {
    // Bright, thin and red: dark mist over a lit floor reads as grey smoke.
    bloodColor(col, 0.95);
    for (let i = 0; i < n; i++) {
      const a = dir + spread() * 0.6;
      const s = rnd(30, 120);
      particle(PK.mist, x, y, rnd(10, 22), Math.cos(a) * s, Math.sin(a) * s, rnd(-10, 25), size * rnd(0.7, 1.3), rnd(0.3, 0.6), col, 0.22);
    }
  }

  function sparks(x: number, y: number, n: number, speed: number, r: number, g: number, b: number, intensity: number, dir = 0, cone = Math.PI): void {
    tint.r = r;
    tint.g = g;
    tint.b = b;
    for (let i = 0; i < n; i++) {
      const a = cone >= Math.PI ? Math.random() * Math.PI * 2 : dir + spread() * cone;
      const s = speed * rnd(0.35, 1);
      particle(PK.spark, x, y, rnd(8, 18), Math.cos(a) * s, Math.sin(a) * s, rnd(40, 220), rnd(1.6, 3), rnd(0.22, 0.55), tint, intensity);
    }
  }

  function embers(x: number, y: number, n: number, speed: number, c: Rgb, intensity: number, size = 1, life = 1): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * rnd(0.3, 1);
      particle(PK.ember, x, y, rnd(8, 20), Math.cos(a) * s, Math.sin(a) * s, rnd(20, 140), rnd(2, 3.5) * size, rnd(0.35, 0.8) * life, c, intensity);
    }
  }

  function dustPuffs(x: number, y: number, n: number, size: number, speed: number, alpha: number, c: Rgb = dust, dir = 0, cone = Math.PI): void {
    // A blood-soaked floor kicks up no dust: pale puffs over dark blood read as grey haze.
    if (c === dust) {
      const wet = grid.sample(x, y);
      alpha *= 1 - 0.85 * (wet > 1 ? 1 : wet);
      if (alpha < 0.02) return;
    }
    for (let i = 0; i < n; i++) {
      const a = cone >= Math.PI ? Math.random() * Math.PI * 2 : dir + spread() * cone;
      const s = speed * rnd(0.3, 1);
      particle(PK.dust, x + rnd(-3, 3), y + rnd(-3, 3), rnd(1, 4), Math.cos(a) * s, Math.sin(a) * s, rnd(4, 14), size * rnd(0.7, 1.3), rnd(0.5, 0.95), c, alpha);
    }
  }

  function debris(x: number, y: number, n: number, speed: number, c: Rgb, size: number, life: number, dir = 0, cone = Math.PI): void {
    for (let i = 0; i < n; i++) {
      const a = cone >= Math.PI ? Math.random() * Math.PI * 2 : dir + spread() * cone;
      const s = speed * rnd(0.3, 1);
      particle(PK.debris, x, y, rnd(6, 16), Math.cos(a) * s, Math.sin(a) * s, rnd(120, 340), size * rnd(0.6, 1.4), life * rnd(0.7, 1.2), c, 1);
    }
  }

  /** Linear colour of a fighter (writes `out`); `fallback` when unknown. */
  function fighterColor(out: Rgb, state: WorldState, id: string | null, fallback: Rgb): Rgb {
    const f = id ? findFighter(state, id) : null;
    if (!f) {
      out.r = fallback.r;
      out.g = fallback.g;
      out.b = fallback.b;
      return out;
    }
    return hexToLinear(out, f.color);
  }

  /** Spell colour of a caster (cached), or the default arcane colour for an unknown caster. */
  function spell(state: WorldState, ownerId: string | undefined): Rgb {
    if (!ownerId) return projectileColor(pcol, 'ARCANE_STAFF', null);
    let c = spellOf.get(ownerId);
    if (!c) {
      const f = findFighter(state, ownerId);
      if (!f) return projectileColor(pcol, 'ARCANE_STAFF', null);
      c = projectileColor({ r: 0, g: 0, b: 0 }, 'ARCANE_STAFF', f.color);
      spellOf.set(ownerId, c);
    }
    return c;
  }

  /**
   * Throw a piece. For a stale event (catching up after a seek) the piece is placed where it would
   * roughly have come to rest instead, so the floor still shows the carnage.
   */
  function throwPiece(
    part: PartId, x: number, y: number, z: number, vx: number, vy: number, vz: number, spin: number,
    owner: string | null, live: boolean, flip = sign(),
  ): void {
    const p = pieces.acquire();
    if (live) {
      launchPiece(p, part, x, y, z, vx, vy, vz, Math.random() * Math.PI * 2, spin, flip);
    } else {
      launchPiece(p, part, x + vx * 0.35, y + vy * 0.35, 0, 0, 0, 0, Math.random() * Math.PI * 2, 0, flip);
      p.settled = true;
      ooze(p, false);
      p.streak.wet = 0;
    }
    hexToLinear(tint, owner ?? '#8a8a8a');
    p.r = tint.r;
    p.g = tint.g;
    p.b = tint.b;
  }

  /** A wet gib came to rest: it oozes a pool under itself (guts most), growing for a moment. */
  function ooze(p: Piece, live: boolean): void {
    const def = PARTS[p.part];
    if (def.ooze <= 0 || p.streak.wet < 0.05) return;
    const radius = def.ooze * amount.size * (0.65 + 0.35 * Math.min(1, p.streak.wet));
    if (live) {
      startPool(pools.acquire(), p.x, p.y, radius, Math.random() * 6.3, Math.random() * 97, OOZE_SECONDS);
    } else {
      bloodStamp(DECAL.pool, p.x, p.y, Math.random() * 6.3, radius, radius * 0.86, 0.45, 0.9, 0.9);
    }
  }

  // ---- Piece sink: what sliding and bouncing pieces do to the floor ----------------------------

  const sink: PieceSink = {
    impact(p: Piece, speed: number) {
      const def = PARTS[p.part];
      if (p.streak.wet > 0.05 && speed > 60) {
        const k = Math.min(1.4, speed / 320);
        bloodStamp(DECAL.pool, p.x, p.y, Math.random() * Math.PI * 2, def.radius * (0.8 + k * 0.7) * amount.size, def.radius * (0.7 + k * 0.6) * amount.size, 0.6 + 0.4 * p.streak.wet, 0.85, p.streak.wet);
        if (speed > 140) sprayDrops(p.x, p.y, 2, Math.atan2(p.vy, p.vx), 1.2, Math.round((3 + k * 5) * amount.count), 40, 160, 0.8);
      }
      if (def.material === 'metal' && speed > 110) sparks(p.x, p.y, 3 + Math.floor(speed / 120), 160, 1, 0.6, 0.25, 1.5);
      if (def.material === 'wood' && speed > 150) dustPuffs(p.x, p.y, 2, 6, 30, 0.25);
    },
    streak(_p: Piece, st: StreakStamp) {
      const t = 0.3 + 0.6 * st.wet + rnd(-0.08, 0.08);
      bloodStamp(st.fleck ? DECAL.drop : DECAL.streak, st.x, st.y, st.angle, st.length / 2, (st.width / 2) * amount.size, t, st.alpha, st.wet);
    },
    wall(p: Piece, speed: number) {
      if (p.streak.wet > 0.1 && speed > 80) bloodStamp(DECAL.splat, p.x, p.y, Math.random() * 6.3, p.radius * 0.9, p.radius * 0.8, 0.65, 0.7, p.streak.wet);
      if (PARTS[p.part].material === 'metal' && speed > 100) sparks(p.x, p.y, 4, 150, 1, 0.6, 0.25, 1.5);
    },
  };

  // ---- Spurts, fountains and pools ------------------------------------------------------------

  let spurtFighter: FighterState | null = null;
  let spurtLimb: Limb = 'armL';

  function socketAngle(f: FighterState, limb: Limb): number {
    switch (limb) {
      case 'armL':
        return f.facing - Math.PI / 2;
      case 'armR':
        return f.facing + Math.PI / 2;
      case 'legL':
        return f.facing + Math.PI - 0.45;
      default:
        return f.facing + Math.PI + 0.45;
    }
  }

  const pulse = (strength: number): void => {
    const f = spurtFighter;
    if (!f) return;
    const a = socketAngle(f, spurtLimb);
    const reach = spurtLimb.startsWith('arm') ? 0.85 : 0.45;
    const sx = f.pos.x + Math.cos(a) * f.radius * reach;
    const sy = f.pos.y + Math.sin(a) * f.radius * reach;
    const n = Math.round((6 + 10 * strength) * amount.count);
    for (let i = 0; i < n; i++) {
      const d = a + spread() * 0.3;
      const s = rnd(120, 320) * strength;
      drop(sx, sy, 14, Math.cos(d) * s, Math.sin(d) * s, rnd(90, 210) * Math.sqrt(strength), rnd(1.4, 3.2) * amount.size, rnd(0.75, 1));
    }
    bloodStamp(DECAL.drop, sx + rnd(-3, 3), sy + rnd(-3, 3), Math.random() * 6.3, (3 + 3 * strength) * amount.size, (3 + 2.5 * strength) * amount.size, 0.85, 0.85, 1);
  };

  let fountainNow: Fountain | null = null;
  /** One eruption of a death fountain: blood thrown high in every direction, raining down wide. */
  const erupt = (strength: number): void => {
    const f = fountainNow;
    if (!f) return;
    const n = Math.max(2, Math.round(15 * strength * f.power));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rnd(25, 250) * (0.45 + 0.55 * strength);
      drop(f.x + rnd(-4, 4), f.y + rnd(-4, 4), 22, Math.cos(a) * s, Math.sin(a) * s, rnd(240, 500) * (0.55 + 0.45 * strength), rnd(1.8, 4) * amount.size, rnd(0.7, 1));
    }
    if (strength > 0.5) mist(f.x, f.y, Math.random() * 6.3, 1, 16);
  };

  let poolNow: GrowingPool | null = null;
  const poolStamp = (radius: number): void => {
    const p = poolNow;
    if (!p) return;
    if (!gpu) return;
    bloodColor(col, 0.45);
    gpu.decals.stamp(DECAL.pool, p.x, p.y, p.angle, radius, radius * 0.86, col.r, col.g, col.b, 0.12, 0.9, p.seed);
    grid.add(p.x, p.y, radius * 0.8, 0.25);
  };

  // ---- Event handlers -------------------------------------------------------------------------

  function onHit(ev: Extract<GameEvent, { type: 'hit' }>, state: WorldState, live: boolean): void {
    lastHitDir.set(ev.victimId, ev.dir);
    const victim = findFighter(state, ev.victimId);
    const x = ev.pos.x;
    const y = ev.pos.y;
    const S = amount.size;
    const N = amount.count;
    const sev = Math.min(1.5, Math.max(0.2, (ev.amount - 3) / 28)) * (ev.crit ? 1.3 : 1) * (ev.source === 'punch' ? 0.55 : 1);
    const big = ev.crit || ev.amount >= 28;
    const dir = ev.dir;
    const dx = Math.cos(dir);
    const dy = Math.sin(dir);
    const r = victim ? victim.radius : 18;
    const ux = victim ? victim.pos.x : x;
    const uy = victim ? victim.pos.y : y;
    // Floor: every hit stamps. A spray thrown along the blow from the far side of the body (the
    // spray's head sits a third of its length behind its centre), and blood dropping under the victim.
    const len = (24 + 42 * sev) * S;
    const head = r * 0.45;
    bloodStamp(DECAL.spray, ux + dx * (head + len * 0.66), uy + dy * (head + len * 0.66), dir + spread() * 0.12, len, (8 + 10 * sev) * S, rnd(0.8, 1), 0.95, 1);
    bloodStamp(sev > 0.75 ? DECAL.splat : DECAL.pool, ux + rnd(-5, 5), uy + rnd(-5, 5), Math.random() * 6.3, (7 + 11 * sev) * S, (6 + 10 * sev) * S, rnd(0.65, 0.95), 0.9, 0.9);
    if (big) {
      // A big hit gushes: a second, wider spray and a splat further out along the blow.
      const a = dir + spread() * 0.3;
      bloodStamp(DECAL.spray, ux + Math.cos(a) * (head + len * 0.9), uy + Math.sin(a) * (head + len * 0.9), a, len * 0.85, (10 + 10 * sev) * S, rnd(0.8, 1), 0.95, 1);
      bloodStamp(DECAL.splat, ux + dx * (r + len * 1.5), uy + dy * (r + len * 1.5), Math.random() * 6.3, (9 + 8 * sev) * S, (8 + 7 * sev) * S, 0.85, 0.9, 1);
    }
    if (!live) {
      flecks(ux, uy, dir, 0.45, Math.round((3 + 6 * sev) * N), r, r + (50 + 110 * sev) * S, S);
      return;
    }
    // Blood leaves the far side of the body along the blow, with a little back-spatter.
    const ex = x + dx * r * 0.7;
    const ey = y + dy * r * 0.7;
    const n = Math.min(80, Math.round((10 + 26 * sev) * N));
    sprayDrops(ex, ey, 16, dir, 0.45, n, 70, 170 + 170 * sev, S);
    sprayDrops(x - dx * r * 0.6, y - dy * r * 0.6, 14, dir + Math.PI, 0.7, Math.round(n * 0.25), 40, 130, 0.8 * S);
    if (big) sprayDrops(ex, ey, 18, dir, 0.22, Math.round(n * 0.7), 240, 420 + 120 * sev, 1.25 * S);
    mist(ex, ey, dir, ev.crit ? 5 : 2, 12 + 6 * sev);
    gpu?.shapes.flash(x, y, 14 + 12 * sev, ev.crit ? 0.14 : 0.09, 1, 0.85, 0.7, ev.crit ? 3 : 2);
    // Weight without moving the camera: a small impact ring on the floor and knockback dust.
    gpu?.shapes.ring(ux, uy, r * 0.7, r * 1.2 + 16 * sev, 0.22, 1, 0.86, 0.7, 0.55, 0.15, 0.12);
    if (ev.knockback >= 3) {
      const kb = ev.knockback;
      dustPuffs(ux - dx * r * 0.4, uy - dy * r * 0.4, 2 + Math.round(kb * 0.35), 6 + kb * 0.4, 30 + kb * 7, 0.3, dust, dir, 0.6);
    }
    weaponSparks(ev, state, x, y, sev);
    if (view.damageNumbers && gpu) {
      fighterColor(tint, state, ev.attackerId, HAZARD_NUMBER);
      // Lift dark fighter colours a little so the number reads on the floor.
      gpu.numbers.add(ev.victimId, ev.attackerId ?? '', ux, uy, r, ev.amount, ev.crit, ev.backstab, tint.r * 0.85 + 0.15, tint.g * 0.85 + 0.15, tint.b * 0.85 + 0.15);
    }
  }

  /** Sparks or spray coloured by the weapon that landed the hit. */
  function weaponSparks(ev: Extract<GameEvent, { type: 'hit' }>, state: WorldState, x: number, y: number, sev: number): void {
    const dir = ev.dir;
    switch (ev.weapon) {
      case 'GREATSWORD':
        if (sev > 0.45 || ev.crit) sparks(x, y, ev.crit ? 9 : 5, 240, 0.85, 0.92, 1, 1.6, dir, 0.7);
        break;
      case 'WARHAMMER':
        sparks(x, y, ev.crit ? 10 : 6, 220, 1, 0.55, 0.2, 1.6, dir, 0.8);
        dustPuffs(x, y, 3, 9, 70, 0.28);
        break;
      case 'TWIN_DAGGERS':
        sparks(x, y, ev.crit || ev.backstab ? 5 : 2, 200, 1, 1, 0.95, 1.4, dir, 0.5);
        break;
      case 'THROWING_AXES':
      case 'LONGBOW':
        projectileColor(pcol, ev.weapon, null);
        sparks(x, y, ev.crit ? 6 : 3, 180, pcol.r, pcol.g, pcol.b, 1.3, dir, 0.6);
        break;
      case 'ARCANE_STAFF':
        // Splash victims glitter in the caster's colour.
        embers(x, y, 6, 120, spell(state, ev.attackerId ?? undefined), 1.6, 0.8, 0.7);
        break;
      default:
        if (ev.crit) sparks(x, y, 8, 220, 1, 0.55, 0.2, 1.6, dir, 0.8);
    }
  }

  function onParry(ev: Extract<GameEvent, { type: 'parry' }>): void {
    const x = ev.pos.x;
    const y = ev.pos.y;
    sparks(x, y, Math.round(rnd(18, 26)), 380, 1, 0.45, 0.1, 1.6);
    gpu?.shapes.flash(x, y, 24, 0.14, 0.85, 0.92, 1, 3);
    gpu?.shapes.ring(x, y, 6, 36, 0.22, 1, 0.7, 0.35, 1.2, 0, 0.18);
  }

  function onProjectileEnd(ev: Extract<GameEvent, { type: 'projectile_end' }>, state: WorldState, live: boolean): void {
    const weapon = projWeapon.get(ev.projectileId);
    const owner = projOwner.get(ev.projectileId);
    const dir = projDir.get(ev.projectileId) ?? 0;
    projWeapon.delete(ev.projectileId);
    projOwner.delete(ev.projectileId);
    projDir.delete(ev.projectileId);
    if (!live || !gpu || !isProjectileWeapon(weapon)) return;
    const x = ev.pos.x;
    const y = ev.pos.y;
    const hit = ev.hitId !== null;
    switch (PROJECTILE_FX[weapon].impact) {
      case 'splinters': {
        // Wood splinters bounce back off whatever it hit, with a small spray in the arrow's amber.
        projectileColor(pcol, weapon, null);
        tint.r = pcol.r * 0.55;
        tint.g = pcol.g * 0.5;
        tint.b = pcol.b * 0.45;
        debris(x, y, Math.round(rnd(6, 10)), 190, tint, 1.5, 0.8, dir + Math.PI, 1.1);
        sparks(x, y, 6, 150, pcol.r, pcol.g, pcol.b, 1.1, dir + Math.PI, 0.9);
        gpu.shapes.flash(x, y, 12, 0.08, pcol.r, pcol.g, pcol.b, 1.4);
        if (!hit) dustPuffs(x, y, 3, 6, 45, 0.28, dust, dir, 0.6);
        break;
      }
      case 'sparks': {
        // Steel on whatever it hit: a shower of metal sparks and a bright clang flash.
        projectileColor(pcol, weapon, null);
        sparks(x, y, 14, 320, pcol.r, pcol.g, pcol.b, 1.9);
        sparks(x, y, 5, 260, 1, 0.65, 0.3, 1.6, dir + Math.PI, 1.0);
        gpu.shapes.flash(x, y, 26, 0.12, pcol.r, pcol.g, pcol.b, 3.2);
        gpu.shapes.ring(x, y, 4, 30, 0.18, pcol.r, pcol.g, pcol.b, 2, 0, 0.12);
        break;
      }
      case 'arcane': {
        // The orb bursts in the caster's spell colour, with a ring the size of its splash.
        const c = spell(state, owner);
        const r = WEAPONS.ARCANE_STAFF.splash;
        embers(x, y, 30, 260, c, 1.9);
        gpu.shapes.flash(x, y, r * 0.75, 0.22, c.r, c.g, c.b, 2, 0.25);
        gpu.shapes.ring(x, y, r * 0.2, r, 0.32, c.r, c.g, c.b, 1.6, 0, 0.16);
        break;
      }
      case 'fireball':
        break;
    }
  }

  function onDismember(ev: Extract<GameEvent, { type: 'dismember' }>, state: WorldState, live: boolean): void {
    const victim = findFighter(state, ev.victimId);
    const x = ev.pos.x;
    const y = ev.pos.y;
    const vx = ev.vel.x * 60;
    const vy = ev.vel.y * 60;
    const dir = Math.hypot(vx, vy) > 1 ? Math.atan2(vy, vx) : Math.random() * Math.PI * 2;
    const S = amount.size;
    bloodStamp(DECAL.splat, x, y, Math.random() * 6.3, 15 * S, 13 * S, 0.7, 0.9, 1);
    bloodStamp(DECAL.spray, x + Math.cos(dir) * 30 * S, y + Math.sin(dir) * 30 * S, dir, 38 * S, 14 * S, 0.85, 0.9, 1);
    const part: PartId = ev.limb === 'armL' || ev.limb === 'armR' ? 'limbArm' : 'limbLeg';
    const flip = ev.limb === 'armL' || ev.limb === 'legL' ? -1 : 1;
    const color = victim ? victim.color : null;
    throwPiece(part, x, y, 12, vx + Math.cos(dir) * 60, vy + Math.sin(dir) * 60, rnd(170, 290), rnd(6, 14) * sign(), color, live, flip);
    if (ev.limb === WEAPON_ARM && victim) {
      // Losing the weapon arm drops the weapon.
      const a = dir + spread() * 0.8;
      throwPiece(`weapon_${victim.weapon}`, x, y, 16, Math.cos(a) * rnd(90, 170), Math.sin(a) * rnd(90, 170), rnd(160, 240), rnd(7, 13) * sign(), null, live);
    }
    if (!live) {
      flecks(x, y, dir, 0.6, Math.round(10 * amount.count), 10, 120 * S, S);
      return;
    }
    sprayDrops(x, y, 14, dir, 0.5, Math.round(30 * amount.count), 100, 340, S);
    mist(x, y, dir, 3, 16);
    const s = spurts.acquire();
    startSpurt(s, ev.victimId, ev.limb);
  }

  function popHelmet(f: FighterState, dir: number, live: boolean): void {
    const a = dir + spread() * 0.5;
    const s = rnd(120, 230);
    throwPiece(`helmet_${f.weapon}`, f.pos.x, f.pos.y, 22, Math.cos(a) * s, Math.sin(a) * s, rnd(200, 290), rnd(9, 17) * sign(), f.color, live);
    if (live) sparks(f.pos.x, f.pos.y, 6, 200, 1, 0.6, 0.25, 1.6, dir, 0.7);
  }

  function onKill(ev: Extract<GameEvent, { type: 'kill' }>, state: WorldState, live: boolean): void {
    const victim = findFighter(state, ev.victimId);
    const x = ev.pos.x;
    const y = ev.pos.y;
    const dir = ev.dir;
    const blast = ev.cause === 'keg';
    const S = amount.size;
    const N = amount.count;
    // Floor: a fat central splat, then a ring of long sprays and flecks flung far across the floor.
    bloodStamp(DECAL.splat, x, y, Math.random() * 6.3, rnd(34, 44) * S, rnd(30, 38) * S, 0.8, 0.95, 1);
    const n = deathSplatter(splatter, dir, amount, Math.random);
    for (let i = 0; i < n; i++) {
      const st = splatter[i];
      const sx = x + Math.cos(st.angle) * st.dist;
      const sy = y + Math.sin(st.angle) * st.dist;
      if (st.arm) bloodStamp(DECAL.spray, sx, sy, st.angle, st.halfLen, st.halfWid, rnd(0.75, 1), 0.95, 1);
      else bloodStamp(DECAL.drop, sx, sy, st.angle, st.halfLen, st.halfWid, rnd(0.6, 1), 0.9, 1);
    }
    if (live) {
      startPool(pools.acquire(), x + rnd(-4, 4), y + rnd(-4, 4), rnd(38, 50) * S, Math.random() * 6.3, Math.random() * 97);
    } else {
      bloodStamp(DECAL.pool, x, y, Math.random() * 6.3, 44 * S, 38 * S, 0.45, 0.9, 0.9);
    }
    // Gibs burst out, plus the weapon (if the weapon arm was still on) and the helmet (if still
    // worn). The sim has already cleared the helmet flag by now, so trust what the last state said.
    const hasArm = victim ? victim.limbs[WEAPON_ARM] : true;
    const gibs = view.blood === 'light' ? 8 : view.blood === 'carnage' ? 11 : 9 + Math.floor(Math.random() * 2);
    deathGibs(gibList, blast ? Math.max(10, gibs) : gibs, hasArm, Math.random);
    const color = victim ? victim.color : null;
    const power = blast ? 1.7 : 1.25;
    for (const kind of gibList) {
      const a = Math.random() < 0.6 ? dir + spread() * 1.3 : Math.random() * Math.PI * 2;
      const s = rnd(130, 360) * power;
      throwPiece(kind, x + rnd(-6, 6), y + rnd(-6, 6), rnd(10, 18), Math.cos(a) * s, Math.sin(a) * s, rnd(220, 480) * power, rnd(5, 18) * sign(), color, live);
    }
    if (victim && hasArm) {
      const a = dir + spread() * 1.2;
      throwPiece(`weapon_${victim.weapon}`, x, y, 18, Math.cos(a) * rnd(60, 150), Math.sin(a) * rnd(60, 150), rnd(150, 230), rnd(6, 12) * sign(), null, live);
    }
    if (victim && helmetOn.get(ev.victimId) !== false) popHelmet(victim, dir, live);
    helmetOn.set(ev.victimId, false);
    if (!live) return;
    // The body erupts: a fountain raining blood all around, a radial burst and a jet along the blow.
    startFountain(fountains.acquire(), x, y, (blast ? 1.3 : 1) * Math.sqrt(N));
    sprayDrops(x, y, 18, dir, Math.PI, Math.round(40 * N), 120, 420, 1.2 * S);
    sprayDrops(x, y, 18, dir, 0.5, Math.round(30 * N), 200, 480, S);
    mist(x, y, dir, 10, 24);
    gpu?.shapes.flash(x, y, 60, 0.2, 1, 0.55, 0.4, 2.6);
    gpu?.shapes.ring(x, y, 12, 95 * S, 0.42, 0.95, 0.12, 0.06, 1.5, 0, 0.2);
    if (view.killStamps) gpu?.popups.stamp(ev.title, x, y);
  }

  function onExplosion(ev: Extract<GameEvent, { type: 'explosion' }>, live: boolean): void {
    const x = ev.pos.x;
    const y = ev.pos.y;
    const r = ev.radius;
    if (!gpu) return;
    gpu.decals.stamp(DECAL.scorch, x, y, Math.random() * 6.3, r * 0.9, r * 0.9, 0, 0, 0, 0.9, 0);
    if (!live) return;
    hexToLinear(pcol, KEG_FX.color);
    // ACES tone mapping washes bright HDR orange out to cream: keep the fireball near 1.0 so it
    // stays orange (the cover part is an opaque fireball), with a hotter core that blooms.
    gpu.shapes.flash(x, y, r * 1.05, 0.4, pcol.r, pcol.g, pcol.b, 1.0, 0.8);
    gpu.shapes.flash(x, y, r * 0.55, 0.22, 1, 0.75, 0.3, 2.4);
    gpu.shapes.ring(x, y, r * 0.25, r * 1.4, 0.38, pcol.r, pcol.g, pcol.b, 1.4, 0.3, 0.16);
    gpu.shapes.ring(x, y, r * 0.5, r * 1.9, 0.9, dust.r, dust.g, dust.b, 1, 0.4, 0.3);
    sparks(x, y, 44, 520, 1, 0.45, 0.08, 1.7);
    embers(x, y, 36, 300, pcol, 1.8, 1.2, 1.4);
    // Charred staves and dark, warm smoke (never a grey puff).
    tint.r = 0.12;
    tint.g = 0.06;
    tint.b = 0.03;
    debris(x, y, 18, 420, tint, 3, 1.6);
    tint.r = 0.16;
    tint.g = 0.07;
    tint.b = 0.025;
    dustPuffs(x, y, 14, 26, 160, 0.42, tint);
  }

  function onSkill(ev: Extract<GameEvent, { type: 'skill' }>, state: WorldState): void {
    const x = ev.pos.x;
    const y = ev.pos.y;
    const f = findFighter(state, ev.fighterId);
    const shapes = gpu?.shapes;
    switch (ev.skill) {
      case 'WHIRLWIND':
        shapes?.ring(x, y, 20, SKILLS.WHIRLWIND.radius, 0.35, dust.r, dust.g, dust.b, 1, 0.5, 0.22);
        dustPuffs(x, y, 10, 10, 160, 0.3);
        break;
      case 'SHOCKWAVE': {
        // A slam into a cone ahead: flash at the front, dust thrown forward.
        const a = f ? f.facing : 0;
        const reach = SKILLS.SHOCKWAVE.radius;
        shapes?.flash(x + Math.cos(a) * reach * 0.45, y + Math.sin(a) * reach * 0.45, reach * 0.6, 0.18, 1, 0.85, 0.6, 3);
        shapes?.ring(x, y, 12, reach * 0.7, 0.25, dust.r, dust.g, dust.b, 1, 0.45, 0.2);
        dustPuffs(x, y, 10, 10, 220, 0.32, dust, a, 0.55);
        break;
      }
      case 'DASH':
        dustPuffs(x, y, 7, 9, 90, 0.35, dust, f ? f.facing + Math.PI : 0, 0.5);
        break;
      case 'SHADOWSTEP':
        tint.r = 0.03;
        tint.g = 0.02;
        tint.b = 0.05;
        dustPuffs(x, y, 9, 14, 60, 0.55, tint);
        if (f) dustPuffs(f.pos.x, f.pos.y, 6, 12, 50, 0.5, tint);
        break;
      case 'BLOODRAGE':
        shapes?.ring(x, y, 10, 70, 0.4, 1, 0.12, 0.08, 3, 0, 0.2);
        mist(x, y, 0, 6, 20);
        break;
    }
  }

  function onFootstep(ev: Extract<GameEvent, { type: 'footstep' }>, state: WorldState, live: boolean): void {
    const f = findFighter(state, ev.fighterId);
    const r = f ? f.radius : 18;
    const moving = f && Math.hypot(f.vel.x, f.vel.y) > 0.05;
    const heading = f ? (moving ? Math.atan2(f.vel.y, f.vel.x) : f.facing) : 0;
    const side = boots.nextFoot(ev.fighterId);
    const px = -Math.sin(heading);
    const py = Math.cos(heading);
    const fx = ev.pos.x + px * side * r * 0.32 + Math.cos(heading) * 2;
    const fy = ev.pos.y + py * side * r * 0.32 + Math.sin(heading) * 2;
    const strength = boots.step(ev.fighterId, grid, fx, fy, ev.bloody);
    if (strength > 0 && gpu) {
      bloodColor(col, 0.45 + 0.3 * strength);
      const s = r / 18;
      gpu.decals.stamp(DECAL.print, fx, fy, heading + spread() * 0.05, 7 * s, 4 * s, col.r, col.g, col.b, 0.25 + 0.5 * strength, 0);
    }
    if (live) dustPuffs(fx, fy, 2, 5, 22, 0.16, dust, heading + Math.PI, 0.9);
  }

  function onPropBreak(ev: Extract<GameEvent, { type: 'prop_break' }>): void {
    const x = ev.pos.x;
    const y = ev.pos.y;
    if (ev.kind === 'amphora') {
      tint.r = 0.45;
      tint.g = 0.16;
      tint.b = 0.07;
      debris(x, y, 16, 260, tint, 3.2, 1.8);
      tint.r = 0.25;
      tint.g = 0.6;
      tint.b = 0.08;
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = rnd(30, 160);
        particle(PK.mist, x, y, rnd(4, 12), Math.cos(a) * s, Math.sin(a) * s, rnd(0, 30), rnd(8, 16), rnd(0.4, 0.8), tint, 0.4);
      }
    } else if (ev.kind === 'crate') {
      tint.r = 0.32;
      tint.g = 0.19;
      tint.b = 0.09;
      debris(x, y, 20, 300, tint, 3.6, 2);
      dustPuffs(x, y, 8, 14, 90, 0.35);
    }
  }

  /** Power-up colours (linear) for pickup rings. */
  function pickupColor(kind: string): Rgb {
    if (kind === 'berserk') {
      tint.r = 1;
      tint.g = 0.18;
      tint.b = 0.1;
    } else if (kind === 'haste') {
      tint.r = 0.35;
      tint.g = 0.85;
      tint.b = 1;
    } else {
      tint.r = 0.85;
      tint.g = 0.8;
      tint.b = 0.7;
    }
    return tint;
  }

  function syncHelmets(state: WorldState): void {
    for (const f of state.fighters) {
      const prev = helmetOn.get(f.id);
      if (prev === undefined) {
        helmetOn.set(f.id, f.helmet);
        continue;
      }
      if (prev && !f.helmet) {
        if (f.alive) popHelmet(f, lastHitDir.get(f.id) ?? Math.random() * Math.PI * 2, true);
        helmetOn.set(f.id, false);
      } else if (!prev && f.helmet) {
        helmetOn.set(f.id, true);
      }
    }
  }

  /** Colour-coded trails: particles shed behind every projectile in flight, in its type's colour. */
  function trails(state: WorldState, dt: number, alpha: number): void {
    if (dt <= 0) return;
    const ticks = dt * 60;
    for (const p of state.projectiles) {
      if (!isProjectileWeapon(p.weapon)) continue;
      const k = TRAIL_RATE[p.weapon] * dt;
      const n = Math.floor(k) + (Math.random() < k - Math.floor(k) ? 1 : 0);
      if (n === 0) continue;
      const c = p.weapon === 'ARCANE_STAFF' ? spell(state, p.ownerId) : projectileColor(pcol, p.weapon, null);
      const x0 = p.pos.x - p.vel.x * (1 - alpha);
      const y0 = p.pos.y - p.vel.y * (1 - alpha);
      for (let i = 0; i < n; i++) {
        const back = Math.random() * ticks;
        const x = x0 - p.vel.x * back;
        const y = y0 - p.vel.y * back;
        if (p.weapon === 'ARCANE_STAFF') {
          particle(PK.ember, x + rnd(-3, 3), y + rnd(-3, 3), rnd(16, 24), rnd(-25, 25), rnd(-25, 25), rnd(-10, 20), rnd(1.8, 3), rnd(0.25, 0.45), c, 1.6);
        } else if (p.weapon === 'THROWING_AXES') {
          particle(PK.ember, x + rnd(-6, 6), y + rnd(-6, 6), rnd(18, 24), rnd(-15, 15), rnd(-15, 15), 0, rnd(1.2, 1.8), rnd(0.1, 0.18), c, 1.2);
        } else {
          particle(PK.ember, x, y, rnd(18, 22), 0, 0, 0, rnd(1, 1.4), rnd(0.12, 0.2), c, 0.8);
        }
      }
    }
  }

  // ---- Lifecycle ------------------------------------------------------------------------------

  function teardown(): void {
    if (!gpu) return;
    gpu.root.removeFromParent();
    gpu.decals.dispose();
    gpu.particles.dispose();
    gpu.pieces.dispose();
    gpu.shapes.dispose();
    gpu.popups.dispose();
    gpu.numbers.dispose();
    gpu.atlas.dispose();
    gpu = null;
  }

  /** (Re)read the map from the live context: walls, floor dust, blood grid, popup bounds, decal space. */
  function applyMap(): void {
    if (!context) return;
    const map = context.map;
    walls = [...map.walls, ...map.pillars];
    dust = DUST_COLORS[map.floor];
    if (grid.cols !== Math.ceil(map.width / grid.cell) || grid.rows !== Math.ceil(map.height / grid.cell)) grid = new BloodGrid(map.width, map.height);
    gpu?.popups.setBounds(map.width, map.height);
    gpu?.decals.setFloorSize(context.floorSize);
  }

  function clearTransient(): void {
    applyMap();
    pieces.releaseAll();
    spurts.releaseAll();
    pools.releaseAll();
    fountains.releaseAll();
    grid.clear();
    boots.clear();
    helmetOn.clear();
    lastHitDir.clear();
    nextDrip.clear();
    projWeapon.clear();
    projOwner.clear();
    projDir.clear();
    spellOf.clear();
    if (!gpu) return;
    gpu.decals.clear(gpu.renderer);
    gpu.particles.clear();
    gpu.shapes.clear();
    gpu.popups.clear();
    gpu.numbers.clear();
    gpu.pieces.sync(pieces.items);
  }

  return {
    init(ctx: RenderContext) {
      teardown();
      const root = new THREE.Group();
      root.name = 'fx';
      const atlas = createPartAtlas();
      const decals = new DecalPainter(ctx.floorDecalTarget, ctx.floorSize);
      const particles = new GpuParticles(MAX_PARTICLES);
      decals.scene.add(particles.decalMesh);
      const pieceRender = new PieceRenderer(atlas, MAX_PIECES);
      const shapes = new Shapes();
      const popups = new Popups();
      const numbers = new DamageNumbers();
      root.add(particles.mesh, pieceRender.group, shapes.mesh, numbers.mesh, popups.group);
      ctx.scene.add(root);
      gpu = { renderer: ctx.renderer, camera: ctx.camera, root, atlas, decals, particles, pieces: pieceRender, shapes, popups, numbers };
      context = ctx;
      clearTransient();
    },

    onEvents(events: GameEvent[], state: WorldState) {
      if (!gpu) return;
      for (const ev of events) {
        const live = state.tick - ev.tick <= LIVE_EVENT_TICKS;
        switch (ev.type) {
          case 'hit':
            onHit(ev, state, live);
            break;
          case 'parry':
            if (live) onParry(ev);
            break;
          case 'projectile':
            projWeapon.set(ev.projectileId, ev.weapon);
            projOwner.set(ev.projectileId, ev.ownerId);
            projDir.set(ev.projectileId, ev.dir);
            break;
          case 'projectile_end':
            onProjectileEnd(ev, state, live);
            break;
          case 'dismember':
            onDismember(ev, state, live);
            break;
          case 'kill':
            onKill(ev, state, live);
            break;
          case 'explosion':
            onExplosion(ev, live);
            break;
          case 'skill':
            if (live) onSkill(ev, state);
            break;
          case 'footstep':
            onFootstep(ev, state, live);
            break;
          case 'prop_break':
            if (live) onPropBreak(ev);
            break;
          case 'bark': {
            if (!live || !barkShown(view.barks, ev.kind)) break;
            const f = findFighter(state, ev.fighterId);
            if (f) gpu.popups.bark(f.id, ev.text, f.color, f.pos.x, f.pos.y);
            break;
          }
          case 'heal':
            if (live) {
              gpu.shapes.ring(ev.pos.x, ev.pos.y, 8, 46, 0.5, 1, 0.82, 0.35, 2.2, 0, 0.14);
              gpu.shapes.flash(ev.pos.x, ev.pos.y, 26, 0.3, 1, 0.85, 0.45, 2);
            }
            break;
          case 'pickup':
            if (live) {
              const c = pickupColor(ev.kind);
              gpu.shapes.ring(ev.pos.x, ev.pos.y, 6, 40, 0.35, c.r, c.g, c.b, 2.5, 0, 0.14);
              gpu.shapes.flash(ev.pos.x, ev.pos.y, 24, 0.2, c.r, c.g, c.b, 2);
            }
            break;
          case 'pickup_spawn':
            if (live) {
              const c = pickupColor(ev.kind);
              gpu.shapes.ring(ev.pos.x, ev.pos.y, 40, 8, 0.45, c.r, c.g, c.b, 2.2, 0, 0.14);
              embers(ev.pos.x, ev.pos.y, 14, 90, c, 1.6, 0.8, 0.8);
            }
            break;
          case 'hazard':
            if (live) dustPuffs(ev.pos.x, ev.pos.y, 3, 8, 50, 0.25);
            break;
          case 'match_end':
          case 'sudden_death':
          case 'escalation':
          case 'judges_decision':
          case 'swing':
            break;
        }
      }
      syncHelmets(state);
    },

    setView(v: ViewSettings) {
      view = { ...v };
      amount = BLOOD_AMOUNT[view.blood] ?? BLOOD_AMOUNT.normal;
      if (!gpu) return;
      if (!view.damageNumbers) gpu.numbers.clear();
      if (view.barks === 'off') gpu.popups.clearBarks();
      if (!view.killStamps) gpu.popups.clearStamps();
    },

    update(frameDt: number, state: WorldState, alpha: number) {
      const g = gpu;
      if (!g) return;
      const dt = frameDt > 0 ? frameDt : 0;
      time += dt;
      grid.decay(dt);

      for (const s of spurts.items) {
        if (!s.active) continue;
        const f = findFighter(state, s.fighterId);
        if (!f) {
          s.active = false;
          continue;
        }
        spurtFighter = f;
        spurtLimb = s.limb;
        if (!spurtStep(s, dt, pulse)) s.active = false;
      }
      spurtFighter = null;

      for (const f of fountains.items) {
        if (!f.active) continue;
        fountainNow = f;
        if (!fountainStep(f, dt, erupt)) f.active = false;
      }
      fountainNow = null;

      // Stumps keep dripping a little, leaving a trail behind the maimed.
      if (dt > 0) {
        for (const f of state.fighters) {
          if (!f.alive || (f.limbs.armL && f.limbs.armR && f.limbs.legL && f.limbs.legR)) continue;
          const next = nextDrip.get(f.id) ?? 0;
          if (time < next) continue;
          nextDrip.set(f.id, time + rnd(0.3, 0.75) / amount.count);
          bloodStamp(DECAL.drop, f.pos.x + rnd(-0.5, 0.5) * f.radius, f.pos.y + rnd(-0.5, 0.5) * f.radius, Math.random() * 6.3, rnd(1.6, 3.2) * amount.size, rnd(1.5, 3) * amount.size, 0.7, 0.8, 1);
        }
      }

      for (const p of pools.items) {
        if (!p.active) continue;
        poolNow = p;
        if (!poolStep(p, dt, poolStamp)) p.active = false;
      }
      poolNow = null;

      for (const p of pieces.items) {
        if (!p.active || p.settled) continue;
        stepPiece(p, dt, walls, Math.random, sink);
        if (p.settled) ooze(p, true);
      }
      g.pieces.sync(pieces.items);

      trails(state, dt, alpha);
      g.particles.update(g.renderer, dt);
      g.particles.decalMesh.visible = g.particles.needsDecalPass;
      g.decals.render(g.renderer, g.particles.needsDecalPass, dt);

      // World units per CSS px, for popups and numbers that keep a constant size on screen.
      g.renderer.getSize(viewSize);
      const cam = g.camera;
      const visH = cam instanceof THREE.OrthographicCamera ? (cam.top - cam.bottom) / cam.zoom : context ? context.map.height : 1;
      const px = visH / Math.max(1, viewSize.y);

      g.shapes.update(dt);
      g.numbers.update(dt, state, px);
      g.popups.update(dt, state, g.camera, px, view.nameTags);
    },

    reset() {
      clearTransient();
    },

    dispose() {
      teardown();
      pieces.releaseAll();
      context = null;
    },
  };
}
