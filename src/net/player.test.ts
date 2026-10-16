import { describe, expect, it } from 'vitest';
import type { Decision, GameEvent, MatchSignal } from '../core';
import type { DecodedMind } from './mind';
import { MAPS } from '../sim';
import { PLAYER_TIMING, StreamPlayer } from './player';
import type { StreamOutput } from './player';
import { decodeFrame, encodeFrame, mapFingerprint } from './snapshot';
import type { DecodedFrame, StreamMatchInfo } from './snapshot';
import { houseMatch, stepFrames } from './testkit';

const DELAY = PLAYER_TIMING.delayMs;

/** A real match recorded as decoded frames, one every 3 ticks, 50 ms apart in host time from `fightAt`. */
function recorded(opts: { seed?: number; maxTicks?: number; fightAt?: number; owners?: (string | null)[] } = {}) {
  const match = houseMatch(opts.seed ?? 3, 'pit', 6);
  const map = MAPS.pit!;
  const fightAt = opts.fightAt ?? 0;
  const info: StreamMatchInfo = {
    id: 1, mapId: 'pit', mapHash: mapFingerprint(map), seed: 3, format: 'ffa', timeLimitTicks: 5400, suddenDeath: true, friendlyFire: true, fightAt,
    fighters: match.state.fighters.map((f, i) => ({
      id: f.id, entrantId: f.entrantId, squad: f.squad, name: f.name, color: f.color, weapon: f.weapon, skill: f.skill, attributes: f.attributes,
      radius: f.radius, owner: opts.owners?.[i] ?? null,
    })),
  };
  const index = new Map(match.state.fighters.map((f, i) => [f.id, i]));
  const frames: DecodedFrame[] = [];
  const add = (ms: number, events: GameEvent[]) => {
    const d = decodeFrame(JSON.parse(JSON.stringify(encodeFrame(1, ms, 1, match.state, events, index))), info, map);
    if (!d) throw new Error('test frame refused');
    frames.push(d);
  };
  // The line-up before the fight: tick 0 every 400 ms.
  for (let ms = 0; ms < fightAt; ms += 400) add(ms, []);
  stepFrames(match, 3, opts.maxTicks ?? 20_000, (state, events) => add(fightAt + (state.tick / 3) * 50, events));
  return { info, map, frames, match };
}

/** Push every frame on time (arriving at local `t0 + ms`) and advance once per 1/60 s until all is shown. */
function playAll(player: StreamPlayer, frames: DecodedFrame[], t0 = 1000): StreamOutput[] {
  const outs: StreamOutput[] = [];
  const end = frames.at(-1)!.ms + t0 + DELAY + 100;
  let next = 0;
  for (let now = t0; now <= end; now += 1000 / 60) {
    while (next < frames.length && frames[next]!.ms + t0 <= now) player.push(frames[next++]!, now);
    const out = player.advance(now);
    if (out) outs.push(out);
  }
  return outs;
}

// Real matches recorded as frames: generous under a loaded machine, still bounded.
describe('stream player', { timeout: 60_000 }, () => {
  it('shows the two frames around now, a short buffer behind the newest', () => {
    const { info, map, frames } = recorded({ maxTicks: 30 });
    const p = new StreamPlayer();
    p.begin(info, map);
    for (const f of frames.slice(0, 3)) p.push(f, 1000 + f.ms);
    // Frames arrived on time at local 1000 + their host ms. Playback runs DELAY behind: 25 ms
    // past the first frame's time it shows halfway from the first frame to the second.
    const out = p.advance(1000 + DELAY + frames[0]!.ms + 25)!;
    expect(out.prev).toBe(frames[0]!.state);
    expect(out.curr).toBe(frames[1]!.state);
    expect(out.alpha).toBeCloseTo(0.5, 5);
    expect(out.reset).toBe(true);
    expect(p.advance(1000 + DELAY + 26)!.reset).toBe(false);
  });

  it('hands over every event exactly once and in order', () => {
    // Doubled events would double blood and sounds; lost ones would drop kills from the feed.
    const { info, map, frames } = recorded({ maxTicks: 1500 });
    const p = new StreamPlayer();
    p.begin(info, map);
    const got = playAll(p, frames).flatMap((o) => o.events);
    expect(got).toEqual(frames.flatMap((f) => f.events));
    expect(got.length).toBeGreaterThan(50);
  });

  it('gives a tab that stopped drawing every event it missed', () => {
    const { info, map, frames } = recorded({ maxTicks: 3000 });
    expect(frames.length).toBeGreaterThan(PLAYER_TIMING.maxFrames);
    const p = new StreamPlayer();
    p.begin(info, map);
    for (const f of frames) p.push(f, 1000 + f.ms); // no advance in between: a hidden tab
    const out = p.advance(1000 + frames.at(-1)!.ms + DELAY)!;
    expect(out.events).toEqual(frames.flatMap((f) => f.events));
    expect(out.curr).toBe(frames.at(-1)!.state);
  });

  it('repaints the match so far when the arena attaches again', () => {
    const { info, map, frames } = recorded({ maxTicks: 900 });
    const p = new StreamPlayer();
    p.begin(info, map);
    const before = playAll(p, frames).flatMap((o) => o.events);
    p.requestReset();
    const out = p.advance(1e9)!;
    expect(out.reset).toBe(true);
    expect(out.events).toEqual(before);
  });

  it('plays further behind when frames come late, so motion stays smooth', () => {
    const { info, map, frames } = recorded({ maxTicks: 120 });
    const p = new StreamPlayer();
    p.begin(info, map);
    const at = (i: number) => 1000 + frames[i]!.ms;
    p.push(frames[0]!, at(0));
    p.push(frames[1]!, at(1));
    // From frame 2 on, everything arrives 250 ms later than the first frames did (a slower route).
    const slip = 250;
    for (let i = 2; i < frames.length - 1; i++) {
      p.push(frames[i]!, at(i) + slip);
      // Halfway to the next arrival the picture must be moving between two frames, not frozen
      // on the newest one waiting for more (that would stutter at every frame).
      const out = p.advance(at(i) + slip + 25)!;
      if (i > 3) expect(out.curr, `frame ${i}`).not.toBe(out.prev);
    }
    expect(p.lagMs).toBe(DELAY + slip);
    // A frame that is seconds late does not push playback back without limit.
    p.push(frames.at(-1)!, 1e6);
    expect(p.lagMs).toBe(DELAY + PLAYER_TIMING.maxExtraDelayMs);
  });

  it('creeps back toward live once the route is fast again', () => {
    const { info, map, frames } = recorded({ maxTicks: 900 });
    const p = new StreamPlayer();
    p.begin(info, map);
    const at = (i: number) => 1000 + frames[i]!.ms;
    p.push(frames[0]!, at(0));
    p.push(frames[1]!, at(1) + 300); // one spike
    const spiked = p.lagMs;
    expect(spiked).toBe(DELAY + 300); // a full buffer of headroom past the spike
    // Then every frame arrives right away (the spike's extra delay is now pure headroom).
    for (let i = 2; i < frames.length; i++) p.push(frames[i]!, at(i));
    expect(p.lagMs).toBeLessThan(spiked);
    expect(p.lagMs).toBeGreaterThanOrEqual(DELAY);
    // Never faster than about 4%: it takes many frames, not one, so motion stays smooth.
    expect(spiked - p.lagMs).toBeLessThanOrEqual((frames.length - 2) * PLAYER_TIMING.catchUpMsPerFrame);
  });

  it('beats the countdown, FIGHT, the final kill and the victory once each, in real time', () => {
    const { info, map, frames } = recorded({ fightAt: 3600 });
    const p = new StreamPlayer();
    p.begin(info, map);
    const signals: MatchSignal[] = playAll(p, frames).flatMap((o) => o.signals);
    const finalKill = frames.flatMap((f) => f.events).find((e) => e.type === 'kill' && e.final);
    expect(finalKill, 'the recorded match ends in a final kill').toBeDefined();
    if (finalKill?.type !== 'kill') return;
    expect(signals).toEqual([
      { type: 'countdown', value: 3 },
      { type: 'countdown', value: 2 },
      { type: 'countdown', value: 1 },
      { type: 'fight' },
      { type: 'final_kill', killerId: finalKill.killerId, victimId: finalKill.victimId, pos: finalKill.pos },
      // The winner's moment follows the final kill in the same frame (pose, spotlight, one roar).
      { type: 'victory', winnerIds: [finalKill.killerId], ending: 'elimination' },
    ]);
  });

  it('brings the end card up after the final moment, and takes it down for the next match', () => {
    // The crowd quiets and the winner holds the pose while the end card is up; it must come once,
    // come back after the arena is wiped (reset), and go away when the next match starts.
    const { info, map, frames, match } = recorded({ fightAt: 0 });
    const p = new StreamPlayer();
    p.begin(info, map);
    const outs = playAll(p, frames);
    const lastNow = 1000 + frames.at(-1)!.ms + DELAY + 100;
    const ends = (o: StreamOutput[]) => o.flatMap((x) => x.signals).filter((s) => s.type === 'end_card');
    expect(ends(outs), 'not during the final moment').toEqual([]);
    const later: StreamOutput[] = [];
    for (let now = lastNow; now <= lastNow + PLAYER_TIMING.finalMs + 200; now += 1000 / 60) later.push(p.advance(now)!);
    const winner = match.state.placements[0]!;
    expect(ends(later)).toEqual([{ type: 'end_card', shown: true, winnerIds: [winner] }]);
    expect(p.endCardShown).toBe(true);
    p.requestReset();
    expect(ends([p.advance(lastNow + 5000)!])).toEqual([{ type: 'end_card', shown: true, winnerIds: [winner] }]);
    p.begin({ ...info, id: 2 }, map);
    p.push({ ...frames[0]!, matchId: 2 }, 10_000);
    expect(ends([p.advance(10_000 + DELAY)!])).toEqual([{ type: 'end_card', shown: false, winnerIds: [] }]);
  });

  it('shows the end card at once to someone who arrives after the end, with no victory beat', () => {
    const { info, map, frames } = recorded({ maxTicks: 20_000 });
    const p = new StreamPlayer();
    p.begin(info, map);
    const last = { ...frames.at(-1)!, events: [] };
    p.push(last, 0);
    const signals = p.advance(DELAY)!.signals;
    expect(signals.map((s) => s.type)).toEqual(['end_card']);
    expect(signals[0]).toMatchObject({ shown: true });
  });

  it("shows the selected fighter's thinking in step with the picture, and nobody else's", () => {
    const { info, map, frames } = recorded({ maxTicks: 120 });
    const p = new StreamPlayer();
    p.begin(info, map);
    for (const f of frames) p.push(f, 1000 + f.ms);
    const think = (behaviour: string): Decision => ({
      behaviour, scores: { [behaviour]: 1 }, targetId: null, heading: 0, speed: 1, ring: [], terms: [], attack: false, parry: false, useSkill: false,
      stance: 'normal', sensors: {}, guardTrips: [],
    });
    const mind = (fighterId: string, i: number): DecodedMind => ({ matchId: 1, ms: frames[i]!.ms, tick: frames[i]!.tick, fighterId, decision: think(`at${i}`), knowledge: [] });
    // Before a selection nothing is kept: minds are opt-in.
    p.pushMind(mind('f1', 1));
    p.select('f1');
    p.pushMind(mind('f1', 2));
    p.pushMind(mind('f2', 3)); // someone else's (a stale reply): not shown as f1's
    p.pushMind(mind('f1', 5));
    p.advance(1000 + DELAY + frames[3]!.ms);
    expect(p.decision('f1')?.behaviour).toBe('at2');
    expect(p.decision('f2')).toBeNull();
    expect(p.knowledge('f2')).toEqual([]);
    p.advance(1000 + DELAY + frames[6]!.ms);
    expect(p.decision('f1')?.behaviour).toBe('at5');
    p.select('ghost');
    expect(p.selected).toBeNull();
    expect(p.decision('f1')).toBeNull();
    p.select('f1');
    p.begin({ ...info, id: 2 }, map);
    expect(p.selected, 'a new match starts with nobody selected (ids repeat)').toBeNull();
  });

  it('paints the gore of a match joined late before anything else, once', () => {
    const { info, map, frames } = recorded({ maxTicks: 1500 });
    const all = frames.flatMap((f) => f.events);
    const cut = 300;
    const before = all.filter((e) => e.tick <= frames[cut]!.tick);
    const kills = before.filter((e) => e.type === 'kill');
    expect(kills.length, 'the recorded match has early kills').toBeGreaterThan(0);
    const p = new StreamPlayer();
    p.begin(info, map);
    expect(p.history(2, before), 'another match').toBe(false);
    expect(p.history(1, before)).toBe(true);
    const late = frames.slice(cut + 1);
    const outs = playAll(p, late, 1000 - late[0]!.ms);
    expect(outs[0]!.reset).toBe(true);
    expect(outs[0]!.events.slice(0, before.length)).toEqual(before);
    expect(p.view()!.feed.filter((f) => f.kind === 'kill').length).toBeGreaterThanOrEqual(kills.length);
    // Once frames flow, a second summary would paint everything twice.
    expect(p.history(1, before)).toBe(false);
  });

  it("keeps a guest's memory bounded whatever the host sends", () => {
    // A hostile host floods kills into every frame and nobody draws (the room screen only samples).
    const { info, map, frames } = recorded({ maxTicks: 30 });
    const p = new StreamPlayer();
    p.begin(info, map);
    const base = frames[0]!;
    const perFrame = 100;
    const count = 400;
    for (let i = 0; i < count; i++) {
      const events: GameEvent[] = Array.from({ length: perFrame }, () => ({
        type: 'kill', tick: base.tick, killerId: 'f0', victimId: 'f1', cause: 'weapon', pos: { x: 1, y: 1 }, dir: 0, title: 'AGAIN', killerBehaviour: null,
        victimBehaviour: 'x', weapon: null, flags: [], hazard: null, final: false,
      }));
      p.push({ ...base, ms: i * 50, events }, i * 50);
    }
    expect(p.feed.length).toBeLessThanOrEqual(PLAYER_TIMING.maxFeed);
    expect(p.marks.length).toBeLessThanOrEqual(PLAYER_TIMING.maxMarks);
    // What waits for an arena is capped too (uncapped it would be all 40 000).
    const out = p.advance(count * 50 + DELAY)!;
    expect(out.events.length).toBeLessThanOrEqual(PLAYER_TIMING.maxLog + PLAYER_TIMING.maxFrames * perFrame);
    expect(out.events.length).toBeLessThan(count * perFrame);
  });

  it('does not shout FIGHT at someone who joins mid-match', () => {
    const { info, map, frames } = recorded({ fightAt: 0, maxTicks: 1200 });
    const p = new StreamPlayer();
    p.begin(info, map);
    const late = frames.slice(100);
    const signals = playAll(p, late, 1000 - late[0]!.ms).flatMap((o) => o.signals);
    expect(signals.filter((s) => s.type === 'countdown' || s.type === 'fight')).toEqual([]);
  });

  it('builds the feed from the sim copy and names who brought each fighter', () => {
    const owners = ['Flo', null, 'Ana', null, null, null];
    const { info, map, frames, match } = recorded({ owners });
    const p = new StreamPlayer();
    p.begin(info, map);
    playAll(p, frames);
    const v = p.view()!;
    expect(v.finished).toBe(true);
    expect(v.placements).toEqual(match.state.placements);
    const kills = frames.flatMap((f) => f.events).filter((e) => e.type === 'kill');
    expect(v.feed.filter((f) => f.kind === 'kill')).toHaveLength(kills.length);
    expect(v.marks.filter((m) => m.kind === 'kill')).toHaveLength(kills.length);
    expect(v.feed[0]!.text).toMatch(/2 from the room, 4 from the house/);
    const winner = match.state.fighters.find((f) => f.id === match.state.placements[0])!;
    expect(v.feed.at(-1)!.text).toContain(winner.name);
    expect(v.owners).toEqual(Object.fromEntries(match.state.fighters.map((f, i) => [f.id, owners[i]])));
    expect(v.countdown).toBeNull();
  });

  it('forgets the previous match when a new one begins', () => {
    const a = recorded({ maxTicks: 300 });
    const p = new StreamPlayer();
    p.begin(a.info, a.map);
    playAll(p, a.frames);
    p.begin({ ...a.info, id: 2 }, a.map);
    expect(p.feed).toHaveLength(1);
    expect(p.advance(1e9)).toBeNull();
    p.push(a.frames[0]!, 0); // a straggler from match 1
    expect(p.advance(1e9)).toBeNull();
  });
});
