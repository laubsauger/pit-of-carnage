/**
 * Fighter layer: rigs every fighter from the interpolated sim state into instanced cut-out parts.
 *
 * One InstancedMesh per part kind (boots, torso, heads, each headgear, each weapon...), so 16
 * fighters cost the same ~35 draw calls as 2. All per-frame work writes into preallocated arrays.
 * Also keeps the displayed position of each fighter (camera, picking, tags) and one anchor
 * Object3D per fighter for the fx module (`fighterVisual(id)`).
 *
 * Local hit weight (the camera stays calm on ordinary hits): a blow freezes the victim and a melee
 * attacker for a few frames (the attacker on the pose where its blow lands), the victim flashes
 * white, jolts along the blow and squashes, then both catch up with the live state in a quick
 * slide and the victim springs back. Every body and its weapon also throw soft shadows from the
 * lights around them.
 *
 * Acid hurts visibly: a fighter standing in a pool goes sickly green and sizzles (smoke puffs rise
 * off it), and the tint lingers a moment after it gets out. A caster's staff crystal glows in its
 * spell colour, the same colour as its orbs. Countdown beats ring every fighter in its colour.
 *
 * The winner's moment (`setVictors`): the winners raise their weapons and pump them in time with a
 * little hop, eyes wide, rings in their colour pulsing out from their feet. It runs on real time, so
 * it keeps going under the end card while the game clock stands still.
 */

import * as THREE from 'three/webgpu';
import { LAYER_HEIGHT, MAX_FIGHTERS, WEAPONS, hashString, hazardReach, muzzleSide } from '../core';
import type { AnimPhase, FighterState, HazardState, WeaponId, WorldState } from '../core';
import { affine, applyX, applyY, setChild, setFrame, setSpan } from './affine';
import type { Affine } from './affine';
import { PartBatch, newStyle } from './cutout';
import { DynamicMesh } from './dynmesh';
import { animProgress, isTeleport, lerpAngleShort, lerpPos, prevFighter } from './interp';
import {
  BOW_TIP_U, BOW_TIP_V, HEADGEAR, NOMINAL_RADIUS, armGeometry, barGeometry, bootGeometry, capeGeometry, eyesGeometry,
  guardArcGeometry, hairGeometry, handGeometry, headGeometry, headgearGeometry, nockedArrowGeometry, parryArcGeometry,
  pauldronGeometry, quiverGeometry, shieldGeometry, starsGeometry, stumpGeometry, tailsGeometry, torsoGeometry, weaponGeometry,
} from './parts';
import type { Headgear } from './parts';
import {
  eyeScale, flashAmount, hitStopSeconds, moveAmount, newWeaponPose, squashAmount, squashPeak, stride, victoryHop, victoryPose, victoryWeight, weaponPose,
} from './rig';
import type { WeaponPose } from './rig';
import { spellColor } from './fx/impacts';
import type { Rgb } from './fx/palette';
import { newShadowBar } from './shadows';
import type { ShadowLayer } from './shadows';
import { QuadBatch, smokeMaterial } from './sprites';

/** Base heights (three Y) of each part inside the fighter band. */
const H = {
  decal: LAYER_HEIGHT.fighters - 1,
  boots: LAYER_HEIGHT.fighters,
  legStump: LAYER_HEIGHT.fighters + 0.4,
  cape: LAYER_HEIGHT.fighters + 0.8,
  quiver: LAYER_HEIGHT.fighters + 1.3,
  torso: LAYER_HEIGHT.fighters + 1.8,
  arms: LAYER_HEIGHT.fighters + 2.4,
  pauldrons: LAYER_HEIGHT.fighters + 2.9,
  shield: LAYER_HEIGHT.fighters + 3.4,
  weapon: LAYER_HEIGHT.fighters + 3.9,
  string: LAYER_HEIGHT.fighters + 4.4,
  nock: LAYER_HEIGHT.fighters + 4.7,
  hands: LAYER_HEIGHT.fighters + 5.2,
  head: LAYER_HEIGHT.fighters + 5.8,
  tails: LAYER_HEIGHT.fighters + 5.6,
  headgear: LAYER_HEIGHT.fighters + 6.4,
  eyes: LAYER_HEIGHT.fighters + 7.2,
  stars: LAYER_HEIGHT.fighters + 7.8,
  arcs: LAYER_HEIGHT.fighters + 8.3,
  smear: LAYER_HEIGHT.fighters + 3.7,
  sizzle: LAYER_HEIGHT.fighters + 9,
} as const;

const SKIN_TONES = ['#f1c7a5', '#e0ac83', '#c68863', '#a86b47', '#8a5434', '#6b3f27', '#f6d3b8', '#d29a73'];

const SHOULDER_V = 12.5;
/** Head and headgear scale: small enough that the team-colour shoulders always show. */
const HEAD_SCALE = 0.84;
const PIVOT_U = 3;
const PIVOT_V = 9;
const GRIP = 13;

/** Height of a standing body (world px at nominal size) for its shadow. */
const BODY_HEIGHT = 28;
/** Height the weapon is held at, for its shadow. */
const WEAPON_HEIGHT = 13;
const BODY_SHADOW_MAX = 130;
/** Weapon shadows stay close enough to join the body's (one cast far away reads as a dropped weapon). */
const WEAPON_SHADOW_MAX = 38;
/** Seconds a body takes to catch up with the live state after its hit-stop (a quick slide). */
const CATCH_UP = 0.07;
/** Seconds the extra white flash fades after the hit-stop. */
const FLASH_FADE = 0.12;
/** Acid tint: rises this fast (per game second) while in a pool, fades this fast after leaving it. */
const ACID_IN = 8;
const ACID_OUT = 1.1;
/** Smoke puffs rising off a fighter in acid at once. */
const SIZZLE_PUFFS = 4;
/** Real seconds a countdown ring takes to expand and fade. */
const BEAT_SECONDS = 0.6;
/** Victory rings per second (one per hop, see rig.ts VICTORY.pumpHz). */
const VICTORY_RINGS_HZ = 0.8;

/** Each weapon as a shadow bar in its own frame: u0, v0, u1, v1, radius. */
const WEAPON_BAR: Readonly<Record<WeaponId, readonly [number, number, number, number, number]>> = {
  GREATSWORD: [-6, 0, 64, 0, 3.5],
  WARHAMMER: [-8, 0, 58, 0, 5.5],
  TWIN_DAGGERS: [-4, 0, 27, 0, 2.5],
  THROWING_AXES: [-4, 0, 22, 7, 4.5],
  LONGBOW: [BOW_TIP_U, -BOW_TIP_V, BOW_TIP_U, BOW_TIP_V, 2.5],
  ARCANE_STAFF: [-16, 0, 56, 0, 3],
};

type Hand = { u: number; v: number; on: boolean };

export class FighterLayer {
  readonly group = new THREE.Group();
  /** Interpolated body state per roster slot (valid for the first `count` slots). */
  readonly xs = new Float32Array(MAX_FIGHTERS);
  readonly ys = new Float32Array(MAX_FIGHTERS);
  readonly rs = new Float32Array(MAX_FIGHTERS);
  readonly facings = new Float32Array(MAX_FIGHTERS);
  readonly heads = new Float32Array(MAX_FIGHTERS);
  readonly walks = new Float32Array(MAX_FIGHTERS);
  readonly alive = new Uint8Array(MAX_FIGHTERS);
  readonly ids: string[] = [];
  readonly names: string[] = [];
  readonly colors: string[] = [];
  count = 0;
  /** Bumped whenever the roster (ids, names, colours) changes. */
  rosterVersion = 0;

  private readonly anchors = new Map<string, THREE.Group>();
  private readonly teamColors: THREE.Color[] = [];
  private readonly skinColors: THREE.Color[] = [];
  private readonly seeds = new Float32Array(MAX_FIGHTERS);
  private readonly shadowSmooth = new Float32Array(MAX_FIGHTERS);

  // Local hit weight per roster slot (game seconds).
  private readonly stopLeft = new Float32Array(MAX_FIGHTERS);
  private readonly catchLeft = new Float32Array(MAX_FIGHTERS);
  private readonly fzX = new Float32Array(MAX_FIGHTERS);
  private readonly fzY = new Float32Array(MAX_FIGHTERS);
  private readonly fzFacing = new Float32Array(MAX_FIGHTERS);
  private readonly fzHead = new Float32Array(MAX_FIGHTERS);
  private readonly fzWalk = new Float32Array(MAX_FIGHTERS);
  private readonly fzPhase: AnimPhase[] = [];
  private readonly fzProg = new Float32Array(MAX_FIGHTERS);
  /** Weapon phase and progress on screen last frame (what a new hit-stop freezes). */
  private readonly shownPhase: AnimPhase[] = [];
  private readonly shownProg = new Float32Array(MAX_FIGHTERS);
  private readonly jolt = new Float32Array(MAX_FIGHTERS);
  private readonly hitDir = new Float32Array(MAX_FIGHTERS);
  private readonly squashAge = new Float32Array(MAX_FIGHTERS);
  private readonly squashTop = new Float32Array(MAX_FIGHTERS);
  private readonly flash = new Float32Array(MAX_FIGHTERS);
  /** How soaked in acid each fighter looks, 0..1 (eased, lingers after leaving the pool). */
  private readonly acid = new Float32Array(MAX_FIGHTERS);
  /** Real seconds since the last countdown beat, and how big it was. */
  private beatAge = 99;
  private beatPower = 0;
  /** Weight of the frozen pose for the fighter being rigged (1 = frozen, 0 = live). */
  private poseBlend = 0;
  /** The winners striking their victory pose (empty = nobody), and real seconds into it. */
  private victors: readonly string[] = [];
  private victoryTime = 0;
  /** Victory weight of the fighter being rigged (0 = not a winner). */
  private cheer = 0;

  private readonly decals: QuadBatch;
  private readonly sizzle: QuadBatch;
  private readonly smears: DynamicMesh;
  private readonly boots: PartBatch;
  private readonly stumps: PartBatch;
  private readonly cape: PartBatch;
  private readonly quiver: PartBatch;
  private readonly torso: PartBatch;
  private readonly arms: PartBatch;
  private readonly pauldrons: PartBatch;
  private readonly hands: PartBatch;
  private readonly head: PartBatch;
  private readonly hair: PartBatch;
  private readonly tails: PartBatch;
  private readonly headgear: Record<Headgear, PartBatch>;
  private readonly eyes: { normal: PartBatch; angry: PartBatch; dizzy: PartBatch; sly: PartBatch };
  private readonly stars: PartBatch;
  private readonly greatsword: PartBatch;
  private readonly warhammer: PartBatch;
  private readonly dagger: PartBatch;
  private readonly axe: PartBatch;
  private readonly bow: PartBatch;
  private readonly string: PartBatch;
  private readonly nock: PartBatch;
  private readonly staff: PartBatch;
  private readonly shield: PartBatch;
  private readonly parryArc: PartBatch;
  private readonly guardArc: PartBatch;
  private readonly all: PartBatch[];
  /** Staff orb halos are drawn by the glow batch owned by the renderer (shared with projectiles). */
  private readonly glowSink: (x: number, y: number, size: number, r: number, g: number, b: number) => void;

  private readonly style = newStyle();
  private readonly spell: Rgb = { r: 1, g: 1, b: 1 };
  private readonly team = new THREE.Color();
  private readonly pose = newWeaponPose();
  private readonly idlePose = newWeaponPose();
  private readonly frozenPose = newWeaponPose();
  private readonly cheerPose = newWeaponPose();
  private readonly shadows: ShadowLayer;
  private readonly held = newShadowBar();
  private readonly lastPhase: AnimPhase[] = [];
  private readonly leftHand = new Uint8Array(MAX_FIGHTERS);
  private readonly B = affine();
  private readonly T = affine();
  private readonly W = affine();
  private readonly HD = affine();
  private readonly rh: Hand = { u: 0, v: 0, on: false };
  private readonly lh: Hand = { u: 0, v: 0, on: false };

  constructor(material: THREE.Material, decalMaterial: THREE.Material, glowSink: FighterLayer['glowSink'], shadows: ShadowLayer) {
    this.group.name = 'fighters';
    this.glowSink = glowSink;
    this.shadows = shadows;
    const n = MAX_FIGHTERS;
    const mk = (name: string, g: THREE.BufferGeometry, cap = n) => new PartBatch(name, g, material, cap);
    this.decals = new QuadBatch('fighter-decals', decalMaterial, n);
    this.decals.mesh.renderOrder = 1;
    this.sizzle = new QuadBatch('acid-sizzle', smokeMaterial(), n * SIZZLE_PUFFS);
    this.sizzle.mesh.renderOrder = 7;
    this.smears = new DynamicMesh('strike-smears', n * 20 * 6, { additive: true, emissive: 0.45 });
    this.boots = mk('boots', bootGeometry(), n * 2);
    this.stumps = mk('stumps', stumpGeometry(), n * 4);
    this.cape = mk('cape', capeGeometry());
    this.quiver = mk('quiver', quiverGeometry());
    this.torso = mk('torso', torsoGeometry());
    this.arms = mk('arms', armGeometry(), n * 2);
    this.pauldrons = mk('pauldrons', pauldronGeometry(), n * 2);
    this.hands = mk('hands', handGeometry(), n * 2);
    this.head = mk('head', headGeometry());
    this.hair = mk('hair', hairGeometry());
    this.tails = mk('cowl-tails', tailsGeometry());
    this.headgear = {
      knight: mk('helm-knight', headgearGeometry('knight')),
      horned: mk('helm-horned', headgearGeometry('horned')),
      cowl: mk('helm-cowl', headgearGeometry('cowl')),
      viking: mk('helm-viking', headgearGeometry('viking')),
      hood: mk('helm-hood', headgearGeometry('hood')),
      wizard: mk('helm-wizard', headgearGeometry('wizard')),
    };
    this.eyes = {
      normal: mk('eyes', eyesGeometry('normal')),
      angry: mk('eyes-angry', eyesGeometry('angry')),
      dizzy: mk('eyes-dizzy', eyesGeometry('dizzy')),
      sly: mk('eyes-sly', eyesGeometry('sly')),
    };
    this.stars = mk('stun-stars', starsGeometry());
    this.greatsword = mk('greatsword', weaponGeometry('greatsword'));
    this.warhammer = mk('warhammer', weaponGeometry('warhammer'));
    this.dagger = mk('dagger', weaponGeometry('dagger'), n * 2);
    this.axe = mk('axe', weaponGeometry('axe'), n * 2);
    this.bow = mk('bow', weaponGeometry('bow'));
    this.string = mk('bowstring', barGeometry(1.2, 0xeae3d0, 0, 0.6), n * 2);
    this.nock = mk('nocked-arrow', nockedArrowGeometry());
    this.staff = mk('staff', weaponGeometry('staff'));
    this.shield = mk('shield', shieldGeometry());
    this.parryArc = mk('parry-arc', parryArcGeometry());
    this.guardArc = mk('guard-arc', guardArcGeometry());
    this.all = [
      this.boots, this.stumps, this.cape, this.quiver, this.torso, this.arms, this.pauldrons, this.hands, this.head,
      this.hair, this.tails, ...Object.values(this.headgear), ...Object.values(this.eyes), this.stars, this.greatsword,
      this.warhammer, this.dagger, this.axe, this.bow, this.string, this.nock, this.staff, this.shield, this.parryArc,
      this.guardArc,
    ];
    this.group.add(this.decals.mesh, this.sizzle.mesh, this.smears.mesh, ...this.all.map((b) => b.mesh));
    for (let i = 0; i < MAX_FIGHTERS; i++) {
      this.teamColors.push(new THREE.Color());
      this.skinColors.push(new THREE.Color());
      this.fzPhase.push('idle');
      this.shownPhase.push('idle');
    }
  }

  /** Anchor object of a fighter (follows its interpolated position and facing), or null. */
  visual(id: string): THREE.Object3D | null {
    return this.anchors.get(id) ?? null;
  }

  /** Team colour (linear) of roster slot i. */
  teamColor(i: number): THREE.Color {
    return this.teamColors[i]!;
  }

  /** Index of a fighter id in the current roster, or -1. */
  indexOf(id: string | null): number {
    if (id === null) return -1;
    for (let i = 0; i < this.count; i++) if (this.ids[i] === id) return i;
    return -1;
  }

  /**
   * A blow landed (live events only): `severity` 0..1 from `hitSeverity`. Freezes the victim (it
   * jolts along `dir` and squashes) and, when `attackerImpact` >= 0, the attacker on the strike pose
   * at that progress (melee). Pass a null attacker for ranged, hazard and keg hits.
   */
  hit(victimId: string, attackerId: string | null, dir: number, severity: number, attackerImpact: number): void {
    const stop = hitStopSeconds(severity);
    const v = this.indexOf(victimId);
    if (v >= 0 && this.alive[v]) {
      this.freeze(v, stop, -1);
      this.jolt[v] = 1.2 + 2.3 * severity;
      this.hitDir[v] = dir;
      this.squashTop[v] = Math.max(squashPeak(severity), this.squashAge[v] < 0 ? this.squashTop[v] : 0);
      this.squashAge[v] = -this.stopLeft[v];
      this.flash[v] = 1;
    }
    const a = this.indexOf(attackerId);
    if (a >= 0 && a !== v && this.alive[a]) this.freeze(a, stop, attackerImpact);
  }

  /** Light squash and flash without a hit-stop (hazard ticks: saws, acid). */
  nudge(victimId: string, dir: number, severity: number): void {
    const v = this.indexOf(victimId);
    if (v < 0 || !this.alive[v] || this.squashAge[v] < 0) return;
    this.hitDir[v] = dir;
    this.squashTop[v] = squashPeak(severity) * 0.6;
    this.squashAge[v] = 0;
    this.flash[v] = Math.max(this.flash[v]!, 0.6);
  }

  /** Forget hit-stops, squashes, acid and countdown rings (new match or seek). */
  resetHits(): void {
    this.stopLeft.fill(0);
    this.catchLeft.fill(0);
    this.squashTop.fill(0);
    this.squashAge.fill(0);
    this.flash.fill(0);
    this.acid.fill(0);
    this.beatAge = 99;
    this.victors = [];
  }

  /** A countdown beat (3, 2, 1, FIGHT): every living fighter rings in its colour. `power` ~1 per beat. */
  beat(power: number): void {
    this.beatAge = 0;
    this.beatPower = power;
  }

  /** Advance the countdown rings and the victory pose by real seconds (the sim holds still meanwhile). */
  tickBeat(realDt: number): void {
    const dt = Math.max(0, realDt);
    this.beatAge += dt;
    this.victoryTime += dt;
  }

  /**
   * The winners strike their victory pose (an empty list ends it). `instant`: already in full pose
   * (a seek onto the end card), else they ease into it.
   */
  setVictors(ids: readonly string[], instant: boolean): void {
    const same = ids.length === this.victors.length && ids.every((id, k) => this.victors[k] === id);
    if (same && ids.length > 0) return;
    this.victors = ids.slice();
    this.victoryTime = instant ? 10 : 0;
  }

  /** The winners striking their pose now (empty when there is no victory moment). */
  get victorIds(): readonly string[] {
    return this.victors;
  }

  private freeze(i: number, stop: number, impact: number): void {
    if (this.stopLeft[i]! <= 0) {
      // Freeze what is on screen right now, so the stop itself never jumps.
      this.fzX[i] = this.xs[i]!;
      this.fzY[i] = this.ys[i]!;
      this.fzFacing[i] = this.facings[i]!;
      this.fzHead[i] = this.heads[i]!;
      this.fzWalk[i] = this.walks[i]!;
      this.fzPhase[i] = this.shownPhase[i]!;
      this.fzProg[i] = this.shownProg[i]!;
    }
    if (impact >= 0) {
      this.fzPhase[i] = 'strike';
      this.fzProg[i] = impact;
    }
    this.stopLeft[i] = Math.max(this.stopLeft[i]!, stop);
    this.catchLeft[i] = 0;
  }

  update(prev: WorldState, curr: WorldState, alpha: number, time: number, gameDt: number, selectedId: string | null, hoveredId: string | null): void {
    this.syncRoster(curr.fighters);
    for (const b of this.all) b.begin();
    this.decals.begin();
    this.sizzle.begin();
    this.smears.begin();
    const fighters = curr.fighters;
    const n = Math.min(fighters.length, MAX_FIGHTERS);
    this.count = n;
    for (let i = 0; i < n; i++) {
      const f = fighters[i]!;
      const p = prevFighter(prev.fighters, f, i);
      const snap = isTeleport(p, f);
      let x = lerpPos(p.pos.x, f.pos.x, alpha, snap);
      let y = lerpPos(p.pos.y, f.pos.y, alpha, snap);
      let facing = snap ? f.facing : lerpAngleShort(p.facing, f.facing, alpha);
      let head = snap ? f.headAngle : lerpAngleShort(p.headAngle, f.headAngle, alpha);
      let walk = lerpAngleShort(p.walkPhase, f.walkPhase, alpha);

      // Local hit-stop: hold the frozen pose, then slide back to the live one.
      let blend = 0;
      if (this.stopLeft[i]! > 0) {
        blend = 1;
        this.stopLeft[i] = this.stopLeft[i]! - gameDt;
        if (this.stopLeft[i]! <= 0) {
          this.stopLeft[i] = 0;
          this.catchLeft[i] = CATCH_UP;
        }
      } else if (this.catchLeft[i]! > 0) {
        this.catchLeft[i] = Math.max(0, this.catchLeft[i]! - gameDt);
        const t = this.catchLeft[i]! / CATCH_UP;
        blend = t * t;
      }
      if (blend > 0 && f.alive) {
        x += (this.fzX[i]! - x) * blend;
        y += (this.fzY[i]! - y) * blend;
        facing = lerpAngleShort(facing, this.fzFacing[i]!, blend);
        head = lerpAngleShort(head, this.fzHead[i]!, blend);
        walk += (this.fzWalk[i]! - walk) * blend;
      }
      this.poseBlend = blend;
      const soaked = f.alive && inAcid(f.pos.x, f.pos.y, f.radius, curr.hazards);
      this.acid[i] = soaked ? Math.min(1, this.acid[i]! + gameDt * ACID_IN) : Math.max(0, this.acid[i]! - gameDt * ACID_OUT);
      if (this.squashTop[i]! > 0) {
        this.squashAge[i] = this.squashAge[i]! + gameDt;
        if (this.squashAge[i]! >= 1) this.squashTop[i] = 0;
      }
      if (this.stopLeft[i]! <= 0) this.flash[i] = Math.max(0, this.flash[i]! - gameDt / FLASH_FADE);

      this.xs[i] = x;
      this.ys[i] = y;
      this.rs[i] = f.radius;
      this.facings[i] = facing;
      this.heads[i] = head;
      this.walks[i] = walk;
      this.alive[i] = f.alive ? 1 : 0;
      const anchor = this.anchors.get(f.id);
      if (anchor) {
        anchor.position.set(x, LAYER_HEIGHT.fighters, y);
        anchor.rotation.y = -facing;
        anchor.visible = f.alive;
      }
      if (!f.alive) continue;
      // The victim jolts along the blow while it is frozen (the shake stays on the body, not the camera).
      let jx = 0;
      let jy = 0;
      if (this.stopLeft[i]! > 0 && this.squashAge[i]! < 0) {
        const j = this.jolt[i]! * Math.sin(time * 113);
        jx = Math.cos(this.hitDir[i]!) * j;
        jy = Math.sin(this.hitDir[i]!) * j;
      }
      this.rigFighter(i, f, x + jx, y + jy, facing, head, walk, alpha, time, f.id === selectedId, f.id === hoveredId);
    }
    for (const b of this.all) b.end();
    this.decals.end();
    this.sizzle.end();
    this.smears.end();
  }

  private rosterChanged(fighters: readonly FighterState[]): boolean {
    const n = Math.min(fighters.length, MAX_FIGHTERS);
    if (n !== this.ids.length) return true;
    for (let i = 0; i < n; i++) {
      const f = fighters[i]!;
      if (f.id !== this.ids[i] || f.name !== this.names[i] || f.color !== this.colors[i]) return true;
    }
    return false;
  }

  private syncRoster(fighters: readonly FighterState[]): void {
    if (!this.rosterChanged(fighters)) return;
    this.rosterVersion++;
    this.ids.length = 0;
    this.names.length = 0;
    this.colors.length = 0;
    const keep = new Set<string>();
    fighters.slice(0, MAX_FIGHTERS).forEach((f, i) => {
      this.ids.push(f.id);
      this.names.push(f.name);
      this.colors.push(f.color);
      keep.add(f.id);
      this.teamColors[i]!.set(f.color);
      const h = hashString(f.name);
      this.skinColors[i]!.set(SKIN_TONES[h % SKIN_TONES.length]!);
      this.seeds[i] = (h % 1000) / 159.2;
      this.shadowSmooth[i] = f.inShadow ? 1 : 0;
      this.leftHand[i] = 0;
      this.lastPhase[i] = 'idle';
      this.stopLeft[i] = 0;
      this.catchLeft[i] = 0;
      this.squashTop[i] = 0;
      this.flash[i] = 0;
      if (!this.anchors.has(f.id)) {
        const g = new THREE.Group();
        g.name = `fighter:${f.id}`;
        this.anchors.set(f.id, g);
        this.group.add(g);
      }
      this.anchors.get(f.id)!.userData = { radius: f.radius, color: f.color, name: f.name };
    });
    for (const [id, g] of this.anchors) {
      if (keep.has(id)) continue;
      this.group.remove(g);
      this.anchors.delete(id);
    }
  }

  private rigFighter(i: number, f: FighterState, x: number, y: number, facing: number, headAngle: number, walk: number, alpha: number, time: number, selected: boolean, hovered: boolean): void {
    const st = this.style;
    const seed = this.seeds[i]!;
    st.team.copy(this.teamColors[i]!);
    st.skin.copy(this.skinColors[i]!);
    st.flash = Math.max(flashAmount(f.hitFlash), this.flash[i]!);
    this.shadowSmooth[i] = this.shadowSmooth[i]! + ((f.inShadow ? 1 : 0) - this.shadowSmooth[i]!) * 0.12;
    st.shadow = this.shadowSmooth[i]!;
    st.berserk = f.buffs.berserk > 0 ? 1 : 0;
    st.glow = 0;
    st.acid = this.acid[i]!;

    const s = f.radius / NOMINAL_RADIUS;
    const speed = Math.hypot(f.vel.x, f.vel.y);
    const move = moveAmount(speed);
    const legless = !f.limbs.legL || !f.limbs.legR;
    const hop = legless ? Math.abs(Math.sin(walk)) * move : 0;
    this.cheer = this.victors.includes(f.id) ? victoryWeight(this.victoryTime) : 0;
    const cheerHop = this.cheer > 0 ? 1 + (victoryHop(this.victoryTime) - 1) * this.cheer : 1;
    const B = setFrame(this.B, x, y, facing, s * (1 + 0.08 * hop) * cheerHop);
    if (this.squashTop[i]! > 0) squashFrame(B, this.hitDir[i]!, squashAmount(this.squashAge[i]!, this.squashTop[i]!));
    const T = this.T;

    // Ground decal: contact shadow, team ring, selection and buff markers.
    const half = f.radius * 1.55;
    const k = this.decals.push(setFrame(T, x, y, 0, half * 2), H.decal);
    if (k >= 0) {
      const d = this.decals.data;
      d[k] = st.team.r;
      d[k + 1] = st.team.g;
      d[k + 2] = st.team.b;
      d[k + 3] = (f.radius + 3.5) / half;
      d[k + 4] = selected ? 1 : 0;
      const beat = this.beatAge < BEAT_SECONDS ? (1 - this.beatAge / BEAT_SECONDS) * Math.min(1, this.beatPower) : 0;
      d[k + 5] = hovered && !selected ? 1 : beat;
      d[k + 6] = f.buffs.haste > 0 ? 1 : 0;
      d[k + 7] = f.buffs.slow > 0 ? 1 : 0;
      d[k + 8] = 1;
      d[k + 9] = st.berserk;
      d[k + 10] = 1;
      d[k + 11] = seed;
    }

    // Legs.
    const sd = stride(walk, move);
    if (f.limbs.legL) this.boots.push(setChild(T, B, sd, -6.6, 0, 1, 1), H.boots, st);
    else this.stumps.push(setChild(T, B, 0, -6.6, 0, 1, 1), H.legStump, st);
    if (f.limbs.legR) this.boots.push(setChild(T, B, -sd, 6.6, 0, 1, 1), H.boots, st);
    else this.stumps.push(setChild(T, B, 0, 6.6, 0, 1, 1), H.legStump, st);

    // Cape flutters faster and longer with speed.
    const wob = Math.sin(time * (3.2 + speed * 2.4) + seed) * (0.05 + 0.07 * move);
    this.cape.push(setChild(T, B, -3, 0, wob, 1 + Math.min(0.28, speed * 0.1), 1), H.cape, st);
    if (f.weapon === 'LONGBOW') this.quiver.push(B, H.quiver, st);

    const breathe = 1 + 0.025 * Math.sin(time * 2.3 + seed * 3);
    this.torso.push(setChild(T, B, 0, 0, 0, 1 / breathe, breathe), H.torso, st);

    // Weapon and hands.
    this.rigWeapon(i, f, alpha, time, seed, B);
    this.shadows.body(x, y, f.radius * 0.6, f.radius * 0.85, BODY_HEIGHT * s, BODY_SHADOW_MAX, this.held, WEAPON_SHADOW_MAX);

    // Arms from the shoulders to the hands; pauldrons over the shoulders.
    const armor = f.attributes.armor;
    const pScale = armor >= 14 ? 0.5 + (armor / 40) * 0.55 : 0;
    for (let side = -1; side <= 1; side += 2) {
      const hand = side < 0 ? this.lh : this.rh;
      const attached = side < 0 ? f.limbs.armL : f.limbs.armR;
      const sv = side * SHOULDER_V;
      if (!attached) {
        this.stumps.push(setChild(T, B, 0, sv, 0, 1, 1), H.pauldrons + 0.1, st);
        continue;
      }
      const hu = hand.on ? hand.u : 8;
      const hv = hand.on ? hand.v : side * 13;
      this.arms.push(setSpan(T, B, 0, sv, hu, hv, 1), H.arms, st);
      this.hands.push(setChild(T, B, hu, hv, 0, 1, 1), H.hands, st);
      if (pScale > 0) this.pauldrons.push(setChild(T, B, -1, side * (SHOULDER_V + 2), side * 0.15, pScale, side * pScale), H.pauldrons, st);
    }

    // Head: turns on its own (the vision cone follows the head).
    const HD = setChild(this.HD, B, 1.5, 0, headAngle - facing, HEAD_SCALE, HEAD_SCALE);
    this.head.push(HD, H.head, st);
    const gear = HEADGEAR[f.weapon];
    if (f.helmet) {
      this.headgear[gear].push(HD, H.headgear, st, 0.35);
      if (gear === 'cowl') {
        const tw = Math.sin(time * (4 + speed * 3) + seed) * (0.08 + 0.1 * move);
        this.tails.push(setChild(T, HD, -10.4, 0, tw, 1 + Math.min(0.3, speed * 0.12), 1), H.tails, st);
      }
    } else {
      this.hair.push(HD, H.headgear, st);
    }
    const es = eyeScale(f.eyePop) * (1 + 0.25 * this.cheer);
    const E = setChild(T, HD, 0, 0, 0, es, es);
    if (this.cheer > 0) {
      this.eyes.normal.push(E, H.eyes, st);
    } else if (f.stunTicks > 0) {
      this.eyes.dizzy.push(E, H.eyes, st);
      this.stars.push(setChild(this.W, HD, 0, 0, time * 4.5, 1, 1), H.stars, st, 0.6);
    } else if (f.anim.phase !== 'idle' || st.berserk > 0) {
      this.eyes.angry.push(E, H.eyes, st);
    } else if (f.stance === 'creep') {
      this.eyes.sly.push(E, H.eyes, st);
    } else {
      this.eyes.normal.push(E, H.eyes, st);
    }

    // Defensive markers: parry barrier (bright, blooms) and the guard-stance shield arc.
    if (f.parryTicks > 0) this.parryArc.push(B, H.arcs, st, 0.4 + 0.6 * Math.min(1, f.parryTicks / 10));
    else if (f.stance === 'guard' && WEAPONS[f.weapon].shield) this.guardArc.push(B, H.arcs, st);

    if (st.acid > 0.02) this.sizzlePuffs(x, y, f.radius, st.acid, time, seed);
    if (this.beatAge < BEAT_SECONDS) this.beatRing(x, y, f.radius, st.team, this.beatAge / BEAT_SECONDS, this.beatPower);
    if (this.cheer > 0) {
      // A ring in the winner's colour pulses out from its feet on every hop.
      const period = 1 / VICTORY_RINGS_HZ;
      this.beatRing(x, y, f.radius, st.team, (this.victoryTime % period) / period, 0.7 * this.cheer);
    }
  }

  /** Smoke rising off a fighter in acid: puffs on their own clocks, drifting and thinning as they rise. */
  private sizzlePuffs(x: number, y: number, radius: number, amount: number, time: number, seed: number): void {
    const T = this.T;
    for (let j = 0; j < SIZZLE_PUFFS; j++) {
      const age = (time * 1.15 + j / SIZZLE_PUFFS + seed * 0.37) % 1;
      const a = seed * 2.3 + j * 2.4;
      const px = x + Math.cos(a) * radius * 0.6 + age * 10;
      const py = y + Math.sin(a) * radius * 0.6 - age * 22;
      const k = this.sizzle.push(setFrame(T, px, py, a, radius * (0.9 + age * 1.6)), H.sizzle);
      if (k < 0) return;
      const d = this.sizzle.data;
      d[k] = 0.62;
      d[k + 1] = 0.72;
      d[k + 2] = 0.5;
      d[k + 3] = 0.42 * amount * Math.sin(Math.PI * age);
      d[k + 4] = seed + j * 1.7;
      d[k + 5] = age;
    }
  }

  /** A ring in the fighter's colour bursting out from its feet (`t` 0..1 through it): countdown beats, victory hops. */
  private beatRing(x: number, y: number, radius: number, team: THREE.Color, t: number, power: number): void {
    const ease = 1 - (1 - t) * (1 - t);
    const r = radius + 6 + ease * 34 * Math.max(1, power);
    const a = (1 - t) * (1 - t) * Math.min(1, power);
    const w = 2 + 4 * (1 - t);
    const segs = 28;
    const cr = 0.35 + team.r * 0.65;
    const cg = 0.35 + team.g * 0.65;
    const cb = 0.35 + team.b * 0.65;
    for (let k = 0; k < segs; k++) {
      const a0 = (k / segs) * Math.PI * 2;
      const a1 = ((k + 1) / segs) * Math.PI * 2;
      this.smears.line(x + Math.cos(a0) * r, y + Math.sin(a0) * r, x + Math.cos(a1) * r, y + Math.sin(a1) * r, w, H.decal + 0.2, cr, cg, cb, a);
    }
  }

  /** Pose the weapon, set hand targets (this.rh / this.lh in body coords) and push weapon parts. */
  private rigWeapon(i: number, f: FighterState, alpha: number, time: number, seed: number, B: Affine): void {
    const st = this.style;
    const T = this.T;
    const W = this.W;
    const rh = this.rh;
    const lh = this.lh;
    rh.on = false;
    lh.on = false;
    this.held.on = false;
    const live = f.anim.phase;
    // Dual wielders alternate hands: flip on every new windup (cosmetic, per fighter).
    if (live === 'windup' && this.lastPhase[i] !== 'windup') this.leftHand[i] = this.leftHand[i] ? 0 : 1;
    this.lastPhase[i] = live;
    // During a hit-stop the weapon holds its frozen pose (an attacker on the pose where its blow
    // lands), then blends back to the live animation.
    const b = this.poseBlend;
    let progress = animProgress(f, alpha);
    let pose = weaponPose(f.weapon, live, progress, time + seed, this.pose);
    let phase = live;
    if (b > 0) {
      const frozen = weaponPose(f.weapon, this.fzPhase[i]!, this.fzProg[i]!, time + seed, this.frozenPose);
      if (b >= 1) pose = frozen;
      else blendPose(pose, frozen, b);
      if (b >= 0.5) {
        phase = this.fzPhase[i]!;
        progress = this.fzProg[i]!;
      }
    }
    if (this.cheer > 0) {
      // The winner's pose: weapon raised and pumped. Both hands of a dual wielder join in.
      const cheer = victoryPose(f.weapon, this.victoryTime, this.cheerPose);
      if (this.cheer >= 1) pose = cheer;
      else blendPose(pose, cheer, this.cheer);
      phase = 'windup';
    }
    this.shownPhase[i] = phase;
    this.shownProg[i] = progress;
    const armR = f.limbs.armR;
    const armL = f.limbs.armL;
    const glow = pose.glow;

    let punch = false;
    switch (f.weapon) {
      case 'GREATSWORD': {
        if (!armR) {
          punch = armL;
          break;
        }
        const w = held(W, B, 1, pose.swing, pose.reach, false);
        this.greatsword.push(w, H.weapon, st, glow);
        this.holdBar(w, f.weapon);
        grab(B, rh, w, 1.2, 0);
        if (armL) grab(B, lh, w, -3.6, 0);
        this.smear(B, pose.smearFrom, pose.swing, pose.smear, 18, GRIP + 64 + pose.reach);
        break;
      }
      case 'WARHAMMER': {
        if (armR) {
          const w = held(W, B, 1, pose.swing, pose.reach, false);
          this.warhammer.push(w, H.weapon, st, glow);
          this.holdBar(w, f.weapon);
          grab(B, rh, w, -3.6, 0);
          this.smear(B, pose.smearFrom, pose.swing, pose.smear, 30, GRIP + 60 + pose.reach);
        } else {
          punch = armL;
        }
        if (armL) {
          const raised = f.stance === 'guard' || f.parryTicks > 0;
          const sh = raised ? setChild(T, B, 17, -4, 0, 1, 1) : setChild(T, B, 7, -15.5, -0.3, 1, 1);
          this.shield.push(sh, H.shield, st);
          grab(B, lh, sh, -2, 0);
        }
        break;
      }
      case 'TWIN_DAGGERS':
      case 'THROWING_AXES': {
        const isAxe = f.weapon === 'THROWING_AXES';
        // Out of axes: the sim punches, so show fists instead of empty-handed throws.
        if (isAxe && f.ammo <= 0 && phase !== 'idle') {
          punch = armR || armL;
          break;
        }
        const batch = isAxe ? this.axe : this.dagger;
        const idle = this.cheer > 0 ? pose : weaponPose(f.weapon, 'idle', 0, time + seed, this.idlePose);
        // The attacking hand: the alternating one, or whichever arm is left. Axes leave the hand the
        // sim throws from (core `muzzleSide`, shared with the sim's `muzzlePoint`).
        let attackSide = isAxe ? muzzleSide(f.weapon, f.ammo, armL) : this.leftHand[i] ? -1 : 1;
        if (attackSide > 0 && !armR) attackSide = -1;
        if (attackSide < 0 && !armL) attackSide = 1;
        for (let side = 1; side >= -1; side -= 2) {
          if (!(side > 0 ? armR : armL)) continue;
          const hand = side > 0 ? rh : lh;
          const attacking = phase !== 'idle' && side === attackSide;
          const pz = attacking ? pose : idle;
          // Axes in hand show the ammo left: the attacking hand holds the next one.
          const inHand = !isAxe || (attacking ? f.ammo >= 1 && !pz.released : f.ammo >= (phase !== 'idle' ? 2 : side > 0 ? 1 : 2));
          if (!inHand) {
            hand.u = 9 + (attacking ? pz.reach : 0);
            hand.v = side * 12;
            hand.on = true;
            continue;
          }
          const w = held(W, B, side, pz.swing, pz.reach, true);
          batch.push(w, H.weapon, st, attacking ? glow : 0);
          if (!this.held.on) this.holdBar(w, f.weapon);
          grab(B, hand, w, isAxe ? -0.5 : -1, 0);
        }
        break;
      }
      case 'LONGBOW': {
        if (!armL) {
          punch = armR;
          break;
        }
        const bu = 14 + pose.reach;
        const bowW = setChild(W, B, bu, -3, 0, 1, 1);
        this.bow.push(bowW, H.weapon, st, glow);
        this.holdBar(bowW, f.weapon);
        grab(B, lh, bowW, 0.5, 0);
        const tipU = bu + BOW_TIP_U;
        if (armR) {
          grab(B, rh, bowW, -1 - pose.draw * 14, 0);
          this.string.push(setSpan(T, B, tipU, -3 - BOW_TIP_V, rh.u, rh.v, 1), H.string, st);
          this.string.push(setSpan(T, B, tipU, -3 + BOW_TIP_V, rh.u, rh.v, 1), H.string, st);
          if (f.ammo > 0 && (phase === 'windup' || phase === 'idle')) {
            this.nock.push(setChild(T, B, rh.u, rh.v, 0, 1, 1), H.nock, st, glow);
          }
        } else {
          this.string.push(setSpan(T, B, tipU, -3 - BOW_TIP_V, tipU, -3 + BOW_TIP_V, 1), H.string, st);
        }
        break;
      }
      case 'ARCANE_STAFF': {
        if (!armR) {
          punch = armL;
          break;
        }
        const w = held(W, B, 1, pose.swing, pose.reach, false);
        // The crystal glows in the caster's spell colour (the staff has no team-coloured parts, so
        // the instance colour carries the spell colour for this one push).
        const c = spellColor(this.spell, f.color);
        this.team.copy(st.team);
        st.team.setRGB(c.r, c.g, c.b);
        this.staff.push(w, H.weapon, st, Math.max(glow, 0.25));
        st.team.copy(this.team);
        this.holdBar(w, f.weapon);
        grab(B, rh, w, 0, 0);
        if (armL) grab(B, lh, w, 11, 0);
        const charge = f.maxAmmo > 0 ? f.ammo / f.maxAmmo : 1;
        const k = (0.35 + 0.65 * charge) * (0.8 + glow * 1.6);
        const s = f.radius / NOMINAL_RADIUS;
        this.glowSink(applyX(w, 50.5, 0), applyY(w, 50.5, 0), (26 + glow * 26) * s, c.r * k, c.g * k, c.b * k);
        break;
      }
    }

    if (punch) {
      // Weapon arm gone: the other fist does the work.
      const p = phase === 'strike' ? Math.sin(Math.min(1, progress * 1.4) * Math.PI) : phase === 'windup' ? -0.3 : 0;
      const hand = armR ? rh : lh;
      const side = armR ? 1 : -1;
      hand.u = 11 + p * 12;
      hand.v = side * (9 - p * 5);
      hand.on = true;
    }
  }

  /** Record the weapon in frame `w` as this fighter's shadow bar (world coordinates). */
  private holdBar(w: Affine, weapon: WeaponId): void {
    const [u0, v0, u1, v1, r] = WEAPON_BAR[weapon];
    const h = this.held;
    h.ax = applyX(w, u0, v0);
    h.ay = applyY(w, u0, v0);
    h.bx = applyX(w, u1, v1);
    h.by = applyY(w, u1, v1);
    const s = Math.hypot(w.a, w.b);
    h.r = r * s;
    h.h = WEAPON_HEIGHT * s;
    h.on = true;
  }

  /** Strike smear: an additive arc in the team colour that trails the blade. */
  private smear(B: Affine, from: number, to: number, amount: number, inner: number, outer: number): void {
    if (amount <= 0.01) return;
    const segs = 14;
    const c = this.style.team;
    const r = 0.3 + c.r * 0.7;
    const g = 0.3 + c.g * 0.7;
    const b = 0.3 + c.b * 0.7;
    const span = to - from;
    for (let k = 0; k < segs; k++) {
      const t0 = k / segs;
      const t1 = (k + 1) / segs;
      const a0 = from + span * t0;
      const a1 = from + span * t1;
      const pu = PIVOT_U;
      const pv = PIVOT_V;
      const x0 = applyX(B, pu + Math.cos(a0) * inner, pv + Math.sin(a0) * inner);
      const y0 = applyY(B, pu + Math.cos(a0) * inner, pv + Math.sin(a0) * inner);
      const x1 = applyX(B, pu + Math.cos(a0) * outer, pv + Math.sin(a0) * outer);
      const y1 = applyY(B, pu + Math.cos(a0) * outer, pv + Math.sin(a0) * outer);
      const x2 = applyX(B, pu + Math.cos(a1) * inner, pv + Math.sin(a1) * inner);
      const y2 = applyY(B, pu + Math.cos(a1) * inner, pv + Math.sin(a1) * inner);
      const x3 = applyX(B, pu + Math.cos(a1) * outer, pv + Math.sin(a1) * outer);
      const y3 = applyY(B, pu + Math.cos(a1) * outer, pv + Math.sin(a1) * outer);
      this.smears.quad(x0, y0, x1, y1, x2, y2, x3, y3, H.smear, r, g, b, amount * t0 * t0 * 0.6, amount * t1 * t1 * 0.6);
    }
  }

  dispose(): void {
    for (const b of this.all) b.dispose();
    this.decals.dispose();
    this.sizzle.dispose();
    this.smears.dispose();
  }
}

/** Whether a fighter of `radius` standing at (x, y) is in an acid pool (where the sim's acid hurts it: core `hazardReach`). */
export function inAcid(x: number, y: number, radius: number, hazards: readonly HazardState[]): boolean {
  for (const h of hazards) {
    if (h.kind !== 'acid') continue;
    const reach = hazardReach(h, radius);
    if ((h.pos.x - x) ** 2 + (h.pos.y - y) ** 2 < reach * reach) return true;
  }
  return false;
}

/** Blend pose `a` toward `b` by `t` in place (hit-stop catch-up). */
function blendPose(a: WeaponPose, b: WeaponPose, t: number): void {
  a.swing += (b.swing - a.swing) * t;
  a.reach += (b.reach - a.reach) * t;
  a.draw += (b.draw - a.draw) * t;
  a.glow += (b.glow - a.glow) * t;
  a.smear += (b.smear - a.smear) * t;
  if (t >= 0.5) {
    a.smearFrom = b.smearFrom;
    a.released = b.released;
  }
}

/**
 * Squash frame B in place along world direction `dir`: `s` > 0 flattens the body along the blow
 * and widens it across (roughly keeping its area), `s` < 0 stretches it.
 */
function squashFrame(B: Affine, dir: number, s: number): void {
  const c = Math.cos(dir);
  const n = Math.sin(dir);
  const along = 1 - s;
  const across = 1 + 0.6 * s;
  const m11 = along * c * c + across * n * n;
  const m12 = (along - across) * c * n;
  const m22 = along * n * n + across * c * c;
  const a = B.a;
  const b = B.b;
  const cc = B.c;
  const d = B.d;
  B.a = m11 * a + m12 * b;
  B.b = m12 * a + m22 * b;
  B.c = m11 * cc + m12 * d;
  B.d = m12 * cc + m22 * d;
}

/** Weapon frame held on `side` (1 right, -1 left): pivot near the shoulder, grip GRIP + reach along `swing`. */
function held(out: Affine, B: Affine, side: number, swing: number, reach: number, mirror: boolean): Affine {
  const sw = side * swing;
  const du = Math.cos(sw) * (GRIP + reach);
  const dv = Math.sin(sw) * (GRIP + reach);
  return setChild(out, B, PIVOT_U + du, side * PIVOT_V + dv, sw, 1, mirror ? side : 1);
}

/** Put a hand on local point (u, v) of frame t (stored in body coordinates). */
function grab(B: Affine, hand: Hand, t: Affine, u: number, v: number): void {
  bodyLocal(B, applyX(t, u, v), applyY(t, u, v), hand);
}

/** Body-frame coordinates of world point (wx, wy) under body transform B, written into `out`. */
function bodyLocal(B: Affine, wx: number, wy: number, out: Hand): void {
  const det = B.a * B.d - B.b * B.c;
  const rx = wx - B.tx;
  const ry = wy - B.ty;
  out.u = (B.d * rx - B.c * ry) / det;
  out.v = (-B.b * rx + B.a * ry) / det;
  out.on = true;
}
