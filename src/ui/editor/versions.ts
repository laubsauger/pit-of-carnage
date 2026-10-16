// Owned by: ui
// The editor's model of the library's versions (SPEC "Versions and the library"): which saved
// version the draft is based on, what Save will do ("Save as v4", or ask when the name belongs to
// another lineage), how a version's origin reads, and a short summary of what changed between two
// versions for the history panel. Pure, so the rules are tested without a browser.
import { ATTRIBUTE_KEYS } from '../../core';
import type { MoveTerm, SavedOrigin, SavedStrategy, Strategy, StrategyHistoryEntry, StrategyStore } from '../../core';
import { LIMITS } from '../../strategy';
import { inlineJson } from '../editor';

/** Name and version as the draft's JSON states them (the version is absent on a new or imported strategy). */
export function draftIdentity(value: unknown): { name: string | null; version: number | null } {
  const v = value as { name?: unknown; version?: unknown } | null;
  const name = typeof v?.name === 'string' && v.name.trim() ? v.name : null;
  const version = typeof v?.version === 'number' && Number.isInteger(v.version) ? v.version : null;
  return { name, version };
}

/**
 * The saved version the draft was loaded from or last saved as. The library stamps its own number
 * into the JSON on save and on load, so the draft's name and version find it; a new fighter, an
 * import or an LLM's answer carries no version and has no base.
 */
export function draftBase(value: unknown, saved: readonly SavedStrategy[]): SavedStrategy | null {
  const { name, version } = draftIdentity(value);
  if (name === null || version === null) return null;
  return saved.find((s) => s.name === name && s.version === version) ?? null;
}

/**
 * The number the library will give the next save of `name`. The library never reuses a number
 * (not even a deleted one), so a store that knows more than its list (`nextVersion`) is asked first.
 */
export function nextVersionOf(store: Omit<StrategyStore, 'nextVersion'> & Partial<Pick<StrategyStore, 'nextVersion'>>, saved: readonly SavedStrategy[], name: string): number {
  const ask = store.nextVersion;
  const listed = saved.reduce((v, s) => (s.name === name ? Math.max(v, s.version) : v), 0) + 1;
  return typeof ask === 'function' ? Math.max(listed, ask.call(store, name)) : listed;
}

/** "Slurpy Hawk 2", "Slurpy Hawk 3", ... the first name not in `taken`, within the name limit. */
export function freeStrategyName(name: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const stem = name.replace(/\s+\d+$/, '').trim() || 'Gladiator';
  for (let i = 2; i < 10_000; i++) {
    const suffix = ` ${i}`;
    const candidate = stem.slice(0, LIMITS.nameLength - suffix.length).trimEnd() + suffix;
    if (!set.has(candidate)) return candidate;
  }
  return stem;
}

/**
 * What saving the draft as `name` means.
 * - `version`: the next version of the base's own name (parent = the base).
 * - `first`: a name the library does not have yet (v1; a copy keeps its source as `parentId`).
 * - `collision`: the name is taken by a lineage the draft did not come from; the player chooses
 *   between "Add as new version of X" and "Save as new strategy" (`suggestedName`).
 */
export type SavePlan = {
  kind: 'version' | 'first' | 'collision';
  name: string;
  /** The library's number for this save under `name`. */
  version: number;
  /** `parentId` to record when saved under `name`. */
  parentId: string | null;
  /** Same-name parent's number ("based on v3"), null when none. */
  parentVersion: number | null;
  /** For a collision: a free name to save it as a new strategy instead. */
  suggestedName: string;
};

/**
 * @param base the saved version the draft is based on (see `draftBase`), or the version an LLM
 *   was asked to improve.
 * @param copiedFrom the version the draft was based on before it was renamed, if any.
 */
export function savePlan(
  name: string,
  base: SavedStrategy | null,
  saved: readonly SavedStrategy[],
  nextVersion: (name: string) => number,
  copiedFrom: SavedStrategy | null = null,
): SavePlan {
  const names = new Set(saved.map((s) => s.name));
  const version = nextVersion(name);
  const suggestedName = freeStrategyName(name, names);
  if (base && base.name === name) return { kind: 'version', name, version, parentId: base.id, parentVersion: base.version, suggestedName };
  const source = base ?? copiedFrom;
  if (names.has(name)) return { kind: 'collision', name, version, parentId: null, parentVersion: null, suggestedName };
  return { kind: 'first', name, version, parentId: source?.id ?? null, parentVersion: null, suggestedName };
}

/**
 * How the player answered a save: as planned (the next version, or v1 of a new name; on a
 * collision this means "Add as new version of X"), or as a new strategy under another name.
 */
export type SaveChoice = { kind: 'plan' } | { kind: 'rename'; name: string };

/** The toast after a save: "Saved as Slurpy Hawk v4 (from v3)." */
export function savedMessage(e: Pick<SavedStrategy, 'name' | 'version' | 'parentVersion'>): string {
  return `Saved as ${e.name} v${e.version}${e.parentVersion !== null ? ` (from v${e.parentVersion})` : ''}.`;
}

/** An imported or pasted strategy as the editor opens it: its own `version` is never trusted. */
export function withoutVersion(s: Strategy): Strategy {
  const { version: _ignored, ...rest } = s;
  return rest;
}

/**
 * What a history row is compared with for "what changed": its parent when that is still in the
 * library, else the next older version of the name (a version added from another lineage).
 */
export function changeBase(entries: readonly StrategyHistoryEntry[], i: number): SavedStrategy | null {
  const e = entries[i];
  if (!e) return null;
  return e.parent ?? entries[i + 1]?.saved ?? null;
}

/** Short words for where a version came from. */
export function originLabel(origin: SavedOrigin | null): string {
  if (!origin) return 'saved';
  switch (origin.kind) {
    case 'editor':
      return 'edited';
    case 'llm-paste':
      return 'from an LLM';
    case 'import':
      return 'imported';
    case 'evolution':
      return `evolved, generation ${origin.generation}`;
    case 'room':
      return 'from a room';
    case 'house':
      return 'copied from a house stack';
  }
}

/** "17:42" today, "Oct 14, 17:42" earlier this year, "Oct 14 2025" before. Local time. */
export function formatSavedAt(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const now = new Date(nowMs);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const month = d.toLocaleString('en', { month: 'short' });
  if (d.getFullYear() !== now.getFullYear()) return `${month} ${d.getDate()} ${d.getFullYear()}`;
  if (d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
  return `${month} ${d.getDate()}, ${hm}`;
}

/**
 * One line for a version: "v4, from v3, evolved, generation 140". A parent from another name says
 * so ("copied from Big Lad Steve v2"); a missing parent just leaves the "from" out.
 */
export function versionLine(saved: SavedStrategy, parent: SavedStrategy | null): string {
  return `v${saved.version}, ${versionOrigin(saved, parent)}`;
}

/** `versionLine` without the number: "from v3, evolved, generation 140". */
export function versionOrigin(saved: SavedStrategy, parent: SavedStrategy | null): string {
  const parts: string[] = [];
  if (saved.parentVersion !== null) parts.push(`from v${saved.parentVersion}`);
  else if (parent && parent.name !== saved.name) parts.push(`copied from ${parent.name} v${parent.version}`);
  parts.push(originLabel(saved.origin));
  return parts.join(', ');
}

/** The header: "Editing Slurpy Hawk, based on v3 (saved 17:42)", or what the draft is when it has no base. */
export function baseLine(name: string | null, base: SavedStrategy | null, pending: SavedOrigin | null, nowMs: number): string {
  const who = name ?? 'an unnamed strategy';
  if (base) return `Editing ${who}, based on v${base.version} (saved ${formatSavedAt(base.savedAt, nowMs)})`;
  if (pending?.kind === 'llm-paste') return `Editing ${who}, an LLM's answer, not saved yet`;
  if (pending?.kind === 'import') return `Editing ${who}, imported, not saved yet`;
  return `Editing ${who}, not saved yet`;
}

// ---------------------------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------------------------

function termKind(t: MoveTerm): string {
  return Object.keys(t).find((k) => k !== 'weight') ?? '?';
}

function termArg(t: MoveTerm): string {
  const v = (t as Record<string, unknown>)[termKind(t)];
  return Array.isArray(v) ? v.map(String).join(', ') : String(v);
}

const fmt = (n: number) => String(Number(n.toFixed(2)));
const same = (a: unknown, b: unknown) => inlineJson(a) === inlineJson(b);

/** One behaviour's changes: score, attack, skill, stance, memory writes, move terms and weights. */
function behaviourChanges(name: string, a: Strategy['behaviours'][string], b: Strategy['behaviours'][string]): string[] {
  const out: string[] = [];
  if (a.score !== b.score) out.push(`${name}: score`);
  const am = a.move ?? [];
  const bm = b.move ?? [];
  const sameShape = am.length === bm.length && am.every((t, i) => termKind(t) === termKind(bm[i]!) && termArg(t) === termArg(bm[i]!));
  if (sameShape) {
    am.forEach((t, i) => {
      const u = bm[i]!;
      if (t.weight !== u.weight) out.push(`${name}: ${termKind(t)} ${termArg(t)} weight ${fmt(t.weight)} → ${fmt(u.weight)}`);
    });
  } else {
    const before = am.map((t) => `${termKind(t)} ${termArg(t)}`);
    const after = bm.map((t) => `${termKind(t)} ${termArg(t)}`);
    const added = after.filter((x) => !before.includes(x));
    const gone = before.filter((x) => !after.includes(x));
    if (added.length || gone.length) out.push(`${name}: moves ${[...added.map((x) => `+${x}`), ...gone.map((x) => `−${x}`)].join(', ')}`);
    else out.push(`${name}: moves reordered`);
  }
  if (a.attack !== b.attack) out.push(`${name}: attack`);
  if ((a.skill ?? null) !== (b.skill ?? null)) out.push(`${name}: skill`);
  if ((a.stance ?? 'normal') !== (b.stance ?? 'normal')) out.push(`${name}: stance ${a.stance ?? 'normal'} → ${b.stance ?? 'normal'}`);
  if (!same(a.set ?? {}, b.set ?? {})) out.push(`${name}: memory writes`);
  return out;
}

/**
 * What changed from `a` to `b`, most telling first: build, attributes, behaviours (added, removed,
 * changed, with weight changes spelled out), target, imports, memory, commit, barks, look.
 * Empty when they play the same (the version number and the author do not count).
 */
export function diffStrategies(a: Strategy, b: Strategy): string[] {
  const out: string[] = [];
  if (a.build.weapon !== b.build.weapon) out.push(`weapon ${a.build.weapon} → ${b.build.weapon}`);
  if (a.build.skill !== b.build.skill) out.push(`skill ${a.build.skill} → ${b.build.skill}`);
  const attrs = ATTRIBUTE_KEYS.filter((k) => a.build.attributes[k] !== b.build.attributes[k]).map((k) => `${k} ${a.build.attributes[k]} → ${b.build.attributes[k]}`);
  if (attrs.length) out.push(attrs.join(', '));
  const an = Object.keys(a.behaviours);
  const bn = Object.keys(b.behaviours);
  for (const n of bn) if (!an.includes(n)) out.push(`+ behaviour ${n}`);
  for (const n of an) if (!bn.includes(n)) out.push(`− behaviour ${n}`);
  for (const n of bn) if (an.includes(n)) out.push(...behaviourChanges(n, a.behaviours[n]!, b.behaviours[n]!));
  const kept = bn.filter((n) => an.includes(n));
  if (kept.join() !== an.filter((n) => bn.includes(n)).join()) out.push('behaviours reordered');
  if (a.target !== b.target) out.push('target');
  const ai = a.imports ?? [];
  const bi = b.imports ?? [];
  const imports = [...bi.filter((x) => !ai.includes(x)).map((x) => `+${x}`), ...ai.filter((x) => !bi.includes(x)).map((x) => `−${x}`)];
  if (imports.length) out.push(`imports ${imports.join(', ')}`);
  if (!same(a.memory ?? {}, b.memory ?? {})) out.push('memory');
  if (a.commit !== b.commit) out.push(`commit ${a.commit} → ${b.commit}`);
  if (!same(a.barks ?? {}, b.barks ?? {})) out.push('barks');
  if (!same(a.look ?? {}, b.look ?? {})) out.push('look');
  if (a.name !== b.name) out.push(`name ${a.name} → ${b.name}`);
  return out;
}

/** The history row's summary: the first few changes and how many more, or "no change in play". */
export function diffSummary(changes: readonly string[], max = 3): string {
  if (!changes.length) return 'no change in play';
  const shown = changes.slice(0, max).join('; ');
  return changes.length > max ? `${shown}; and ${changes.length - max} more` : shown;
}
