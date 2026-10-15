// Owned by: ui
// Strategy and map choices shared by the Test and Evolve panes.
import { DEFAULT_FIGHTERS, DEFAULT_MAP_ID } from '../../core';
import type { SavedStrategy, Strategy } from '../../core';
import { MAPS } from '../../sim';
import type { BatchForm, EvolveForm } from '../batch';
import { strategyLabel } from '../format';
import { inSentence } from '../reports';
import { houseRef, randomSeed, savedRef } from '../setup';
import type { PickItem } from './Picklist';

/** Ref of the strategy currently in the editor. */
export const DRAFT_REF = 'draft';

export type StrategyOptions = {
  byRef: Map<string, Strategy>;
  draft: PickItem | null;
  mine: PickItem[];
  house: PickItem[];
};

/** Saved entries carry their version on the entry; the strategy inside gets it too so keys match. */
export function strategyOptions(house: readonly Strategy[], saved: readonly SavedStrategy[], draft: Strategy | null): StrategyOptions {
  const byRef = new Map<string, Strategy>();
  const mine: PickItem[] = [];
  const houseItems: PickItem[] = [];
  let draftItem: PickItem | null = null;
  if (draft) {
    byRef.set(DRAFT_REF, draft);
    draftItem = { ref: DRAFT_REF, label: strategyLabel(draft.name, draft.version), weapon: draft.build.weapon, note: 'in the editor' };
  }
  for (const s of saved) {
    const ref = savedRef(s.id);
    byRef.set(ref, { ...s.strategy, version: s.version });
    mine.push({ ref, label: strategyLabel(s.name, s.version), weapon: s.strategy.build.weapon });
  }
  for (const h of house) {
    const ref = houseRef(h);
    byRef.set(ref, h);
    houseItems.push({ ref, label: h.name, weapon: h.build.weapon });
  }
  return { byRef, draft: draftItem, mine, house: houseItems };
}

export function resolveRefs(refs: readonly string[], byRef: ReadonlyMap<string, Strategy>): Strategy[] {
  return refs.map((r) => byRef.get(r)).filter((s): s is Strategy => s !== undefined);
}

export function mapItems(): PickItem[] {
  return Object.values(MAPS).map((m) => ({ ref: m.id, label: m.name }));
}

/** "the Pit and Pillar Forest", for use mid-sentence. */
export function mapNames(ids: readonly string[]): string {
  const names = ids.map((id) => inSentence(MAPS[id]?.name ?? id));
  if (names.length <= 1) return names[0] ?? 'no map';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function defaultBatchForm(house: readonly Strategy[]): BatchForm {
  return {
    candidates: [DRAFT_REF],
    field: house.map(houseRef),
    maps: [DEFAULT_MAP_ID],
    matches: 20,
    fighters: DEFAULT_FIGHTERS,
    seed: randomSeed(),
  };
}

export function defaultEvolveForm(house: readonly Strategy[]): EvolveForm {
  return {
    field: house.map(houseRef),
    maps: [DEFAULT_MAP_ID],
    generations: 6,
    population: 6,
    matches: 8,
    fighters: DEFAULT_FIGHTERS,
    seed: randomSeed(),
  };
}
