// Owned by: integrator
/**
 * Hover cards for map objects (`GameController.objectInfo`): what the object does, with the real
 * numbers from the rule tables, and its live state from the world state.
 */

import { HAZARD_RULES, PICKUP_RULES, PROP_RULES, TICK_HZ } from '../core';
import type { MapObjectKind, ObjectInfo, WorldState } from '../core';

/** "3.2 s" (whole seconds without a decimal: "10 s"). */
export function seconds(ticks: number): string {
  const s = Math.max(0, ticks) / TICK_HZ;
  const r = Math.round(s * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)} s`;
}

/** Rule docs talk in ticks ("every 24 ticks", "its 165-tick cycle"); hover cards talk in seconds. */
export function inSeconds(doc: string): string {
  return doc.replace(/(\d+)[- ]ticks?\b/g, (_, n: string) => seconds(Number(n)));
}

/**
 * Card data for one object of the live match, or null when it is gone (a broken prop, dried acid)
 * or unknown. Poll it while the card is open: the state line counts down.
 */
export function objectInfo(state: WorldState, kind: MapObjectKind, id: string): ObjectInfo | null {
  switch (kind) {
    case 'shrine': {
      const s = state.shrines.find((x) => x.id === id);
      if (!s) return null;
      const rule = PICKUP_RULES.shrine;
      return {
        kind, id, name: rule.name,
        description: `Heals ${Math.round(rule.amount * 100)}% of max HP on touch, then recharges for ${seconds(rule.cooldownTicks)}.`,
        state: s.cooldown > 0 ? `Recharging, ${seconds(s.cooldown)}` : 'Ready',
      };
    }
    case 'pickup': {
      const p = state.pickups.find((x) => x.id === id);
      if (!p) return null;
      const rule = PICKUP_RULES[p.kind];
      return { kind, id, name: rule.name, description: inSeconds(rule.doc), state: p.cooldown > 0 ? `Back in ${seconds(p.cooldown)}` : 'Up for grabs' };
    }
    case 'hazard': {
      const h = state.hazards.find((x) => x.id === id);
      if (!h) return null;
      const rule = HAZARD_RULES[h.kind];
      let live: string | null = null;
      if (h.kind === 'spike') {
        const period = h.period ?? rule.period;
        const local = Math.round(h.phase * period);
        const trigger = Math.floor(period * rule.triggerAt);
        live = h.active ? 'Spikes up' : `Thrusts in ${seconds((trigger - local + period) % period)}`;
      } else if (h.kind === 'saw') live = state.suddenDeath.active ? 'Rolling faster: sudden death' : 'Rolling along its track';
      else if (h.ttl !== null) live = `Dries up in ${seconds(h.ttl)}`;
      return { kind, id, name: h.ttl !== null ? `Spilled ${rule.name.toLowerCase()}` : rule.name, description: inSeconds(rule.doc), state: live };
    }
    case 'prop': {
      const pr = state.props.find((x) => x.id === id);
      if (!pr || !pr.alive) return null;
      const rule = PROP_RULES[pr.kind];
      return { kind, id, name: rule.name, description: inSeconds(rule.doc), state: `${Math.max(0, Math.ceil(pr.hp))} of ${rule.hp} HP` };
    }
  }
}
