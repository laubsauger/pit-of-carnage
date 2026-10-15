// Owned by: ui
import { useEffect, useRef, useState } from 'react';
import { MAX_FIGHTERS, MIN_FIGHTERS } from '../../core';
import type { MatchFormat } from '../../core';
import { MAPS } from '../../sim';
import { readInt } from '../batch';
import { squadLetter } from '../format';
import { CloseIcon, DiceIcon } from '../icons';
import {
  MAP_BLURBS,
  RANDOM_SLOT,
  effectiveSquadSize,
  fighterCount,
  randomSeed,
  slotColor,
  squadOf,
  squadSizeOptions,
} from '../setup';
import type { MatchSetup, PoolEntry } from '../setup';

const FORMATS: { value: MatchFormat; label: string; hint: string }[] = [
  { value: 'ffa', label: 'Free-for-all', hint: 'Everyone for themselves.' },
  { value: 'squads', label: 'Squads', hint: 'Teams share a colour.' },
  { value: 'duel', label: 'Duel', hint: 'Two fighters, one exit.' },
];

/** Squads need two squads of at least two. */
const SQUADS_MIN_FIGHTERS = 4;

type Props = {
  initial: MatchSetup;
  /** Seed of the match on screen, offered so it can be replayed or shared. */
  currentSeed: number | null;
  pool: PoolEntry[];
  onClose: () => void;
  onFight: (s: MatchSetup) => void;
};

export function MatchSetupDialog({ initial, currentSeed, pool, onClose, onFight }: Props) {
  const [s, setS] = useState<MatchSetup>(initial);
  const [seedText, setSeedText] = useState(String(initial.seed));
  const fightBtn = useRef<HTMLButtonElement>(null);
  const n = fighterCount(s);
  const squads = s.format === 'squads';
  const house = pool.filter((p) => p.source === 'house');
  const mine = pool.filter((p) => p.source === 'saved');

  useEffect(() => fightBtn.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const patch = (p: Partial<MatchSetup>) => setS((prev) => ({ ...prev, ...p }));
  const setSeed = (seed: number) => {
    patch({ seed });
    setSeedText(String(seed));
  };
  const setFormat = (format: MatchFormat) =>
    patch(format === 'squads' && s.fighters < SQUADS_MIN_FIGHTERS ? { format, fighters: SQUADS_MIN_FIGHTERS } : { format });
  const setSlot = (i: number, ref: string) =>
    setS((prev) => {
      const slots = [...prev.slots];
      slots[i] = ref;
      return { ...prev, slots };
    });

  return (
    <div
      className="dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <div className="dialog-head">
          <h2 id="setup-title">New match</h2>
          <button type="button" className="btn btn-icon btn-quiet" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <CloseIcon />
          </button>
        </div>

        <div className="dialog-body">
          <div className="field">
            <span>Map</span>
            <div className="maps">
              {Object.values(MAPS).map((m) => (
                <button key={m.id} type="button" className="map-pick" aria-pressed={s.mapId === m.id} onClick={() => patch({ mapId: m.id })}>
                  <b>{m.name}</b>
                  <span>{MAP_BLURBS[m.id] ?? `${m.width} x ${m.height}`}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="row">
            <div className="field">
              <span>Format</span>
              <div className="seg" role="group" aria-label="Format">
                {FORMATS.map((f) => (
                  <button key={f.value} type="button" aria-pressed={s.format === f.value} onClick={() => setFormat(f.value)} title={f.hint}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            {s.format !== 'duel' ? (
              <label className="field grow">
                <span>
                  Fighters <b className="num">{n}</b>
                </span>
                <input
                  type="range"
                  className="range"
                  min={squads ? SQUADS_MIN_FIGHTERS : MIN_FIGHTERS}
                  max={MAX_FIGHTERS}
                  value={n}
                  onChange={(e) => patch({ fighters: Number(e.target.value) })}
                />
              </label>
            ) : null}
            {squads ? (
              <label className="field">
                <span>Squad size</span>
                <select className="select" value={effectiveSquadSize(s)} onChange={(e) => patch({ squadSize: Number(e.target.value) })}>
                  {squadSizeOptions(n).map((size) => (
                    <option key={size} value={size}>
                      {size} per squad
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {squads ? (
              <label className="check" style={{ height: 30 }}>
                <input type="checkbox" checked={s.friendlyFire} onChange={(e) => patch({ friendlyFire: e.target.checked })} />
                Friendly fire
              </label>
            ) : null}
          </div>

          <div className="field">
            <span>Line-up</span>
            {/* Column-first, so a squad reads top to bottom and slot numbers run down the left. */}
            <div className="slots" style={{ gridTemplateRows: `repeat(${Math.ceil(n / 2)}, auto)` }}>
              {Array.from({ length: n }, (_, i) => {
                const choice = s.slots[i] ?? RANDOM_SLOT;
                const known = choice === RANDOM_SLOT || pool.some((p) => p.ref === choice);
                return (
                  <div className="slot" key={i}>
                    <span className="num">{squads ? squadLetter(squadOf(i, s)) : i + 1}</span>
                    <span className="slot-color" style={{ background: slotColor(i, s) }} />
                    <select
                      className="select"
                      value={known ? choice : RANDOM_SLOT}
                      onChange={(e) => setSlot(i, e.target.value)}
                      aria-label={`Slot ${i + 1}`}
                    >
                      <option value={RANDOM_SLOT}>Random house stack</option>
                      {house.length ? (
                        <optgroup label="House stacks">
                          {house.map((p) => (
                            <option key={p.ref} value={p.ref}>
                              {p.label}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      {mine.length ? (
                        <optgroup label="Your strategies">
                          {mine.map((p) => (
                            <option key={p.ref} value={p.ref}>
                              {p.label}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="row">
            <label className="field">
              <span>Seed</span>
              <span className="inline">
                <input
                  className="input num"
                  inputMode="numeric"
                  value={seedText}
                  onChange={(e) => {
                    setSeedText(e.target.value);
                    patch({ seed: readInt(e.target.value, 0, 0xffffffff, s.seed) });
                  }}
                  style={{ width: 130 }}
                />
                <button type="button" className="btn btn-icon" onClick={() => setSeed(randomSeed())} title="New seed" aria-label="New seed">
                  <DiceIcon />
                </button>
              </span>
            </label>
            <span className="faint hint-line">
              Same seed and line-up, same fight.
              {currentSeed !== null ? (
                <>
                  {' '}
                  This one was{' '}
                  <button type="button" className="linkish num" onClick={() => setSeed(currentSeed)}>
                    {currentSeed}
                  </button>
                  .
                </>
              ) : null}
            </span>
          </div>
        </div>

        <div className="dialog-foot">
          <button type="button" className="btn btn-quiet" onClick={() => patch({ slots: s.slots.map(() => RANDOM_SLOT) })}>
            All random
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button ref={fightBtn} type="button" className="btn btn-primary" onClick={() => onFight(s)}>
            Fight
          </button>
        </div>
      </section>
    </div>
  );
}
