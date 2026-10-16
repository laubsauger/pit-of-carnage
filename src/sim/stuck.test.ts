import { describe, expect, it } from 'vitest';
import { STUCK_AMMO } from '../core';
import type { AmmoKind, Match, WeaponId } from '../core';
import { MAPS } from './maps';
import { createMatch } from './match';
import { seekerBrain, testConfig } from './testkit';

const AMMO_WEAPON: Record<AmmoKind, WeaponId> = { arrow: 'LONGBOW', axe: 'THROWING_AXES' };

/** Every arrow or axe in the match: in quivers of the living, in flight, on the floor, stuck anywhere. */
function count(m: Match, kind: AmmoKind): number {
  const s = m.state;
  let n = 0;
  for (const f of s.fighters) if (f.alive && f.weapon === AMMO_WEAPON[kind]) n += f.ammo;
  for (const p of s.projectiles) if (p.weapon === AMMO_WEAPON[kind]) n++;
  for (const it of s.floor) if (it.kind === kind) n++;
  for (const st of s.stuck) if (st.kind === kind) n++;
  return n;
}

describe('stuck ammo over whole matches', () => {
  // The bow's economy is the point of stuck ammo: an arrow is never conjured (apart from the
  // quiver's slow refill, WEAPONS.LONGBOW.ammoRegenTicks) and never lost in a wall, prop, body or
  // behind the closing wall. The only arrows that leave play are the overflow a dead archer's
  // quiver spills (it drops a few, not all). A body never holds more than the cap, and a corpse
  // never keeps any.
  it('never creates arrows or axes beyond the quiver refill, loses them only with a dead quiver, and empties every corpse', () => {
    let stuckSeen = 0;
    let bodySeen = 0;
    for (const mapId of Object.keys(MAPS)) {
      for (const seed of [1]) {
        const m = createMatch(testConfig({ seed, mapId, fighters: 8, weapons: ['LONGBOW', 'THROWING_AXES', 'GREATSWORD', 'LONGBOW'] }), seekerBrain);
        const label = `${mapId} seed ${seed}`;
        let arrows = count(m, 'arrow');
        let axes = count(m, 'axe');
        const quiver = m.state.fighters.map((f) => f.ammo);
        while (!m.isOver && m.state.tick < 20000) {
          const events = m.step();
          // Arrows the quivers found this tick: ammo gained that no shot or pickup explains.
          const spent = new Map<string, number>();
          for (const e of events) {
            if (e.type === 'projectile') spent.set(e.ownerId, (spent.get(e.ownerId) ?? 0) + 1);
            else if (e.type === 'pickup' && e.kind === 'arrow') spent.set(e.fighterId, (spent.get(e.fighterId) ?? 0) - 1);
          }
          let refilled = 0;
          m.state.fighters.forEach((f, i) => {
            if (f.weapon === 'LONGBOW' && f.alive) refilled += f.ammo - quiver[i]! + (spent.get(f.id) ?? 0);
            quiver[i] = f.ammo;
          });
          expect(refilled, `${label}: a quiver lost arrows at tick ${m.state.tick}`).toBeGreaterThanOrEqual(0);
          arrows += refilled;
          const quiverDied = events.some((e) => e.type === 'kill' && m.state.fighters.find((f) => f.id === e.victimId)!.weapon !== 'GREATSWORD');
          const nowArrows = count(m, 'arrow');
          const nowAxes = count(m, 'axe');
          if (quiverDied) {
            expect(nowArrows, `${label}: arrows appeared at tick ${m.state.tick}`).toBeLessThanOrEqual(arrows);
            expect(nowAxes, `${label}: axes appeared at tick ${m.state.tick}`).toBeLessThanOrEqual(axes);
          } else {
            expect(nowArrows, `${label}: arrows changed without a death at tick ${m.state.tick}`).toBe(arrows);
            expect(nowAxes, `${label}: axes changed without a death at tick ${m.state.tick}`).toBe(axes);
          }
          arrows = nowArrows;
          axes = nowAxes;
          const perBody = new Map<string, number>();
          for (const st of m.state.stuck) {
            stuckSeen++;
            if (st.in.kind !== 'fighter') continue;
            bodySeen++;
            const f = m.state.fighters[Number(st.in.fighterId.slice(1))]!;
            expect(f.alive, `${label}: ${st.kind} ${st.id} still stuck in dead ${f.name} at tick ${m.state.tick}`).toBe(true);
            expect(st.pickupPos).toBeNull();
            perBody.set(f.id, (perBody.get(f.id) ?? 0) + 1);
          }
          for (const [id, n] of perBody) expect(n, `${label}: ${id} holds ${n}`).toBeLessThanOrEqual(STUCK_AMMO.maxPerBody);
          expect(m.state.stuck.length).toBeLessThanOrEqual(STUCK_AMMO.maxStuck);
        }
        expect(m.isOver, `${label} did not finish within the tick cap`).toBe(true);
      }
    }
    expect(stuckSeen, 'nothing ever stuck: the checks above tested nothing').toBeGreaterThan(0);
    expect(bodySeen, 'nothing ever stuck in a body').toBeGreaterThan(0);
    // Four whole matches checked tick by tick: a few seconds alone, longer on a busy machine.
  }, 90_000);
});
