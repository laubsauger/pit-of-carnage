/**
 * Projectiles in flight: arrows (fletched in the shooter's colour), spinning axes and glowing
 * staff orbs that light the floor as they fly. An orb is a white-hot core in its caster's spell
 * colour (halo, trail and floor light), the same colour fx uses for its trail sparks and burst. A short additive streak behind each one shows
 * direction and speed at a glance. Arrows and axes throw small soft shadows away from the torches
 * (orbs are lights themselves).
 *
 * Interpolation: projectiles fly straight at constant velocity, so the position at `alpha`
 * between ticks is `pos - vel * (1 - alpha)`; no lookup into the previous state is needed.
 */

import * as THREE from 'three/webgpu';
import { LAYER_HEIGHT, hashString } from '../core';
import type { WorldState } from '../core';
import { affine, setFrame } from './affine';
import { PartBatch, colorOf, newStyle } from './cutout';
import { DynamicMesh } from './dynmesh';
import { spellColor } from './fx/impacts';
import type { Rgb } from './fx/palette';
import type { LightField } from './lightfield';
import { arrowGeometry, flyingAxeGeometry, orbGeometry } from './parts';
import { newShadowBar } from './shadows';
import type { ShadowLayer } from './shadows';
import type { QuadBatch } from './sprites';

const MAX_PROJECTILES = 96;
const H = LAYER_HEIGHT.air;
/** Flight height (world px) for shadows: about shoulder height. */
const FLIGHT_HEIGHT = 22;
/** Shadows of things in flight stay close to them, so a shot never reads as two. */
const SHADOW_MAX_OFFSET = 26;

export class ProjectileLayer {
  readonly group = new THREE.Group();
  private readonly arrows: PartBatch;
  private readonly axes: PartBatch;
  private readonly orbs: PartBatch;
  private readonly trails: DynamicMesh;
  private readonly style = newStyle();
  private readonly T = affine();
  private readonly owner = new THREE.Color();
  private ownerHex: string | null = null;
  private readonly spell: Rgb = { r: 0, g: 0, b: 0 };
  private readonly bar = newShadowBar();

  constructor(material: THREE.Material) {
    this.group.name = 'projectiles';
    this.arrows = new PartBatch('arrows', arrowGeometry(), material, MAX_PROJECTILES);
    this.axes = new PartBatch('flying-axes', flyingAxeGeometry(), material, MAX_PROJECTILES);
    this.orbs = new PartBatch('orbs', orbGeometry(), material, MAX_PROJECTILES);
    this.trails = new DynamicMesh('projectile-trails', MAX_PROJECTILES * 6, { additive: true, emissive: 1 });
    this.group.add(this.trails.mesh, this.arrows.mesh, this.axes.mesh, this.orbs.mesh);
    this.style.skin.setRGB(1, 1, 1);
  }

  update(state: WorldState, alpha: number, time: number, glow: QuadBatch, light: LightField, shadows: ShadowLayer): void {
    this.arrows.begin();
    this.axes.begin();
    this.orbs.begin();
    this.trails.begin();
    const st = this.style;
    const T = this.T;
    for (const p of state.projectiles) {
      const back = 1 - alpha;
      const x = p.pos.x - p.vel.x * back;
      const y = p.pos.y - p.vel.y * back;
      const speed = Math.hypot(p.vel.x, p.vel.y);
      const dir = Math.atan2(p.vel.y, p.vel.x);
      const ux = speed > 0 ? p.vel.x / speed : 1;
      const uy = speed > 0 ? p.vel.y / speed : 0;
      this.ownerColor(state, p.ownerId);
      st.team.copy(this.owner);
      switch (p.weapon) {
        case 'LONGBOW':
          this.arrows.push(setFrame(T, x, y, dir, 1.15), H, st);
          this.trails.line(x - ux * 14, y - uy * 14, x - ux * (14 + speed * 4), y - uy * (14 + speed * 4), 2.2, H - 0.5, 0.9, 0.9, 0.85, 0.5, 0);
          this.castShadow(shadows, x - ux * 17, y - uy * 17, x + ux * 19, y + uy * 19, 2.2);
          break;
        case 'THROWING_AXES': {
          const spin = time * 22 + (hashString(p.id) % 7);
          this.axes.push(setFrame(T, x, y, spin, 1.2), H, st);
          this.trails.line(x, y, x - ux * speed * 3.5, y - uy * speed * 3.5, 5, H - 0.5, 0.8, 0.8, 0.8, 0.25, 0);
          // The spinning axe as a short bar along its haft.
          const cs = Math.cos(spin) * 12;
          const sn = Math.sin(spin) * 12;
          this.castShadow(shadows, x - cs, y - sn, x + cs, y + sn, 5);
          break;
        }
        case 'ARCANE_STAFF': {
          const c = spellColor(this.spell, this.ownerHex ?? '');
          const pulse = 1 + 0.12 * Math.sin(time * 30 + x * 0.1);
          this.orbs.push(setFrame(T, x, y, time * 6, pulse), H, st, 1.2);
          this.trails.line(x, y, x - ux * speed * 6, y - uy * speed * 6, 10, H - 0.5, c.r, c.g, c.b, 0.6, 0);
          const k = glow.push(setFrame(T, x, y, 0, 70 * pulse), H + 0.5);
          if (k >= 0) {
            glow.data[k] = c.r * 1.3;
            glow.data[k + 1] = c.g * 1.3;
            glow.data[k + 2] = c.b * 1.3;
            glow.data[k + 4] = 0.22;
          }
          light.frameLight(x, y, 130, c.r * 1.6, c.g * 1.6, c.b * 1.6);
          break;
        }
        default:
          this.arrows.push(setFrame(T, x, y, dir, 1), H, st);
      }
    }
    this.arrows.end();
    this.axes.end();
    this.orbs.end();
    this.trails.end();
  }

  private castShadow(shadows: ShadowLayer, ax: number, ay: number, bx: number, by: number, r: number): void {
    const b = this.bar;
    b.ax = ax;
    b.ay = ay;
    b.bx = bx;
    b.by = by;
    b.r = r;
    b.h = FLIGHT_HEIGHT;
    b.on = true;
    shadows.flying(b, SHADOW_MAX_OFFSET);
  }

  private ownerColor(state: WorldState, ownerId: string): void {
    this.owner.setRGB(0.8, 0.8, 0.8);
    this.ownerHex = null;
    for (const f of state.fighters) {
      if (f.id === ownerId) {
        this.owner.copy(colorOf(f.color));
        this.ownerHex = f.color;
        return;
      }
    }
  }

  dispose(): void {
    this.arrows.dispose();
    this.axes.dispose();
    this.orbs.dispose();
    this.trails.dispose();
  }
}
