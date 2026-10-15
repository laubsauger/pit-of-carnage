/**
 * Map definitions. Every map is mirrored on both axes: each map is described by its top-left
 * quadrant (plus anything sitting on a centre line), and `mirror*` produces the other three
 * quadrants. That makes every spawn slot, door, light and keg have three twins, so no side of the
 * arena is better than another.
 *
 * Spawns are sorted by angle around the map centre (0 = east, clockwise on screen). The match picks
 * every (16 / n)-th slot from a random offset, so any fighter count from 2 to 16 is spread evenly.
 */

import type { HazardDef, LightDef, MapDef, PickupKind, PropDef, PropKind, Rect, Vec2 } from '../core';
import { TAU } from '../core';

/** Outer wall thickness, shared by every map. */
export const OUTER_WALL = 24;

const BRAZIER = '#ffc27a';
const TORCH = '#ff9d4d';
const COLD = '#9fb7ff';
const FIRE = '#ff7a2e';

/** Fire pits are light sources: each one gets a matching light so the renderer and the sim agree. */
const FIRE_LIGHT_RADIUS = 175;
const FIRE_LIGHT_INTENSITY = 0.55;

function fireLights(hazards: HazardDef[]): LightDef[] {
  return hazards
    .filter((h) => h.kind === 'fire')
    .map((h) => ({ id: `${h.id}_light`, pos: { ...h.pos }, radius: FIRE_LIGHT_RADIUS, intensity: FIRE_LIGHT_INTENSITY, color: FIRE, flicker: 0.45, castsShadow: true }));
}

function outerWalls(w: number, h: number): Rect[] {
  const t = OUTER_WALL;
  return [
    { x: 0, y: 0, w, h: t },
    { x: 0, y: h - t, w, h: t },
    { x: 0, y: t, w: t, h: h - 2 * t },
    { x: w - t, y: t, w: t, h: h - 2 * t },
  ];
}

const MIRRORS: readonly (readonly [boolean, boolean])[] = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
];

/** Rects mirrored into all four quadrants; exact duplicates (rects on a centre line) are dropped. */
function mirrorRects(w: number, h: number, rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  const seen = new Set<string>();
  for (const r of rects) {
    for (const [mx, my] of MIRRORS) {
      const x = mx ? w - r.x - r.w : r.x;
      const y = my ? h - r.y - r.h : r.y;
      const key = `${x},${y},${r.w},${r.h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x, y, w: r.w, h: r.h });
    }
  }
  return out;
}

function mirrorPoint(w: number, h: number, p: Vec2, mx: boolean, my: boolean): Vec2 {
  return { x: mx ? w - p.x : p.x, y: my ? h - p.y : p.y };
}

/**
 * Items with a position mirrored into all four quadrants. Copies on a centre line collapse into one.
 * Ids get a quadrant suffix so they stay unique.
 */
function mirrorItems<T extends { id: string; pos: Vec2 }>(w: number, h: number, items: T[], extra?: (item: T, mx: boolean, my: boolean) => Partial<T>): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    MIRRORS.forEach(([mx, my], q) => {
      const pos = mirrorPoint(w, h, item.pos, mx, my);
      const key = `${pos.x},${pos.y}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ...item, ...(extra ? extra(item, mx, my) : {}), id: `${item.id}_${q}`, pos });
    });
  }
  return out;
}

function mirrorPoints(w: number, h: number, points: Vec2[]): Vec2[] {
  return mirrorItems(w, h, points.map((pos, i) => ({ id: `p${i}`, pos }))).map((p) => p.pos);
}

/** Spawn order: by angle around the centre, starting east and turning clockwise on screen. */
function sortByAngle(w: number, h: number, points: Vec2[]): Vec2[] {
  const angle = (p: Vec2) => {
    const a = Math.atan2(p.y - h / 2, p.x - w / 2);
    return a < 0 ? a + TAU : a;
  };
  return [...points].sort((a, b) => angle(a) - angle(b));
}

/** 16 spawn points on an ellipse, offset half a step so none sits on a centre line (pickups live there). */
function ellipseSpawns(w: number, h: number, rx: number, ry: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < 16; i++) {
    const a = ((i + 0.5) / 16) * TAU;
    out.push({ x: Math.round(w / 2 + Math.cos(a) * rx), y: Math.round(h / 2 + Math.sin(a) * ry) });
  }
  return out;
}

function light(id: string, x: number, y: number, radius: number, intensity: number, color = TORCH, flicker = 0.25): LightDef {
  return { id, pos: { x, y }, radius, intensity, color, flicker, castsShadow: true };
}

function prop(id: string, kind: PropKind, x: number, y: number): PropDef {
  const radius = kind === 'keg' ? 17 : kind === 'amphora' ? 15 : 21;
  return { id, kind, pos: { x, y }, radius };
}

function pickup(id: string, kind: PickupKind, x: number, y: number) {
  return { id, kind, pos: { x, y } };
}

/** Saw path mirrored with its owner. */
function mirrorPath(w: number, h: number) {
  return (item: HazardDef, mx: boolean, my: boolean): Partial<HazardDef> =>
    item.path ? { path: item.path.map((p) => mirrorPoint(w, h, p, mx, my)) } : {};
}

// ---------------------------------------------------------------------------------------------
// The Pit (default, balanced)
// ---------------------------------------------------------------------------------------------

/**
 * Lit centre with the shrine on open sand, a ring of eight pillars around it, open lanes along the
 * top and bottom edges (ranged), gate halls behind a gated wall on the left and right (melee), and
 * dark corner alcoves with a torch at each mouth (stealth). Kegs sit just inside the pillar ring on
 * the hall side, acid amphoras at the top and bottom gaps of the ring. Power-ups sit where fights
 * happen, so grabbing one is a risk: each gate hall keeps its berserk draught on a spike trap (grab
 * it on the off-beat or pay for it), and the haste charms stand in the light in the middle of the
 * open top and bottom lanes, in the archers' line of fire.
 */
function buildPit(): MapDef {
  const W = 1360;
  const H = 860;
  const cx = W / 2;
  const cy = H / 2;

  // Every wall is a straight piece; pieces never meet in an L, so fighters steering straight at a
  // target slide off walls instead of wedging into inside corners.
  const quadrantWalls: Rect[] = [
    // Gate hall: the gate wall's upper half (the mirror is the lower half), a 100 px gate between them.
    { x: 192, y: 240, w: 22, h: 140 },
    // Hall roof off the outer wall; the 72 px gap to the gate wall is the hall's back door.
    { x: 24, y: 240, w: 96, h: 22 },
    // Corner alcove: a partition off the top wall and a lip off the side wall; the mouth between
    // them opens toward the arena.
    { x: 236, y: 24, w: 22, h: 116 },
    { x: 24, y: 140, w: 106, h: 20 },
  ];

  const pillars: Rect[] = [];
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * TAU;
    const px = Math.round(cx + Math.cos(a) * 250);
    const py = Math.round(cy + Math.sin(a) * 168);
    pillars.push({ x: px - 23, y: py - 23, w: 46, h: 46 });
  }

  return {
    id: 'pit',
    name: 'The Pit',
    width: W,
    height: H,
    floor: 'sand',
    ambient: 0.14,
    walls: [...outerWalls(W, H), ...mirrorRects(W, H, quadrantWalls)],
    pillars,
    lights: [
      light('centre', cx, cy, 440, 0.85, BRAZIER, 0.06),
      ...mirrorItems(W, H, [
        light('lane', 470, 46, 300, 0.5, BRAZIER, 0.15),
        light('alcove', 186, 186, 150, 0.6, TORCH, 0.35),
      ]),
      ...mirrorItems(W, H, [light('hall', 38, cy, 230, 0.55, TORCH, 0.3)]),
    ],
    hazards: mirrorItems(W, H, [{ id: 'spike', kind: 'spike' as const, pos: { x: 96, y: cy }, radius: 42 }]),
    props: [
      ...mirrorItems(W, H, [prop('keg', 'keg', 505, cy)]),
      ...mirrorItems(W, H, [prop('amphora', 'amphora', cx, 236)]),
      ...mirrorItems(W, H, [prop('crate', 'crate', 420, 104)]),
    ],
    shrines: [{ id: 'shrine', pos: { x: cx, y: cy } }],
    pickups: [
      ...mirrorItems(W, H, [pickup('berserk', 'berserk', 96, cy)]),
      ...mirrorItems(W, H, [pickup('haste', 'haste', cx, 120)]),
    ],
    spawns: sortByAngle(W, H, ellipseSpawns(W, H, 420, 300)),
  };
}

// ---------------------------------------------------------------------------------------------
// Pillar Forest (ambush)
// ---------------------------------------------------------------------------------------------

/**
 * A staggered grid of pillars with a lit clearing around the shrine. Sightlines are short except
 * along the gaps between rows. Fire pits light two patches; spike traps guard the clearing's
 * diagonals.
 */
function buildPillarForest(): MapDef {
  const W = 1360;
  const H = 860;
  const cx = W / 2;
  const cy = H / 2;

  const spawns = ellipseSpawns(W, H, 480, 320);
  const hazards: HazardDef[] = [
    ...mirrorItems(W, H, [{ id: 'fire', kind: 'fire' as const, pos: { x: 430, y: cy }, radius: 40 }]),
    ...mirrorItems(W, H, [{ id: 'spike', kind: 'spike' as const, pos: { x: 540, y: 250 }, radius: 42 }]),
  ];
  const props: PropDef[] = [
    ...mirrorItems(W, H, [prop('keg', 'keg', 330, 282)]),
    ...mirrorItems(W, H, [prop('amphora', 'amphora', cx, 242)]),
  ];
  const pickups = [
    ...mirrorItems(W, H, [pickup('haste', 'haste', 300, cy)]),
    ...mirrorItems(W, H, [pickup('berserk', 'berserk', 575, cy)]),
  ];
  const lights: LightDef[] = [
    light('centre', cx, cy, 300, 0.72, BRAZIER, 0.08),
    ...mirrorItems(W, H, [light('torch', 330, 150, 230, 0.55, TORCH, 0.3)]),
    ...fireLights(hazards),
  ];

  // Features first, then the grid minus every pillar that would crowd one of them.
  const keepClear: { pos: Vec2; r: number }[] = [
    { pos: { x: cx, y: cy }, r: 150 },
    ...spawns.map((pos) => ({ pos, r: 66 })),
    ...hazards.map((hz) => ({ pos: hz.pos, r: hz.radius + 48 })),
    ...props.map((p) => ({ pos: p.pos, r: p.radius + 50 })),
    ...pickups.map((p) => ({ pos: p.pos, r: 66 })),
  ];
  const size = 42;
  const pillars: Rect[] = [];
  for (let k = -3; k <= 3; k++) {
    const y = cy + k * 104;
    const offset = Math.abs(k) % 2 === 0 ? 0 : 70;
    for (let m = -5; m <= 5; m++) {
      const x = cx + offset + m * 140;
      if (x - size / 2 < 80 || x + size / 2 > W - 80) continue;
      if (keepClear.some((c) => Math.hypot(c.pos.x - x, c.pos.y - y) < c.r)) continue;
      pillars.push({ x: x - size / 2, y: y - size / 2, w: size, h: size });
    }
  }

  return {
    id: 'pillar_forest',
    name: 'Pillar Forest',
    width: W,
    height: H,
    floor: 'stone',
    ambient: 0.13,
    walls: outerWalls(W, H),
    pillars,
    lights,
    hazards,
    props,
    shrines: [{ id: 'shrine', pos: { x: cx, y: cy } }],
    pickups,
    spawns: sortByAngle(W, H, spawns),
  };
}

// ---------------------------------------------------------------------------------------------
// Catacombs (stealth, hearing)
// ---------------------------------------------------------------------------------------------

/**
 * Nine dark rooms in a 3x3 grid. The room walls are broken crypt walls: a cross-shaped block at
 * each inner junction and short stubs off the outer walls, leaving 95-150 px gaps between rooms and
 * a wide mouth into the shrine hall from above and below. Each room has one pool of torchlight; the
 * rest is shadow, so hearing matters. The doors from the side rooms into the shrine hall sit on
 * spike traps: a shortcut with a rhythm.
 */
function buildCatacombs(): MapDef {
  const W = 1360;
  const H = 860;
  const cx = W / 2;
  const cy = H / 2;
  const t = OUTER_WALL;
  const band = 50;
  // Room grid lines: x 430..480 (mirrored 880..930) and y 270..320 (mirrored 540..590).
  const vx = 430;
  const hy = 270;
  const walls: Rect[] = [
    // Cross block at the junction of the grid lines.
    { x: vx, y: 215, w: band, h: 160 },
    { x: 375, y: hy, w: 160, h: band },
    // Stubs off the outer walls along the grid lines.
    { x: vx, y: t, w: band, h: 120 - t },
    { x: t, y: hy, w: 225 - t, h: band },
  ];

  const pillars = mirrorRects(W, H, [{ x: (t + vx) / 2 - 22, y: (t + hy) / 2 - 22, w: 44, h: 44 }]);

  return {
    id: 'catacombs',
    name: 'The Catacombs',
    width: W,
    height: H,
    floor: 'stone',
    ambient: 0.06,
    walls: [...outerWalls(W, H), ...mirrorRects(W, H, walls)],
    pillars,
    lights: [
      light('shrine', cx, cy, 215, 0.75, COLD, 0.05),
      ...mirrorItems(W, H, [
        light('corner', 60, 60, 190, 0.7, TORCH, 0.35),
        light('side', 38, cy, 185, 0.65, TORCH, 0.35),
        light('top', cx, 38, 185, 0.65, TORCH, 0.35),
      ]),
    ],
    hazards: mirrorItems(W, H, [{ id: 'spike', kind: 'spike' as const, pos: { x: vx + band / 2, y: cy }, radius: 42 }]),
    props: [
      ...mirrorItems(W, H, [prop('amphora', 'amphora', 560, 160)]),
      ...mirrorItems(W, H, [prop('keg', 'keg', 360, 380)]),
      ...mirrorItems(W, H, [prop('crate', 'crate', 370, 70)]),
    ],
    shrines: [{ id: 'shrine', pos: { x: cx, y: cy } }],
    pickups: [
      ...mirrorItems(W, H, [pickup('berserk', 'berserk', 80, cy)]),
      ...mirrorItems(W, H, [pickup('haste', 'haste', cx, 76)]),
    ],
    spawns: sortByAngle(W, H, mirrorPoints(W, H, [{ x: 240, y: 384 }, { x: 110, y: 205 }, { x: 330, y: 125 }, { x: 590, y: 200 }])),
  };
}

// ---------------------------------------------------------------------------------------------
// Meat Grinder (melee)
// ---------------------------------------------------------------------------------------------

/**
 * A walled central arena (the grinder) with openings at its four corners and gates in the middle
 * of its long sides. Saws patrol outside every wall, crossing every opening, and one sweeps across
 * the arena right over the shrine. Short barricades break up the outer ring; fire pits burn in the
 * corners. Getting in or out means timing a saw. Wall pieces never meet, so nobody gets wedged.
 */
function buildMeatGrinder(): MapDef {
  const W = 1360;
  const H = 860;
  const cx = W / 2;
  const cy = H / 2;

  const quadrantWalls: Rect[] = [
    // Arena top wall, left of the top gate (arena spans x 420..940, y 270..590).
    { x: 500, y: 270, w: 130, h: 24 },
    // Arena side wall (spans the centre line, so it mirrors onto itself vertically).
    { x: 420, y: 350, w: 24, h: 160 },
    // Outer-ring barricade: cover for the corner runs.
    { x: 250, y: 172, w: 140, h: 22 },
  ];

  const sawPath = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y }));
  const hazards: HazardDef[] = [
    ...mirrorItems(
      W,
      H,
      [
        { id: 'saw_top', kind: 'saw' as const, pos: { x: cx, y: 236 }, radius: 26, path: sawPath([[cx, 236], [960, 236], [cx, 236], [400, 236]]) },
        { id: 'saw_side', kind: 'saw' as const, pos: { x: 386, y: cy }, radius: 26, path: sawPath([[386, cy], [386, 560], [386, cy], [386, 300]]) },
      ],
      mirrorPath(W, H),
    ),
    { id: 'saw_centre', kind: 'saw', pos: { x: cx, y: cy }, radius: 26, path: sawPath([[cx, cy], [840, cy], [cx, cy], [520, cy]]) },
    ...mirrorItems(W, H, [{ id: 'fire', kind: 'fire' as const, pos: { x: 84, y: 84 }, radius: 40 }]),
  ];

  return {
    id: 'meat_grinder',
    name: 'The Meat Grinder',
    width: W,
    height: H,
    floor: 'flesh',
    ambient: 0.15,
    walls: [...outerWalls(W, H), ...mirrorRects(W, H, quadrantWalls)],
    pillars: [],
    lights: [
      light('arena', cx, cy, 380, 0.8, BRAZIER, 0.06),
      ...mirrorItems(W, H, [light('lane_top', cx, 200, 260, 0.45, TORCH, 0.2)]),
      ...mirrorItems(W, H, [light('lane_side', 340, cy, 230, 0.45, TORCH, 0.2)]),
      ...fireLights(hazards),
    ],
    hazards,
    props: [
      ...mirrorItems(W, H, [prop('keg', 'keg', 300, 92)]),
      ...mirrorItems(W, H, [prop('amphora', 'amphora', cx, 352)]),
    ],
    shrines: [{ id: 'shrine', pos: { x: cx, y: cy } }],
    pickups: [
      ...mirrorItems(W, H, [pickup('haste', 'haste', 110, cy)]),
      ...mirrorItems(W, H, [pickup('berserk', 'berserk', cx, 78)]),
    ],
    spawns: sortByAngle(W, H, ellipseSpawns(W, H, 572, 362)),
  };
}

export const MAPS: Record<string, MapDef> = {
  pit: buildPit(),
  pillar_forest: buildPillarForest(),
  catacombs: buildCatacombs(),
  meat_grinder: buildMeatGrinder(),
};

export const MAP_IDS: readonly string[] = Object.keys(MAPS);
