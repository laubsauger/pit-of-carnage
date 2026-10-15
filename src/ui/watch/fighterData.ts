// Owned by: ui
// Copies of live sim data for the HUD. The sim mutates its state in place, so the HUD keeps its
// own copies, taken at controller notifications (about 10 Hz).
import type { Attributes, Decision, FighterState, GameController, Limb, SkillId, Stance, WeaponId } from '../../core';

export type FighterCopy = {
  hp: number;
  maxHp: number;
  alive: boolean;
  facing: number;
  stance: Stance;
  stunTicks: number;
  parryTicks: number;
  buffs: { haste: number; berserk: number; slow: number };
  inShadow: boolean;
  seen: boolean;
  ammo: number;
  maxAmmo: number;
  attackCd: number;
  skillCd: number;
  damageDealt: number;
  damageTaken: number;
  kills: number;
  attributes: Attributes;
  weapon: WeaponId;
  skill: SkillId;
  limbs: Record<Limb, boolean>;
};

export type DecisionCopy = Pick<Decision, 'behaviour' | 'targetId' | 'heading' | 'speed' | 'attack' | 'parry' | 'useSkill' | 'stance'> & {
  scores: Record<string, number>;
  ring: number[];
  terms: { label: string; ratings: number[] }[];
  sensors: Record<string, number>;
};

export function copyFighter(f: FighterState | null): FighterCopy | null {
  if (!f) return null;
  return {
    hp: f.hp, maxHp: f.maxHp, alive: f.alive, facing: f.facing, stance: f.stance,
    stunTicks: f.stunTicks, parryTicks: f.parryTicks, buffs: { ...f.buffs },
    inShadow: f.inShadow, seen: f.seen, ammo: f.ammo, maxAmmo: f.maxAmmo,
    attackCd: f.attackCd, skillCd: f.skillCd,
    damageDealt: f.damageDealt, damageTaken: f.damageTaken, kills: f.kills,
    attributes: { ...f.attributes }, weapon: f.weapon, skill: f.skill, limbs: { ...f.limbs },
  };
}

export function copyDecision(d: Decision | null): DecisionCopy | null {
  if (!d) return null;
  return {
    behaviour: d.behaviour, targetId: d.targetId, heading: d.heading, speed: d.speed,
    attack: d.attack, parry: d.parry, useSkill: d.useSkill, stance: d.stance,
    scores: { ...d.scores },
    ring: [...d.ring],
    terms: d.terms.map((t) => ({ label: t.label, ratings: [...t.ratings] })),
    sensors: { ...(d.sensors ?? {}) },
  };
}

export function readLive(controller: GameController, id: string): { f: FighterCopy | null; d: DecisionCopy | null } {
  return { f: copyFighter(controller.fighter(id)), d: copyDecision(controller.decision(id)) };
}

const LIMB_NAMES: Record<Limb, string> = { armL: 'left arm', armR: 'right arm', legL: 'left leg', legR: 'right leg' };

/** Short status chips for the inspector; `hot` ones get the accent. */
export function statusChips(f: FighterCopy): { text: string; hot?: boolean }[] {
  const out: { text: string; hot?: boolean }[] = [];
  if (!f.alive) return [{ text: 'Dead' }];
  if (f.stunTicks > 0) out.push({ text: 'Stunned', hot: true });
  if (f.buffs.berserk > 0) out.push({ text: 'Berserk', hot: true });
  if (f.buffs.haste > 0) out.push({ text: 'Hasted' });
  if (f.buffs.slow > 0) out.push({ text: 'Slowed' });
  if (f.parryTicks > 0) out.push({ text: 'Parrying' });
  if (f.stance === 'creep') out.push({ text: 'Creeping' });
  if (f.stance === 'guard') out.push({ text: 'Shield up' });
  out.push({ text: f.inShadow ? 'In shadow' : 'In light' });
  if (f.seen) out.push({ text: 'Seen' });
  if (f.maxAmmo > 0 && f.ammo === 0) out.push({ text: 'Out of ammo', hot: true });
  for (const limb of Object.keys(f.limbs) as Limb[]) if (!f.limbs[limb]) out.push({ text: `No ${LIMB_NAMES[limb]}`, hot: true });
  return out;
}
