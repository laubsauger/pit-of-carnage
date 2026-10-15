/**
 * The kill punch envelope: how strong the screen's kill punch (chromatic split, contrast kick, red
 * edge grade in post.ts) is right now. Pure state, no three.js.
 *
 * Everything here runs on real time, never game time. At 4x speed kills arrive four times as often
 * in real seconds; if every kill restarted a full punch, the punches would overlap into a screen
 * that stays tinted red. So a kill only punches fully when the last punch is a while back: a kill
 * soon after another tops the punch up a little (in proportion to the quiet time before it), and a
 * steady stream of kills settles into a faint flicker. The final kill always punches fully.
 */

/** Punch lost per real second (a full punch is gone in about 0.3 s). */
export const PUNCH_DECAY = 3.2;
/** Real seconds after a punch before the next kill may punch at full strength again. */
export const PUNCH_RECOVERY = 0.9;

export class KillPunch {
  /** Current strength 0..1 (feeds the post-processing uniform). */
  value = 0;
  /** Real seconds since the last punch started. */
  private since = Infinity;

  /** A live kill landed. `final`: the match-deciding kill, which always punches fully. */
  kick(final = false): void {
    const k = final ? 1 : Math.min(1, this.since / PUNCH_RECOVERY);
    this.value = Math.max(this.value, k);
    this.since = 0;
  }

  /** Advance by `realDt` wall-clock seconds (never scaled by playback speed or slow motion). */
  update(realDt: number): void {
    const dt = Math.max(0, realDt);
    this.since += dt;
    this.value = Math.max(0, this.value - dt * PUNCH_DECAY);
  }

  reset(): void {
    this.value = 0;
    this.since = Infinity;
  }
}
