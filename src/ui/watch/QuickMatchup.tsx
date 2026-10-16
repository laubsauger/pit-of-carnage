// Owned by: ui
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { MAX_FIGHTERS, MIN_FIGHTERS, TICK_HZ } from '../../core';
import type { Lineup, LineupSource, MatchFormat, MatchRules, QuickMatchup, SavedStrategy, Strategy } from '../../core';
import { MAPS } from '../../sim';
import { readInt } from '../batch';
import { SEVERITY_SVG, suggestionLine } from '../editor/issues';
import { buildLine, squadLetter, strategyLabel } from '../format';
import { CloseIcon, DiceIcon, ImportIcon } from '../icons';
import { checkImport, isJsonFile, issueSpot, rejectedFile } from '../importer';
import type { ImportEntry } from '../importer';
import { SOURCE_LABEL, TIME_LIMITS_S, addFighter, clearField, lineupSize, pinnedCount, playingFighters, removeFighter, resizeLineup, togglePin } from '../lineup';
import { MAP_BLURBS, effectiveSquadSize, randomSeed, slotColor, squadOf, squadSizeOptions } from '../setup';
import { toast } from '../toast';

const FORMATS: { value: MatchFormat; label: string; hint: string }[] = [
  { value: 'ffa', label: 'Free-for-all', hint: 'Everyone for themselves.' },
  { value: 'squads', label: 'Squads', hint: 'Teams share a colour.' },
  { value: 'duel', label: 'Duel', hint: 'Two fighters, one exit.' },
];

/** Squads need two squads of at least two. */
const SQUADS_MIN_FIGHTERS = 4;

type AddMode = 'pick' | 'paste';

type Props = {
  initial: QuickMatchup;
  /** Seed of the match on screen, offered so it can be replayed or shared. */
  currentSeed: number | null;
  houseStacks: readonly Strategy[];
  saved: readonly SavedStrategy[];
  /** Files dropped on the arena that opened the dialog: added at once. */
  initialFiles: readonly File[];
  onClose: () => void;
  /** Start the match; false when it could not start (the dialog stays open). */
  onFight: (m: QuickMatchup) => boolean;
};

/**
 * Quick matchup: the lineup and the rules side by side. Add the player's own fighters (saved or
 * house strategies, dropped .json files, pasted JSON or codes, each through the gate with its
 * errors in place), pick map, format, count, time limit and seed, then Fight. The player's picks
 * are pinned and stay for every "Next match"; open slots are drawn from the house stacks.
 */
export function QuickMatchupDialog({ initial, currentSeed, houseStacks, saved, initialFiles, onClose, onFight }: Props) {
  const [lineup, setLineup] = useState<Lineup>(initial.lineup);
  const [rules, setRules] = useState<MatchRules>(initial.rules);
  const [seed, setSeedState] = useState(initial.seed);
  const [seedText, setSeedText] = useState(String(initial.seed));
  const [mode, setMode] = useState<AddMode>('pick');
  const [pick, setPick] = useState<string>(() => (houseStacks[0] ? `house:${houseStacks[0].name}` : ''));
  const [paste, setPaste] = useState('');
  const [rejected, setRejected] = useState<ImportEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [added, setAdded] = useState(0);
  const fightBtn = useRef<HTMLButtonElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const deferredPaste = useDeferredValue(paste);
  const pasted = useMemo(() => (deferredPaste.trim() ? checkImport('Pasted text', deferredPaste, false) : null), [deferredPaste]);

  const n = lineupSize(lineup, rules.format);
  const squads = rules.format === 'squads';
  const shape = { format: rules.format, fighters: n, squadSize: rules.squadSize };
  const pins = pinnedCount(lineup);
  const field = lineup.fighters.length - pins;
  const playing = playingFighters(lineup, rules.format);
  const open = Math.max(0, n - playing.length);
  const library = useMemo(() => [...saved].sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version), [saved]);

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

  const patchRules = (p: Partial<MatchRules>) => setRules((r) => ({ ...r, ...p }));
  const setSeed = (s: number) => {
    setSeedState(s);
    setSeedText(String(s));
  };
  const setFormat = (format: MatchFormat) => {
    patchRules({ format });
    if (format === 'squads' && lineup.size < SQUADS_MIN_FIGHTERS) setLineup((l) => resizeLineup(l, SQUADS_MIN_FIGHTERS));
  };

  /** Add one strategy that already passed the gate; returns whether it fit. */
  const add = (strategy: Strategy, source: LineupSource, savedId: string | null = null): boolean => {
    const next = addFighter(lineup, strategy, source, savedId);
    if (!next) {
      toast(`All ${MAX_FIGHTERS} slots are your own fighters already. Remove one first.`);
      return false;
    }
    setLineup(next);
    setAdded((k) => k + 1);
    return true;
  };

  const addPicked = () => {
    if (pick.startsWith('house:')) {
      const s = houseStacks.find((h) => `house:${h.name}` === pick);
      if (s) add(s, 'house');
    } else if (pick.startsWith('saved:')) {
      const s = saved.find((x) => `saved:${x.id}` === pick);
      // The saved number is the truth; stamp it on so reports key on name@vN.
      if (s) add({ ...s.strategy, version: s.version }, 'library', s.id);
    }
  };

  const addPasted = () => {
    const s = pasted?.report.strategy;
    if (!pasted || !s) return;
    if (add(s, pasted.source === 'code' ? 'code' : 'paste')) setPaste('');
  };

  // Every dropped file goes through the gate; the good ones join the lineup at once, the rest stay
  // listed with their errors.
  const addFiles = async (list: readonly File[]) => {
    const entries = await Promise.all(
      list.map(async (f) => {
        const id = nextId.current++;
        return isJsonFile(f) ? checkImport(f.name, await f.text(), true, id) : rejectedFile(f.name, id);
      }),
    );
    const bad: ImportEntry[] = [];
    let l = lineup;
    let count = 0;
    for (const e of entries) {
      const s = e.report.strategy;
      const next = s ? addFighter(l, s, 'file') : null;
      if (s && next) {
        l = next;
        count++;
      } else bad.push(s ? { ...e, issues: [{ path: '', message: `No room: all ${MAX_FIGHTERS} slots are your own fighters.`, severity: 'error' }] } : e);
    }
    setLineup(l);
    setAdded((k) => k + count);
    setRejected((prev) => [...bad, ...prev]);
    if (count > 0) toast(count === 1 ? 'Added 1 fighter from a file.' : `Added ${count} fighters from files.`);
  };

  // Taken once: StrictMode mounts effects twice in development, which would add every file twice.
  const first = useRef<readonly File[] | null>(initialFiles);
  useEffect(() => {
    const files = first.current;
    first.current = null;
    if (files?.length) void addFiles(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fight = () => {
    if (onFight({ lineup, rules: { ...rules, squadSize: squads ? effectiveSquadSize(shape) : rules.squadSize }, seed })) onClose();
  };

  const timeLimits = TIME_LIMITS_S.includes(Math.round(rules.timeLimitTicks / TICK_HZ)) ? TIME_LIMITS_S : [...TIME_LIMITS_S, Math.round(rules.timeLimitTicks / TICK_HZ)].sort((a, b) => a - b);

  return (
    <div
      className="dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`dialog qm${dragging ? ' dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="qm-title"
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          void addFiles([...e.dataTransfer.files]);
        }}
      >
        <div className="dialog-head">
          <h2 id="qm-title">Quick matchup</h2>
          <button type="button" className="btn btn-icon btn-quiet" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <CloseIcon />
          </button>
        </div>

        <div className="dialog-body qm-body">
          <div className="qm-col">
            <div className="field">
              <span>
                Lineup <b className="num">{n}</b>{' '}
                <span className="faint">
                  {pins > 0 ? `${pins} of yours, pinned` : 'no picks of yours yet'}
                  {open > 0 ? `, ${open} drawn at Fight` : ''}
                </span>
              </span>
              <ol className="qm-lineup">
                {playing.map((f, i) => (
                  <li key={f.key} className={`qm-row${f.pinned ? ' pinned' : ''}`}>
                    <span className="num qm-slot">{squads ? squadLetter(squadOf(i, shape)) : i + 1}</span>
                    <span className="slot-color" style={{ background: slotColor(i, shape) }} />
                    <span className="qm-name">
                      <b>{strategyLabel(f.strategy.name, f.strategy.version)}</b>
                      <span className="faint">
                        {buildLine(f.strategy.build.weapon, f.strategy.build.skill)} · {f.pinned ? `yours, from ${SOURCE_LABEL[f.source].toLowerCase()}` : 'field'}
                      </span>
                    </span>
                    <button
                      type="button"
                      className={`btn btn-sm qm-pin${f.pinned ? ' on' : ''}`}
                      aria-pressed={f.pinned}
                      onClick={() => setLineup((l) => togglePin(l, f.key))}
                      title={f.pinned ? 'Pinned: plays every next match. Click to hand the slot back to the field.' : 'Pin: keep this fighter for every next match and through Shuffle field.'}
                    >
                      {f.pinned ? 'Pinned' : 'Pin'}
                    </button>
                    <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={() => setLineup((l) => removeFighter(l, f.key))} aria-label={`Remove ${f.strategy.name}`} title="Remove (a house stack takes the slot)">
                      <CloseIcon size={12} />
                    </button>
                  </li>
                ))}
                {open > 0 ? (
                  <li className="qm-row open">
                    <span className="num qm-slot">{squads ? '' : `${playing.length + 1}${open > 1 ? `-${n}` : ''}`}</span>
                    <span className="slot-color" />
                    <span className="qm-name">
                      <b className="dim">{open === 1 ? 'A house stack' : `${open} house stacks`}</b>
                      <span className="faint">Drawn with the seed when the fight starts.</span>
                    </span>
                  </li>
                ) : null}
              </ol>
            </div>

            <div className="qm-add">
              <div className="qm-add-head">
                <b>{added > 0 ? 'Add next' : 'Add fighter'}</b>
                <div className="seg" role="group" aria-label="Add from">
                  <button type="button" aria-pressed={mode === 'pick'} onClick={() => setMode('pick')}>
                    Saved or house
                  </button>
                  <button type="button" aria-pressed={mode === 'paste'} onClick={() => setMode('paste')}>
                    File, JSON or code
                  </button>
                </div>
              </div>
              {mode === 'pick' ? (
                <div className="inline qm-pick">
                  <select className="select" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Strategy to add">
                    {library.length ? (
                      <optgroup label="Your strategies (every saved version)">
                        {library.map((s) => (
                          <option key={s.id} value={`saved:${s.id}`}>
                            {strategyLabel(s.name, s.version)}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    <optgroup label="House stacks">
                      {houseStacks.map((s) => (
                        <option key={s.name} value={`house:${s.name}`}>
                          {s.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <button type="button" className="btn" onClick={addPicked} disabled={!pick}>
                    Add
                  </button>
                </div>
              ) : (
                <>
                  <div className={`dropzone${dragging ? ' over' : ''}`}>
                    <ImportIcon size={18} />
                    <span>
                      Drop <b>.json</b> files anywhere on this panel (several at once), or{' '}
                      <button type="button" className="linkish" onClick={() => pickRef.current?.click()}>
                        pick files
                      </button>
                      .
                    </span>
                    <input
                      ref={pickRef}
                      type="file"
                      accept=".json,application/json"
                      multiple
                      hidden
                      onChange={(e) => {
                        const list = e.target.files ? [...e.target.files] : [];
                        e.target.value = '';
                        void addFiles(list);
                      }}
                    />
                  </div>
                  <textarea
                    className="input paste-box"
                    value={paste}
                    spellCheck={false}
                    aria-label="Paste JSON or a strategy code"
                    placeholder={'Paste JSON or a strategy code (PIT2.…)'}
                    onChange={(e) => setPaste(e.target.value)}
                  />
                  {pasted ? <Checked entry={pasted} onAdd={addPasted} /> : null}
                </>
              )}
              {rejected.length ? (
                <div className="qm-rejected">
                  {rejected.map((e) => (
                    <Checked key={e.id} entry={e} onDismiss={() => setRejected((r) => r.filter((x) => x.id !== e.id))} />
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="qm-col qm-rules">
            <div className="field">
              <span>Map</span>
              <div className="maps">
                {Object.values(MAPS).map((m) => (
                  <button key={m.id} type="button" className="map-pick" aria-pressed={rules.mapId === m.id} onClick={() => patchRules({ mapId: m.id })}>
                    <b>{m.name}</b>
                    <span>{MAP_BLURBS[m.id] ?? `${m.width} x ${m.height}`}</span>
                  </button>
                ))}
              </div>
              <label className="check">
                <input type="checkbox" checked={rules.rotateMaps} onChange={(e) => patchRules({ rotateMaps: e.target.checked })} />
                Next match moves on to the next map
              </label>
            </div>

            <div className="field">
              <span>Format</span>
              <div className="seg" role="group" aria-label="Format">
                {FORMATS.map((f) => (
                  <button key={f.value} type="button" aria-pressed={rules.format === f.value} onClick={() => setFormat(f.value)} title={f.hint}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {rules.format !== 'duel' ? (
              <label className="field">
                <span>
                  Fighters <b className="num">{n}</b>
                  {pins > 0 ? <span className="faint"> (at least your {pins})</span> : null}
                </span>
                <input
                  type="range"
                  className="range"
                  min={Math.max(squads ? SQUADS_MIN_FIGHTERS : MIN_FIGHTERS, pins)}
                  max={MAX_FIGHTERS}
                  value={n}
                  onChange={(e) => setLineup((l) => resizeLineup(l, Number(e.target.value)))}
                />
              </label>
            ) : pins > 2 ? (
              <p className="side-note">A duel takes your first two picks; the others sit this one out.</p>
            ) : null}

            {squads ? (
              <div className="row">
                <label className="field">
                  <span>Squad size</span>
                  <select className="select" value={effectiveSquadSize(shape)} onChange={(e) => patchRules({ squadSize: Number(e.target.value) })}>
                    {squadSizeOptions(n).map((size) => (
                      <option key={size} value={size}>
                        {size} per squad
                      </option>
                    ))}
                  </select>
                </label>
                <label className="check" style={{ height: 30 }}>
                  <input type="checkbox" checked={rules.friendlyFire} onChange={(e) => patchRules({ friendlyFire: e.target.checked })} />
                  Friendly fire
                </label>
              </div>
            ) : null}

            <div className="row">
              <label className="field">
                <span>Sudden death after</span>
                <select className="select" value={Math.round(rules.timeLimitTicks / TICK_HZ)} onChange={(e) => patchRules({ timeLimitTicks: Number(e.target.value) * TICK_HZ })}>
                  {timeLimits.map((s) => (
                    <option key={s} value={s}>
                      {s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check" style={{ height: 30 }} title="The closing wall: off means a match can run out the clock to the judges.">
                <input type="checkbox" checked={rules.suddenDeath} onChange={(e) => patchRules({ suddenDeath: e.target.checked })} />
                Closing wall
              </label>
            </div>

            <label className="field">
              <span>Seed</span>
              <span className="inline">
                <input
                  className="input num"
                  inputMode="numeric"
                  value={seedText}
                  onChange={(e) => {
                    setSeedText(e.target.value);
                    setSeedState(readInt(e.target.value, 0, 0xffffffff, seed));
                  }}
                  style={{ width: 130 }}
                />
                <button type="button" className="btn btn-icon" onClick={() => setSeed(randomSeed())} title="New seed" aria-label="New seed">
                  <DiceIcon />
                </button>
              </span>
            </label>
            <span className="faint hint-line">
              Same seed and lineup, same fight.
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
          <button
            type="button"
            className="btn btn-quiet"
            disabled={field === 0}
            onClick={() => setLineup((l) => clearField(l))}
            title="Drop the house stacks shown here; fresh ones are drawn at Fight. Your pinned picks stay."
          >
            Redraw field
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button ref={fightBtn} type="button" className="btn btn-primary" onClick={fight}>
            Fight
          </button>
        </div>
      </section>
    </div>
  );
}

/** One checked strategy (a paste or a file): its verdict, every issue with its spot, and the action. */
function Checked({ entry, onAdd, onDismiss }: { entry: ImportEntry; onAdd?: () => void; onDismiss?: () => void }) {
  const s = entry.report.strategy ?? null;
  const errors = entry.issues.filter((i) => i.severity === 'error').length;
  const warnings = entry.issues.length - errors;
  const blocked = errors > 0 || !s;
  return (
    <section className={`imp-entry${blocked ? ' blocked' : ''}`} aria-label={entry.label}>
      <div className="imp-head">
        <div className="imp-title">
          <b>{s ? strategyLabel(s.name, s.version) : entry.label}</b>
          <span className="faint">{s ? buildLine(s.build.weapon, s.build.skill) : blocked ? 'Not added' : ''}</span>
        </div>
        {onAdd ? (
          <button type="button" className="btn btn-sm btn-primary" disabled={blocked} onClick={onAdd}>
            {blocked ? `Fix ${errors || 1} ${errors === 1 ? 'error' : 'errors'} first` : warnings ? `Add with ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : 'Add'}
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={onDismiss} aria-label="Dismiss">
            <CloseIcon size={12} />
          </button>
        ) : null}
      </div>
      {entry.issues.length ? (
        <ul className="issues">
          {entry.issues.map((iss, i) => {
            const spot = issueSpot(iss);
            return (
              <li key={i}>
                <div className={`issue static ${iss.severity}`}>
                  <span className="issue-icon" aria-label={iss.severity} dangerouslySetInnerHTML={{ __html: SEVERITY_SVG[iss.severity] }} />
                  {spot || iss.path ? (
                    <code>
                      {spot}
                      {spot && iss.path ? ' · ' : ''}
                      {iss.path}
                    </code>
                  ) : null}
                  {iss.message}
                  {iss.suggestion ? <div className="hint">{suggestionLine(iss.suggestion)}</div> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
