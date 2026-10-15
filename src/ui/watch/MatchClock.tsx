// Owned by: ui
import { TICK_HZ } from '../../core';
import type { GameController, UiSnapshot } from '../../core';
import { formatClock } from '../format';
import { PauseIcon, PlayIcon } from '../icons';
import { SPEED_PRESETS } from '../keys';

/** Warn this long before the wall starts closing in. */
const SUDDEN_DEATH_WARNING_TICKS = 15 * TICK_HZ;

/** Top-centre broadcast bug: play/pause, match time, state line, speed presets. */
export function MatchClock({ controller, snap }: { controller: GameController; snap: UiSnapshot }) {
  const { tick, timeLimitTicks, suddenDeath, paused, finished, speed } = snap;
  const left = timeLimitTicks - tick;
  const alive = snap.fighters.filter((f) => f.alive).length;

  let state: string;
  let hot = false;
  if (finished) state = 'Final';
  else if (paused) {
    state = 'Paused';
    hot = true;
  } else if (suddenDeath) {
    state = 'Sudden death';
    hot = true;
  } else if (left > 0 && left <= SUDDEN_DEATH_WARNING_TICKS) state = `Sudden death in ${formatClock(left + TICK_HZ - 1)}`;
  else state = `${alive} standing`;

  const progress = timeLimitTicks > 0 ? Math.min(1, tick / timeLimitTicks) : 0;

  return (
    <div className="clock">
      <button
        type="button"
        className={`play${paused ? ' paused' : ''}`}
        onClick={() => controller.setPaused(!paused)}
        aria-label={paused ? 'Play (Space)' : 'Pause (Space)'}
        title={paused ? 'Play (Space)' : 'Pause (Space)'}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </button>
      <div className="clock-face" aria-live="off">
        <span className="clock-time">{formatClock(tick)}</span>
        <span className={`clock-state${hot ? ' hot' : ''}`}>{state}</span>
        <div className={`clock-bar${suddenDeath ? ' hot' : ''}`} aria-hidden>
          <div style={{ transform: `scaleX(${suddenDeath ? 1 : progress})` }} />
        </div>
      </div>
      <div className="seg speeds" role="group" aria-label="Playback speed">
        {SPEED_PRESETS.map((s, i) => (
          <button
            key={s}
            type="button"
            aria-pressed={speed === s}
            onClick={() => controller.setSpeed(s)}
            title={`${s}x speed (${i + 1})`}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  );
}
