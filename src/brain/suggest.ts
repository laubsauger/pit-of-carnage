/**
 * "Did you mean" for unknown names. Players and LLMs mostly make four kinds of mistake: a word
 * from another game (`health`, `center`, `in_range` inside an expression), a typo of such a word
 * (`self.helth`), a missing or wrong prefix (`distance` for `target.distance`) and a plain typo or
 * truncation (`self.hpp`, `struck` for `struck_at`). Rules are tried in that order.
 */

/** Whole names with no spelling relation to the right one. Used only when the answer is in the vocabulary. */
const HINTS: Readonly<Record<string, string>> = {
  in_range: 'target.in_reach',
  'target.in_range': 'target.in_reach',
  can_attack: 'attack.ready',
  cooldown: 'attack.ready',
  center: 'centre',
  middle: 'centre',
  enemy: 'nearest_enemy',
  closest_enemy: 'nearest_enemy',
  enemies_visible: 'enemies_seen',
  visible_enemies: 'enemies_seen',
  dark: 'shadow',
  light: 'lit',
  behaviors: 'behaviours',
  behavior: 'behaviours',
  moves: 'move',
  movement: 'move',
  weights: 'weight',
  attributes: 'build',
  clockwise: 'cw',
  counterclockwise: 'ccw',
  anticlockwise: 'ccw',
};

/** Last-segment synonyms: `<prefix>.health` means `<prefix>.hp`. Matched with one typo allowed. */
const TAIL_SYNONYMS: Readonly<Record<string, string>> = {
  health: 'hp',
  hitpoints: 'hp',
  life: 'hp',
  dist: 'distance',
  range: 'distance',
  visible: 'seen',
  back_turned: 'facing_away',
  behind: 'facing_away',
  facing: 'facing_away',
  in_range: 'in_reach',
  can_reach: 'in_reach',
  dark: 'in_shadow',
  shadow: 'in_shadow',
  attacking: 'winding_up',
};

/** Damerau-Levenshtein (optimal string alignment) distance. */
export function editDistance(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev2 = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
    }
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[m]!;
}

/** Which prefix to offer first when several names share a last segment. */
function prefixRank(name: string): number {
  const p = split(name).prefix;
  return p === 'target' ? 0 : p === 'self' ? 1 : p === 'it' ? 2 : 3;
}

function split(name: string): { prefix: string; tail: string } {
  const i = name.lastIndexOf('.');
  return i < 0 ? { prefix: '', tail: name } : { prefix: name.slice(0, i), tail: name.slice(i + 1) };
}

/** The closest known name to `word`, or undefined when nothing is close enough to be a useful guess. */
export function didYouMean(word: string, vocabulary: readonly string[]): string | undefined {
  if (vocabulary.length === 0 || word.length === 0) return undefined;
  const lower = word.toLowerCase();
  const known = (v: string | undefined): string | undefined => (v !== undefined && vocabulary.includes(v) ? v : undefined);

  const hint = Object.hasOwn(HINTS, lower) ? known(HINTS[lower]) : undefined;
  if (hint) return hint;

  for (const v of vocabulary) if (v.toLowerCase() === lower) return v;

  // A word from another game, possibly misspelt: `self.helth` -> `self.hp`, `health` -> `self.hp`.
  const { prefix, tail } = split(lower);
  for (const [syn, real] of Object.entries(TAIL_SYNONYMS)) {
    if (tail !== syn && (syn.length < 5 || editDistance(tail, syn) > 1)) continue;
    const found = known(prefix ? `${prefix}.${real}` : undefined) ?? known(`self.${real}`) ?? known(`target.${real}`) ?? known(`it.${real}`) ?? known(real);
    if (found) return found;
  }

  // Missing or wrong prefix: `distance` -> `target.distance`, `me.hp` -> `self.hp`.
  const sameTail = vocabulary.filter((v) => v.includes('.') && split(v).tail === tail);
  if (sameTail.length > 0) return sameTail.sort((a, b) => prefixRank(a) - prefixRank(b))[0];

  // Truncated or extended: `struck` -> `struck_at` (shortest completion), `lurking` -> `lurk` (longest stem).
  if (lower.length >= 4) {
    const completions = vocabulary.filter((v) => v.toLowerCase().startsWith(lower));
    if (completions.length > 0) return completions.reduce((a, b) => (b.length < a.length ? b : a));
    const stems = vocabulary.filter((v) => v.length >= 4 && lower.startsWith(v.toLowerCase()));
    if (stems.length > 0) return stems.reduce((a, b) => (b.length > a.length ? b : a));
  }

  let best: string | undefined;
  let bestD = Infinity;
  for (const v of vocabulary) {
    const d = editDistance(lower, v.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  const allowed = Math.max(1, Math.floor(word.length / 3));
  return bestD <= allowed ? best : undefined;
}
