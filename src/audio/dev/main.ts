// Owned by: audio
/**
 * Audio dev harness (not part of the build): /src/audio/dev/audio-dev.html on the dev server.
 *
 * - Listen: every cue on the live engine, the match signals, the crowd bed at any intensity and a
 *   new round's crowd.
 * - Offline checks: renders each cue (at the gain the game gives it), the crowd bed at several
 *   intensities and two scripted matches through the real SoundDriver on an OfflineAudioContext,
 *   and measures levels, dynamics and spectra (analyze.ts). Results land in a table, spectrograms
 *   and `window.__audioReport` for automated runs (`?check` runs them on load).
 */

import { WEAPON_IDS } from '../../core';
import type { FighterState, GameEvent, MatchSignal, WeaponId, WorldState } from '../../core';
import { TimeDirector } from '../../app/time';
import { analyze, peakOf, powerSpectrum, toDb, windowedRmsDb } from '../analyze';
import type { SignalStats } from '../analyze';
import { chantIntensity, crowdProfile } from '../crowd';
import { SOUND_SPECS, createCueMemory, cuesForEvent, cuesForSignal } from '../cues';
import type { Cue, SoundId } from '../cues';
import { SoundDriver } from '../driver';
import { AudioEngine } from '../engine';
import { makeBanks, renderBabble } from '../synth';
import type { Banks } from '../synth';
import { MAP_H, MAP_W, fighter, world } from '../testkit';

const SR = 48000;
const $ = (id: string) => document.getElementById(id)!;
const status = (s: string) => {
  $('status').textContent = s;
};

// ---------------------------------------------------------------------------------------------
// Representative cues: produced by the real mapping from typical events, so gains are the game's.
// ---------------------------------------------------------------------------------------------

function fixtureWorld(): WorldState {
  const fs = Array.from({ length: 8 }, (_, i) => fighter(`f${i}`, 200 + i * 130, MAP_H / 2));
  const w = world(fs, 600);
  w.hazards = (['spike', 'saw', 'acid', 'fire'] as const).map((kind, i) => ({ id: `h${i}`, kind, pos: { x: 300, y: 300 }, radius: 20, phase: 0, active: true, ttl: null }));
  return w;
}

function representativeCues(): Cue[] {
  const s = fixtureWorld();
  const memory = createCueMemory();
  const out: Cue[] = [];
  const mid = () => 0.5;
  const ev = (e: GameEvent, finalKill = false) => cuesForEvent(e, s, memory, finalKill, out, mid);
  const pos = { x: MAP_W / 2, y: MAP_H / 2 };
  for (const w of WEAPON_IDS) {
    s.fighters[0]!.weapon = w;
    ev({ type: 'swing', tick: 600, fighterId: 'f0', weapon: w });
  }
  s.fighters[0]!.limbs = { armL: true, armR: false, legL: true, legR: true };
  ev({ type: 'swing', tick: 600, fighterId: 'f0', weapon: 'GREATSWORD' });
  for (const w of ['LONGBOW', 'THROWING_AXES', 'ARCANE_STAFF'] as const) {
    ev({ type: 'projectile', tick: 600, projectileId: w, ownerId: 'f0', weapon: w, pos, dir: 0 });
    ev({ type: 'projectile_end', tick: 600, projectileId: w, pos, hitId: null });
  }
  const hit = (weapon: WeaponId | null, extra: Partial<Extract<GameEvent, { type: 'hit' }>> = {}) =>
    ev({ type: 'hit', tick: 600, attackerId: 'f0', victimId: 'f1', amount: 25, pos, dir: 0, crit: false, backstab: false, weapon, knockback: 5, source: weapon ? 'weapon' : 'punch', ...extra });
  for (const w of WEAPON_IDS) hit(w);
  hit(null);
  hit('GREATSWORD', { crit: true, amount: 40 });
  hit('TWIN_DAGGERS', { backstab: true });
  ev({ type: 'parry', tick: 600, fighterId: 'f1', attackerId: 'f0', pos });
  ev({ type: 'dismember', tick: 600, attackerId: 'f0', victimId: 'f1', limb: 'armL', pos, vel: { x: 1, y: 0 } });
  const kill = (extra: Partial<Extract<GameEvent, { type: 'kill' }>> = {}) =>
    ev({ type: 'kill', tick: 600, killerId: 'f0', victimId: 'f1', cause: 'weapon', pos, dir: 0, title: 'SPLIT', killerBehaviour: null, victimBehaviour: 'x', weapon: 'GREATSWORD', flags: [], hazard: null, final: false, ...extra });
  kill();
  kill({ flags: ['crushed'], cause: 'sudden_death', killerId: null, weapon: null });
  kill({ final: true });
  ev({ type: 'explosion', tick: 600, pos, radius: 106 });
  for (const skill of ['WHIRLWIND', 'SHADOWSTEP', 'DASH', 'SHOCKWAVE', 'BLOODRAGE'] as const) ev({ type: 'skill', tick: 600, fighterId: 'f0', skill, pos });
  ev({ type: 'footstep', tick: 600, fighterId: 'f0', pos, bloody: false });
  ev({ type: 'footstep', tick: 600, fighterId: 'f0', pos, bloody: true });
  for (const kind of ['haste', 'berserk', 'arrow'] as const) ev({ type: 'pickup', tick: 600, fighterId: 'f0', kind, pos });
  for (const kind of ['haste', 'berserk'] as const) ev({ type: 'pickup_spawn', tick: 600, pickupId: kind, kind, pos });
  ev({ type: 'heal', tick: 600, fighterId: 'f0', amount: 40, pos, shrineId: 's1' });
  for (let i = 0; i < 4; i++) ev({ type: 'hazard', tick: 600, hazardId: `h${i}`, victimId: 'f1', pos });
  for (const kind of ['keg', 'amphora', 'crate'] as const) ev({ type: 'prop_break', tick: 600, propId: kind, kind, pos });
  ev({ type: 'wall_contact', tick: 600, fighterId: 'f1', damage: 2, pos });
  hit(null, { source: 'sudden_death', attackerId: null });
  hit(null, { source: 'sudden_death', attackerId: null, victimId: 'f2' });
  ev({ type: 'sudden_death', tick: 600, reason: 'time' });
  ev({ type: 'escalation', tick: 600, level: 3, damage: 10, everywhere: false });
  ev({ type: 'judges_decision', tick: 600, survivors: [] });
  ev({ type: 'match_end', tick: 600, placements: [], ending: 'elimination' });
  const sig = (signal: MatchSignal) => cuesForSignal(signal, out);
  sig({ type: 'countdown', value: 3 });
  sig({ type: 'countdown', value: 1 });
  sig({ type: 'fight' });
  // Reactions as the crowd director makes them (see CrowdDirector.emit).
  const p = crowdProfile(1);
  out.push({ sound: 'crowd_gasp', gain: 0.5, pan: 0, pitch: p.pitch, intensity: 0.7, delay: 0 });
  out.push({ sound: 'crowd_whistle', gain: 0.32, pan: 0.3, pitch: 1, intensity: 0.2, delay: 0 });
  out.push({ sound: 'crowd_boo', gain: 0.5, pan: 0, pitch: p.pitch, intensity: 0.7, delay: 0 });
  for (let v = 0; v < 3; v++) out.push({ sound: 'crowd_chant', gain: 0.5, pan: 0, pitch: p.pitch, intensity: chantIntensity(2), delay: 0, variant: v });
  // One of each sound (the first, which is the plain variant), plus every chant style.
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = c.sound === 'crowd_chant' ? `${c.sound}${c.variant}` : c.sound === 'countdown' ? `${c.sound}${c.pitch}` : c.sound;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cueLabel(c: Cue): string {
  if (c.sound === 'crowd_chant') return `crowd_chant/${['hey', 'clap', 'stomp'][c.variant ?? 0]}`;
  if (c.sound === 'countdown') return `countdown x${c.pitch.toFixed(2)}`;
  return c.sound;
}

// ---------------------------------------------------------------------------------------------
// Offline rendering
// ---------------------------------------------------------------------------------------------

let shared: { banks: Banks; babble: AudioBuffer } | null = null;

async function sharedBanks(): Promise<{ banks: Banks; babble: AudioBuffer }> {
  if (shared) return shared;
  const off = new OfflineAudioContext(2, SR, SR);
  const banks = makeBanks(off);
  const babble = await renderBabble(SR, crowdProfile(1));
  banks.babble = babble;
  shared = { banks, babble };
  return shared;
}

async function renderCue(cue: Cue): Promise<AudioBuffer> {
  const { banks } = await sharedBanks();
  const seconds = SOUND_SPECS[cue.sound].dur + 2;
  const off = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  const e = new AudioEngine(off, banks);
  e.play({ ...cue, pan: 0, delay: 0 });
  return off.startRendering();
}

async function renderBed(intensity: number, seed: number): Promise<SignalStats> {
  const { banks } = await sharedBanks();
  const off = new OfflineAudioContext(2, SR * 6, SR);
  const e = new AudioEngine(off, { ...banks });
  const profile = crowdProfile(seed);
  e.startAmbience(profile);
  e.setBabble(await renderBabble(SR, profile));
  e.setCrowd(intensity);
  const buf = await off.startRendering();
  const from = SR * 3;
  return analyze([buf.getChannelData(0).slice(from), buf.getChannelData(1).slice(from)], SR, 3);
}

/** The ambience beds alone (crowd at 0 so only they sound): the moving wall's drone, or a fighter grinding on the spikes. */
async function renderBedPart(part: 'wall' | 'grind'): Promise<SignalStats> {
  const { banks, babble } = await sharedBanks();
  const off = new OfflineAudioContext(2, SR * 6, SR);
  const e = new AudioEngine(off, { ...banks });
  e.startAmbience(crowdProfile(1));
  e.setBabble(babble);
  e.setCrowd(0);
  if (part === 'wall') e.setWallMoving(true);
  for (let k = 1; k < 59; k++) {
    void off.suspend(k * 0.1).then(() => {
      if (part === 'grind') e.setGrind(1, 0);
      e.tick(0.1);
      void off.resume();
    });
  }
  const buf = await off.startRendering();
  const from = SR * 3;
  return analyze([buf.getChannelData(0).slice(from), buf.getChannelData(1).slice(from)], SR, 3);
}

/** A scripted match: what happens at each sim tick (mutating the state) and which signals fire when (real seconds). */
type Script = {
  name: string;
  seconds: number;
  fighters: FighterState[];
  signals: { at: number; signal: MatchSignal }[];
  /** Real second at which the sim starts stepping (FIGHT). */
  fightAt: number;
  step: (tick: number, s: WorldState) => GameEvent[];
};

type SceneResult = {
  name: string;
  stats: SignalStats;
  renderMs: number;
  overHot: number;
  rms: number[];
  intensity: number[];
  log: { t: number; sound: SoundId }[];
  phases: { name: string; from: number; to: number; rmsDb: number }[];
  /** Cues the mixer refused (throttled or crowded out), by sound. */
  refused: Record<string, number>;
  buffer: AudioBuffer;
};

async function renderScene(script: Script, phases: { name: string; from: number; to: number }[]): Promise<SceneResult> {
  const { banks, babble } = await sharedBanks();
  const off = new OfflineAudioContext(2, Math.round(SR * script.seconds), SR);
  const engine = new AudioEngine(off, { ...banks });
  const log: { t: number; sound: SoundId }[] = [];
  const play = engine.play.bind(engine);
  const refused: Record<string, number> = {};
  engine.play = (cue, rand) => {
    const ok = play(cue, rand);
    if (ok) log.push({ t: off.currentTime, sound: cue.sound });
    else refused[cue.sound] = (refused[cue.sound] ?? 0) + 1;
    return ok;
  };
  const driver = new SoundDriver(engine, 77, () => Promise.resolve(babble));
  driver.startRound(77);
  await new Promise((r) => setTimeout(r, 0));
  const state = world(script.fighters, 0);
  const director = new TimeDirector();
  const dt = 1 / 60;
  const frames = Math.floor(script.seconds / dt) - 1;
  const intensity: number[] = [];
  let ticks = 0;
  let signalIdx = 0;
  const signals = [...script.signals].sort((a, b) => a.at - b.at);
  for (let k = 1; k <= frames; k++) {
    void off.suspend(k * dt).then(() => {
      const now = k * dt;
      while (signalIdx < signals.length && signals[signalIdx]!.at <= now) driver.onSignal(signals[signalIdx++]!.signal);
      const slow = director.update(dt);
      const running = now >= script.fightAt && !state.finished;
      const events: GameEvent[] = [];
      if (running) {
        ticks += 60 * dt * slow;
        while (ticks >= 1) {
          ticks -= 1;
          state.tick++;
          for (const e of script.step(state.tick, state)) events.push(e);
        }
      }
      if (events.length > 0) {
        director.onEvents(events);
        driver.onEvents(events, state);
      }
      driver.frame(dt, slow);
      if (k % 30 === 0) intensity.push(Math.round(driver.crowd.intensity * 100) / 100);
      void off.resume();
    });
  }
  const t0 = performance.now();
  const buf = await off.startRendering();
  const renderMs = performance.now() - t0;
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  let overHot = 0;
  for (let i = 0; i < L.length; i++) if (Math.abs(L[i]!) > 0.89 || Math.abs(R[i]!) > 0.89) overHot++;
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i]! + R[i]!) / 2;
  const phaseRms = phases.map((p) => {
    const a = Math.floor(p.from * SR);
    const b = Math.floor(p.to * SR);
    let sum = 0;
    for (let i = a; i < b; i++) sum += mono[i]! * mono[i]!;
    return { ...p, rmsDb: Math.round(toDb(Math.sqrt(sum / Math.max(1, b - a))) * 10) / 10 };
  });
  return {
    name: script.name,
    stats: analyze([L, R], SR, 0.4),
    renderMs,
    overHot,
    rms: windowedRmsDb(mono, SR, 0.5).map((x) => Math.round(x)),
    intensity,
    log,
    phases: phaseRms,
    refused,
    buffer: buf,
  };
}

/** A tiny seeded generator so the scripted matches are the same every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const at = (sec: number) => Math.round(sec * 60);

/** An eight-fighter match: countdown, approach, a brawl, a lull with a camper, sudden death with a fighter on the spikes, the final kill. */
function matchScript(): Script {
  const rnd = lcg(5);
  const fs = Array.from({ length: 8 }, (_, i) => fighter(`f${i}`, 140 + (i % 4) * 360, 160 + Math.floor(i / 4) * 540));
  const home = fs.map((f) => ({ ...f.pos }));
  const duel = fs.map((_, i) => ({ x: 260 + Math.floor(i / 2) * 280 + (i % 2) * 60, y: MAP_H / 2 }));
  const weapons: WeaponId[] = ['GREATSWORD', 'WARHAMMER', 'TWIN_DAGGERS', 'THROWING_AXES', 'LONGBOW', 'ARCANE_STAFF', 'GREATSWORD', 'WARHAMMER'];
  fs.forEach((f, i) => (f.weapon = weapons[i]!));
  let pid = 0;
  const step = (tick: number, s: WorldState): GameEvent[] => {
    const ev: GameEvent[] = [];
    const sec = tick / 60;
    const alive = s.fighters.filter((f) => f.alive);
    // Positions: walk in (0-5 s), brawl (5-13 s), separate (13-19 s), f7 camps in a corner throughout.
    const towards = (sec < 5 ? sec / 5 : sec < 13 ? 1 : sec < 19 ? Math.max(0, 1 - (sec - 13) / 2) : sec < 23 ? 0 : 1);
    s.fighters.forEach((f, i) => {
      if (i === 7) return;
      f.pos.x = home[i]!.x + (duel[i]!.x - home[i]!.x) * towards;
      f.pos.y = home[i]!.y + (duel[i]!.y - home[i]!.y) * towards;
    });
    for (const f of alive) if ((tick + Number(f.id.slice(1)) * 5) % 21 === 0 && f.id !== 'f7') ev.push({ type: 'footstep', tick, fighterId: f.id, pos: { ...f.pos }, bloody: sec > 9 });
    const fightOn = (sec >= 5 && sec < 13) || (sec >= 23 && sec < 27);
    if (fightOn && tick % 18 === 0) {
      const pair = sec >= 23 ? [0, 2] : [[0, 1], [2, 3], [4, 5]][Math.floor(rnd() * 3)]!;
      const [a, b] = rnd() < 0.5 ? pair : [pair[1]!, pair[0]!];
      const A = s.fighters[a!]!;
      const B = s.fighters[b!]!;
      if (A.alive && B.alive) {
        ev.push({ type: 'swing', tick, fighterId: A.id, weapon: A.weapon });
        if (A.weapon === 'LONGBOW' || A.weapon === 'THROWING_AXES' || A.weapon === 'ARCANE_STAFF') {
          const id = `p${pid++}`;
          ev.push({ type: 'projectile', tick, projectileId: id, ownerId: A.id, weapon: A.weapon, pos: { ...A.pos }, dir: 0 });
          ev.push({ type: 'projectile_end', tick, projectileId: id, pos: { ...B.pos }, hitId: rnd() < 0.7 ? B.id : null });
        }
        if (rnd() < 0.12) ev.push({ type: 'parry', tick, fighterId: B.id, attackerId: A.id, pos: { ...B.pos } });
        else {
          const amount = Math.round(10 + rnd() * 26);
          B.hp = Math.max(1, B.hp - amount);
          A.damageDealt += amount;
          ev.push({ type: 'hit', tick, attackerId: A.id, victimId: B.id, amount, pos: { ...B.pos }, dir: 0, crit: rnd() < 0.1, backstab: rnd() < 0.06, weapon: A.weapon, knockback: 5, source: 'weapon' });
        }
      }
    }
    const kill = (k: string, v: string, extra: Partial<Extract<GameEvent, { type: 'kill' }>> = {}) => {
      const K = s.fighters.find((f) => f.id === k)!;
      const V = s.fighters.find((f) => f.id === v)!;
      V.alive = false;
      V.hp = 0;
      K.kills++;
      ev.push({ type: 'kill', tick, killerId: k, victimId: v, cause: 'weapon', pos: { ...V.pos }, dir: 0, title: 'SPLIT', killerBehaviour: null, victimBehaviour: 'x', weapon: K.weapon, flags: [], hazard: null, final: false, ...extra });
    };
    if (tick === at(8.5)) ev.push({ type: 'dismember', tick, attackerId: 'f2', victimId: 'f3', limb: 'armL', pos: { ...s.fighters[3]!.pos }, vel: { x: 2, y: 0 } });
    if (tick === at(9.5)) kill('f0', 'f1');
    if (tick === at(11)) kill('f0', 'f4');
    if (tick === at(12.2)) kill('f2', 'f3');
    if (tick === at(12.6)) kill('f0', 'f5', { flags: ['multi'] });
    if (tick === at(19)) {
      s.suddenDeath.active = true;
      s.suddenDeath.closedAtTick = -1;
      ev.push({ type: 'sudden_death', tick, reason: 'stalemate' });
    }
    // f6 on the spikes for 2.5 s (contact every tick, its damage as a hit), then crushed.
    if (sec >= 20 && sec < 22.5 && s.fighters[6]!.alive) {
      const pos = { x: s.suddenDeath.bounds.x + 2, y: s.fighters[6]!.pos.y };
      ev.push({ type: 'wall_contact', tick, fighterId: 'f6', damage: 1, pos });
      ev.push({ type: 'hit', tick, attackerId: null, victimId: 'f6', amount: 1, pos, dir: 0, crit: false, backstab: false, weapon: null, knockback: 3, source: 'sudden_death' });
    }
    if (tick === at(22.5)) kill('f6', 'f6', { killerId: null, cause: 'sudden_death', weapon: null, flags: ['crushed'], title: 'CRUSHED' });
    // The floor bites the camper now and then.
    if (sec >= 21 && sec < 23 && tick % 10 === 0) ev.push({ type: 'hit', tick, attackerId: null, victimId: 'f7', amount: 4, pos: { ...s.fighters[7]!.pos }, dir: 0, crit: false, backstab: false, weapon: null, knockback: 0, source: 'sudden_death' });
    if (tick === at(24)) kill('f0', 'f7');
    if (tick === at(27)) {
      kill('f0', 'f2', { final: true });
      s.finished = true;
      s.ending = 'elimination';
      ev.push({ type: 'match_end', tick, placements: ['f0'], ending: 'elimination' });
    }
    return ev;
  };
  const fightAt = 2.4;
  return {
    name: 'match',
    seconds: 36,
    fighters: fs,
    fightAt,
    signals: [
      { at: 0, signal: { type: 'countdown', value: 3 } },
      { at: 0.8, signal: { type: 'countdown', value: 2 } },
      { at: 1.6, signal: { type: 'countdown', value: 1 } },
      { at: fightAt, signal: { type: 'fight' } },
    ],
    // No final_kill signal here: the final sting must also play from the kill event alone.
    step,
  };
}

/** Sixteen fighters all swinging at once for 12 s: the mix must hold. */
function stressScript(): Script {
  const rnd = lcg(9);
  const fs = Array.from({ length: 16 }, (_, i) => fighter(`f${i}`, 120 + (i % 8) * 150 + (i >= 8 ? 40 : 0), 300 + (i >= 8 ? 60 : 0)));
  fs.forEach((f, i) => (f.weapon = WEAPON_IDS[i % WEAPON_IDS.length]!));
  return {
    name: 'stress16',
    seconds: 13,
    fighters: fs,
    fightAt: 0,
    signals: [],
    step: (tick, s) => {
      const ev: GameEvent[] = [];
      for (let i = 0; i < 16; i++) {
        const A = s.fighters[i]!;
        const B = s.fighters[(i + 8) % 16]!;
        if (!A.alive || !B.alive) continue;
        if ((tick + i * 3) % 20 === 0) {
          ev.push({ type: 'swing', tick, fighterId: A.id, weapon: A.weapon });
          const amount = Math.round(8 + rnd() * 30);
          A.damageDealt += amount;
          ev.push({ type: 'hit', tick, attackerId: A.id, victimId: B.id, amount, pos: { ...B.pos }, dir: 0, crit: rnd() < 0.15, backstab: rnd() < 0.1, weapon: A.weapon, knockback: 5, source: 'weapon' });
        }
        if ((tick + i) % 14 === 0) ev.push({ type: 'footstep', tick, fighterId: A.id, pos: { ...A.pos }, bloody: true });
        if ((tick + i * 7) % 97 === 0) ev.push({ type: 'parry', tick, fighterId: B.id, attackerId: A.id, pos: { ...B.pos } });
      }
      if (tick % 120 === 60 && tick < 700) {
        const v = s.fighters.find((f, i) => f.alive && i >= 8);
        if (v) {
          v.alive = false;
          s.fighters[0]!.kills++;
          ev.push({ type: 'kill', tick, killerId: 'f0', victimId: v.id, cause: 'weapon', pos: { ...v.pos }, dir: 0, title: 'SPLIT', killerBehaviour: null, victimBehaviour: 'x', weapon: 'GREATSWORD', flags: tick > 300 ? ['multi'] : [], hazard: null, final: false });
          ev.push({ type: 'dismember', tick, attackerId: 'f0', victimId: v.id, limb: 'legL', pos: { ...v.pos }, vel: { x: 0, y: 1 } });
          ev.push({ type: 'explosion', tick, pos: { ...v.pos }, radius: 100 });
        }
      }
      return ev;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

function drawSpectrogram(canvas: HTMLCanvasElement, buf: AudioBuffer, label: string): void {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0);
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i]! + R[i]!) / 2;
  const w = canvas.width;
  const h = canvas.height;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(w, h);
  const size = 1024;
  const lo = Math.log(40);
  const hi = Math.log(18000);
  // Two passes: the colour scale spans 80 dB under the loudest cell.
  const cols: Float64Array[] = [];
  let top = -Infinity;
  for (let x = 0; x < w; x++) {
    const start = Math.floor((x / w) * (mono.length - size));
    const spec = powerSpectrum(mono, start, start + size, size);
    for (const p of spec) top = Math.max(top, 10 * Math.log10(p + 1e-12));
    cols.push(spec);
  }
  for (let x = 0; x < w; x++) {
    const spec = cols[x]!;
    for (let y = 0; y < h; y++) {
      const hz = Math.exp(lo + (1 - y / h) * (hi - lo));
      const k = Math.min(spec.length - 1, Math.round((hz * size) / SR));
      const db = 10 * Math.log10(spec[k]! + 1e-12) - top;
      const v = Math.min(1, Math.max(0, (db + 80) / 80));
      const o = (y * w + x) * 4;
      img.data[o] = Math.round(255 * Math.min(1, v * 1.6));
      img.data[o + 1] = Math.round(255 * Math.max(0, v * 1.6 - 0.6));
      img.data[o + 2] = Math.round(255 * Math.max(0, v - 0.75) * 3);
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = '#e8e2d9';
  g.font = '11px monospace';
  g.fillText(`${label}  (40 Hz - 18 kHz, log; 80 dB range)`, 6, 13);
}

function drawLevels(canvas: HTMLCanvasElement, scene: SceneResult): void {
  const g = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  g.fillStyle = '#161412';
  g.fillRect(0, 0, w, h);
  const y = (db: number) => h - ((db + 70) / 70) * h;
  g.strokeStyle = '#3a352f';
  for (const db of [-60, -40, -20, -6]) {
    g.beginPath();
    g.moveTo(0, y(db));
    g.lineTo(w, y(db));
    g.stroke();
    g.fillStyle = '#a39a8e';
    g.fillText(`${db} dB`, 4, y(db) - 2);
  }
  const plot = (values: number[], map: (v: number) => number, color: string) => {
    g.strokeStyle = color;
    g.beginPath();
    values.forEach((v, i) => {
      const px = (i / Math.max(1, values.length - 1)) * w;
      if (i === 0) g.moveTo(px, map(v));
      else g.lineTo(px, map(v));
    });
    g.stroke();
  };
  plot(scene.rms, y, '#e8e2d9');
  plot(scene.intensity, (v) => h - v * h * 0.9, '#c4302b');
  g.fillStyle = '#e8e2d9';
  g.fillText(`${scene.name}: RMS per 0.5 s (white), crowd intensity 0..1 (red)`, 60, 13);
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
const pct = (x: number) => Math.round(x * 100);

async function runChecks(): Promise<void> {
  const box = $('checks');
  box.innerHTML = '';
  status('Rendering cues...');
  const cues = representativeCues();
  const rows: { name: string; group: string; gain: number; stats: SignalStats; buf: AudioBuffer }[] = [];
  for (const cue of cues) {
    const buf = await renderCue(cue);
    rows.push({ name: cueLabel(cue), group: SOUND_SPECS[cue.sound].group, gain: cue.gain, stats: analyze([buf.getChannelData(0), buf.getChannelData(1)], SR), buf });
  }
  const table = document.createElement('table');
  table.innerHTML =
    '<tr><th>cue</th><th>group</th><th>gain</th><th>peak dB</th><th>loud dB</th><th>crest</th><th>attack ms</th><th>len ms</th><th>centroid</th><th>sub</th><th>low</th><th>lmid</th><th>mid</th><th>high</th><th>air</th><th>edge</th></tr>' +
    rows
      .map((r) => {
        const s = r.stats;
        const hot = s.peakDb > -1 ? ' class="warn"' : '';
        const b = s.bands;
        return `<tr><td>${r.name}</td><td>${r.group}</td><td>${r.gain.toFixed(2)}</td><td${hot}>${f1(s.peakDb)}</td><td>${f1(s.loudDb)}</td><td>${f1(s.crestDb)}</td><td>${f1(s.attackMs)}</td><td>${Math.round(s.lengthMs)}</td><td>${Math.round(s.centroidHz)}</td><td>${pct(b.sub)}</td><td>${pct(b.low)}</td><td>${pct(b.lowMid)}</td><td>${pct(b.mid)}</td><td>${pct(b.high)}</td><td>${pct(b.air)}</td><td${s.edgeJump ? ' class="warn"' : ''}>${s.edgeJump ? 'JUMP' : ''}</td></tr>`;
      })
      .join('');
  box.appendChild(table);

  status('Rendering the crowd bed...');
  const bed: { seed: number; intensity: number; loudDb: number; centroidHz: number }[] = [];
  for (const seed of [1, 2, 3]) {
    for (const i of [0, 0.25, 0.5, 1]) {
      const s = await renderBed(i, seed);
      bed.push({ seed, intensity: i, loudDb: Math.round(s.loudDb * 10) / 10, centroidHz: Math.round(s.centroidHz) });
    }
  }
  const parts: { part: string; loudDb: number; centroidHz: number }[] = [];
  for (const part of ['wall', 'grind'] as const) {
    const st = await renderBedPart(part);
    parts.push({ part, loudDb: Math.round(st.loudDb * 10) / 10, centroidHz: Math.round(st.centroidHz) });
  }
  const pre = document.createElement('pre');
  pre.textContent =
    'Crowd bed (RMS 3-6 s after setCrowd):\n' +
    bed.map((b) => `  seed ${b.seed} intensity ${b.intensity}: ${b.loudDb} dBFS, centroid ${b.centroidHz} Hz`).join('\n') +
    '\n' +
    parts.map((p) => `  ${p.part} (crowd at 0): ${p.loudDb} dBFS, centroid ${p.centroidHz} Hz`).join('\n');
  box.appendChild(pre);

  status('Rendering the scripted match...');
  const match = await renderScene(matchScript(), [
    { name: 'countdown', from: 0, to: 2.4 },
    { name: 'approach', from: 3, to: 7.2 },
    { name: 'brawl', from: 8, to: 15 },
    { name: 'lull', from: 18, to: 21 },
    { name: 'spikes', from: 22.5, to: 25 },
    { name: 'final', from: 29.4, to: 33 },
  ]);
  status('Rendering 16 fighters at once...');
  const stress = await renderScene(stressScript(), [{ name: 'all', from: 0.5, to: 12.5 }]);
  for (const scene of [match, stress]) {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 160;
    drawLevels(c, scene);
    box.appendChild(c);
    const sc = document.createElement('canvas');
    sc.width = 1200;
    sc.height = 200;
    drawSpectrogram(sc, scene.buffer, `${scene.name} spectrogram`);
    box.appendChild(sc);
    const p = document.createElement('pre');
    const reactions = scene.log.filter((l) => l.sound.startsWith('crowd_') || SOUND_SPECS[l.sound].group === 'signal');
    p.textContent = [
      `${scene.name}: peak ${f1(scene.stats.peakDb)} dBFS, loudest 0.4 s ${f1(scene.stats.loudDb)} dBFS, samples over -1 dBFS: ${scene.overHot}, rendered ${Math.round(scene.renderMs)} ms for ${(scene.buffer.duration).toFixed(0)} s`,
      `phases: ${scene.phases.map((ph) => `${ph.name} ${ph.rmsDb} dB`).join(', ')}`,
      `crowd + signals: ${reactions.map((l) => `${l.t.toFixed(2)} ${l.sound}`).join(', ')}`,
      `voices played: ${scene.log.length}`,
    ].join('\n');
    box.appendChild(p);
  }
  for (const name of ['hit_blade', 'parry', 'death_splat', 'crowd_roar', 'final_sting', 'fight', 'heal', 'crush']) {
    const r = rows.find((x) => x.name === name);
    if (!r) continue;
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 120;
    drawSpectrogram(c, r.buf, name);
    box.appendChild(c);
  }

  const report = {
    cues: rows.map((r) => ({ name: r.name, group: r.group, gain: r.gain, ...r.stats })),
    bed,
    parts,
    scenes: [match, stress].map((s) => ({ name: s.name, peakDb: s.stats.peakDb, loudDb: s.stats.loudDb, overHot: s.overHot, renderMs: Math.round(s.renderMs), phases: s.phases, rms: s.rms, intensity: s.intensity, refused: s.refused, crowd: s.log.filter((l) => l.sound.startsWith('crowd_') || SOUND_SPECS[l.sound].group === 'signal').map((l) => [Math.round(l.t * 100) / 100, l.sound]), voices: s.log.length })),
  };
  (window as unknown as { __audioReport: unknown }).__audioReport = report;
  const json = document.createElement('pre');
  json.id = 'report-json';
  json.textContent = JSON.stringify(report);
  box.appendChild(json);
  // Survives the tab: automated runs read it back from a fresh load of this page.
  try {
    localStorage.setItem('pit-audio-report', JSON.stringify(report));
  } catch {
    // Storage blocked: the window copy is all there is.
  }
  // Keep the scene to listen to.
  sceneBuffer = match.buffer;
  status('Done.');
}

let live: { ctx: AudioContext; driver: SoundDriver } | null = null;
let sceneBuffer: AudioBuffer | null = null;

function liveDriver(): { ctx: AudioContext; driver: SoundDriver } {
  if (live) return live;
  const ctx = new AudioContext();
  const engine = new AudioEngine(ctx);
  const driver = new SoundDriver(engine, 1);
  live = { ctx, driver };
  const tick = () => {
    driver.frame(0.05, 1);
  };
  setInterval(tick, 50);
  return live;
}

function buildListen(): void {
  const box = $('listen');
  const cues = representativeCues();
  const groups = new Map<string, Cue[]>();
  for (const c of cues) {
    const g = SOUND_SPECS[c.sound].group;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  for (const [g, list] of groups) {
    const row = document.createElement('div');
    row.className = 'group';
    row.innerHTML = `<b>${g}</b>`;
    for (const cue of list) {
      const b = document.createElement('button');
      b.textContent = cueLabel(cue);
      b.onclick = () => {
        const l = liveDriver();
        void l.ctx.resume();
        l.driver.engine.play({ ...cue });
      };
      row.appendChild(b);
    }
    box.appendChild(row);
  }
  const ctl = document.createElement('div');
  ctl.className = 'group';
  ctl.innerHTML = '<b>crowd</b>';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.05';
  slider.value = '0';
  slider.oninput = () => {
    const l = liveDriver();
    void l.ctx.resume();
    l.driver.crowd.energy = Number(slider.value);
  };
  ctl.appendChild(slider);
  const round = document.createElement('button');
  round.textContent = 'New round crowd';
  round.onclick = () => {
    const l = liveDriver();
    void l.ctx.resume();
    l.driver.startRound(Math.floor(Math.random() * 1e9));
  };
  ctl.appendChild(round);
  const scene = document.createElement('button');
  scene.textContent = 'Play rendered match';
  scene.onclick = () => {
    if (!sceneBuffer) return status('Run the offline checks first.');
    const l = liveDriver();
    void l.ctx.resume();
    const s = l.ctx.createBufferSource();
    s.buffer = sceneBuffer;
    s.connect(l.ctx.destination);
    s.start();
  };
  ctl.appendChild(scene);
  box.appendChild(ctl);
}

buildListen();
$('run').onclick = () => void runChecks().catch((e: unknown) => status(`Failed: ${String(e)}`));
if (new URLSearchParams(location.search).has('check')) void runChecks().catch((e: unknown) => status(`Failed: ${String(e)}`));

// Peaks over all channels are also exposed for quick console checks.
(window as unknown as { __peakOf: typeof peakOf }).__peakOf = peakOf;
