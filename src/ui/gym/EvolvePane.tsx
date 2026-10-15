// Owned by: ui
import { MAX_FIGHTERS, MIN_FIGHTERS, hashString, strategyKey } from '../../core';
import type { EvolveGeneration, EvolveRequest, SavedStrategy, Strategy } from '../../core';
import type { ArchiveCell } from '../../gym';
import type { WatchRequest } from '../App';
import { evolveProblem, sanitizeForm } from '../batch';
import type { EvolveForm } from '../batch';
import { formatPercent, keyLabel, strategyLabel, weaponName } from '../format';
import { useStoredState } from '../hooks';
import { DiceIcon, WeaponIcon } from '../icons';
import { formatSigned, versusChampion } from '../reports';
import { exhibitionConfig, randomSeed } from '../setup';
import { toast } from '../toast';
import { NumberField } from '../widgets';
import type { EvolveOutcome, GymJob } from './GymScreen';
import { Picklist } from './Picklist';
import { defaultEvolveForm, mapItems, mapNames, resolveRefs, strategyOptions } from './options';

type Props = {
  houseStacks: readonly Strategy[];
  saved: SavedStrategy[];
  /** The editor's strategy when it validates; evolution starts from it. */
  parent: Strategy | null;
  job: GymJob;
  outcome: EvolveOutcome | null;
  onRun: (req: EvolveRequest) => void;
  onCancel: () => void;
  onLoad: (s: Strategy) => void;
  /** Save an evolved strategy; `generation` is where it came from (its origin in the library). */
  onSave: (s: Strategy, generation: number) => void;
  onWatch: (req: WatchRequest) => void;
};

/**
 * The gym worker reports each generation's archive too (`GenerationReport`), though the shared
 * `EvolveGeneration` type does not promise it; read it when it is there.
 */
type GenerationWithArchive = EvolveGeneration & { archive?: ArchiveCell[] };

/** The sim names fighters f0, f1, ... in entrant order, and an exhibition seats the entry first. */
const SEAT_0_FIGHTER = 'f0';

/**
 * Evolution: mutate the editor strategy, play mutants and the current champion on the same seeds,
 * promote only clear winners. The page shows what changed and by how much, generation by generation.
 */
export function EvolvePane({ houseStacks, saved, parent, job, outcome, onRun, onCancel, onLoad, onSave, onWatch }: Props) {
  const [form, setForm] = useStoredState<EvolveForm>('poc.gym.evolve.v1', () => defaultEvolveForm(houseStacks), sanitizeForm);
  const opts = strategyOptions(houseStacks, saved, null);
  const patch = (p: Partial<EvolveForm>) => setForm((prev) => ({ ...prev, ...p }));
  const parentKey = parent ? strategyKey(parent) : null;
  const field = resolveRefs(form.field, opts.byRef).filter((s) => strategyKey(s) !== parentKey);
  const maps = form.maps.filter((id) => mapItems().some((m) => m.ref === id));
  const problem = evolveProblem({
    parentValid: parent !== null,
    field: field.length,
    maps: maps.length,
    generations: form.generations,
    population: form.population,
    matches: form.matches,
    fighters: form.fighters,
  });
  const running = job.kind === 'evolve';
  const busy = job.kind !== 'idle';
  const matchesPerGen = (form.population + 1) * form.matches;

  const run = () => {
    if (!parent || problem || busy) return;
    onRun({
      parent,
      field,
      mapIds: maps,
      generations: form.generations,
      population: form.population,
      matchesPerCandidate: form.matches,
      fighters: form.fighters,
      seed: form.seed >>> 0,
    });
  };

  const gens = outcome ? [...outcome.generations].reverse() : [];
  const latest = gens[0] as GenerationWithArchive | undefined;
  const archive = latest?.archive ?? [];
  const lastPromotion = outcome ? [...outcome.generations].reverse().find((g) => g.promoted)?.generation ?? outcome.generations.length : 0;

  /**
   * Watch an entry fight. Generation matches are not recorded, so this is a fresh match against the
   * run's own field on its maps, seeded from the run and the entry: the same button shows the same fight.
   */
  const watchEntry = (s: Strategy, generation: number) => {
    const req = outcome?.request;
    if (!req) return;
    const mapId = req.mapIds[(Math.max(1, generation) - 1) % req.mapIds.length] ?? req.mapIds[0]!;
    const config = exhibitionConfig(s, req.field, mapId, req.fighters, hashString(`${req.seed}:${strategyKey(s)}`));
    if (!config) {
      toast('This run had no field to fight.');
      return;
    }
    onWatch({ config, focusId: SEAT_0_FIGHTER, origin: { label: `Evolution, ${strategyLabel(s.name, s.version)}`, tab: 'evolve', matchIndex: null } });
  };

  return (
    <div className="pane">
      <p className="pane-intro">
        {parent ? (
          <>
            Starts from <b>{strategyLabel(parent.name, parent.version)}</b>. Each generation plays the mutants and the champion on
            the same seeds; a mutant takes over only when it clearly finishes higher.
          </>
        ) : (
          'Evolution starts from the strategy in the editor. Fix its errors first.'
        )}
      </p>
      <div className="pick-cols">
        <Picklist title="Against" items={[...opts.house, ...opts.mine]} selected={form.field} onChange={(f) => patch({ field: f })} />
        <Picklist title="Maps" items={mapItems()} selected={form.maps} onChange={(m) => patch({ maps: m })} />
      </div>
      <div className="form-grid">
        <NumberField label="Generations" value={form.generations} min={1} max={50} onChange={(generations) => patch({ generations })} />
        <NumberField label="Mutants per generation" value={form.population} min={1} max={24} onChange={(population) => patch({ population })} />
        <NumberField label="Matches each" value={form.matches} min={1} max={50} onChange={(matches) => patch({ matches })} />
        <NumberField label="Fighters per match" value={form.fighters} min={MIN_FIGHTERS} max={MAX_FIGHTERS} onChange={(fighters) => patch({ fighters })} />
        <NumberField
          label="Seed"
          value={form.seed}
          min={0}
          max={0xffffffff}
          width={120}
          onChange={(seed) => patch({ seed })}
          after={
            <button type="button" className="btn btn-icon" onClick={() => patch({ seed: randomSeed() })} title="New seed" aria-label="New seed">
              <DiceIcon />
            </button>
          }
        />
      </div>

      <div className="run-bar">
        {running ? (
          <>
            <button type="button" className="btn" onClick={onCancel}>
              Stop
            </button>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.done}>
              <div style={{ width: `${job.total > 0 ? (job.done / job.total) * 100 : 0}%` }} />
            </div>
            <span className="dim num">
              Generation {Math.min(job.done + 1, job.total)} of {job.total}
            </span>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary" disabled={!!problem || busy} onClick={run}>
              Evolve
            </button>
            {busy ? (
              <span className="dim">Another gym job is running. One at a time.</span>
            ) : problem ? (
              <span className="error-line">{problem}</span>
            ) : (
              <span className="dim">
                {form.generations} generations, {matchesPerGen} matches each, on {mapNames(maps)}.
              </span>
            )}
          </>
        )}
      </div>

      {outcome?.result ? (
        <div className="evo-result">
          <p>{outcome.result.summary}</p>
          <div className="inline">
            {outcome.result.improved ? (
              <>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onSave(outcome.result!.champion, lastPromotion)}>
                  Save {strategyLabel(outcome.result.champion.name, outcome.result.champion.version)}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => onLoad(outcome.result!.champion)}>
                  Open in editor
                </button>
              </>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={() => watchEntry(outcome.result!.champion, lastPromotion)}>
              Watch the champion
            </button>
          </div>
        </div>
      ) : null}

      {archive.length ? <ArchiveView archive={archive} generation={latest!.generation} onWatch={watchEntry} onLoad={onLoad} /> : null}

      {gens.length ? (
        <div className="report">
          {gens.map((g) => (
            <GenerationCard key={g.generation} gen={g} onWatch={(s) => watchEntry(s, g.generation)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The elites, one per niche, after the latest generation; each can be watched or opened. */
function ArchiveView({ archive, generation, onWatch, onLoad }: { archive: ArchiveCell[]; generation: number; onWatch: (s: Strategy, generation: number) => void; onLoad: (s: Strategy) => void }) {
  const cells = [...archive].sort((a, b) => Number(b.champion) - Number(a.champion) || a.avgPlace - b.avgPlace);
  return (
    <section className="archive" aria-label="Evolution archive">
      <div className="report-head">
        <h2>Archive after generation {generation}</h2>
        <span className="dim">One elite per niche: weapon family, preferred range, aggression.</span>
      </div>
      <div className="archive-grid">
        {cells.map((c) => (
          <article key={`${c.nicheKey}:${c.key}`} className={`archive-cell${c.champion ? ' champion' : ''}`}>
            <div className="arc-head">
              <span className="sb-weapon" title={weaponName(c.strategy.build.weapon)}>
                <WeaponIcon weapon={c.strategy.build.weapon} />
              </span>
              <b title={c.name}>{c.name}</b>
              {c.champion ? <span className="chip chip-hot">Champion</span> : null}
            </div>
            <div className="arc-niche faint">
              {c.niche.family}, {c.niche.range} range, {c.niche.aggression}
            </div>
            <div className="arc-nums">
              <span>
                <b className="num">{c.avgPlace.toFixed(1)}</b> avg place
              </span>
              <span>
                <b className="num">{c.matches}</b> matches
              </span>
              <span className="faint">{c.bornGeneration === 0 ? 'the starting strategy' : `bred in gen ${c.bornGeneration}`}</span>
            </div>
            {c.mutations.length ? <div className="arc-muts mutations">{c.mutations.join('; ')}</div> : null}
            <div className="inline">
              <button type="button" className="btn btn-sm" onClick={() => onWatch(c.strategy, c.bornGeneration)}>
                Watch
              </button>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => onLoad(c.strategy)}>
                Open in editor
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function GenerationCard({ gen, onWatch }: { gen: EvolveGeneration; onWatch: (s: Strategy) => void }) {
  const promotedKey = gen.promoted ? strategyKey(gen.promoted.strategy) : null;
  return (
    <article className="gen">
      <div className="gen-head">
        <b>Generation {gen.generation}</b>
        <span className={`chip gen-tag${gen.promoted ? ' chip-hot' : ''}`}>{gen.promoted ? 'New champion' : 'Champion holds'}</span>
      </div>
      <div className="gen-summary">{gen.summary}</div>
      <table className="table">
        <thead>
          <tr>
            <th>Contender</th>
            <th>What changed</th>
            <th className="r">Avg place</th>
            <th className="r">Wins</th>
            <th className="r" title="Places gained against the champion on the same seeds">
              vs champion
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{keyLabel(gen.champion.key)}</td>
            <td className="dim">current champion</td>
            <td className="num">{gen.champion.avgPlace.toFixed(1)}</td>
            <td className="num">{formatPercent(gen.champion.winRate)}</td>
            <td className="num faint">-</td>
            <td />
          </tr>
          {gen.candidates.map((c, i) => {
            const vs = versusChampion(c.aggregate, gen.champion);
            const key = strategyKey(c.strategy);
            return (
              <tr key={`${key}:${i}`} className={key === promotedKey ? 'promoted' : undefined}>
                <td>{strategyLabel(c.strategy.name, c.strategy.version)}</td>
                <td className="mutations">{c.mutations.join('; ') || 'no change'}</td>
                <td className="num">{c.aggregate.avgPlace.toFixed(1)}</td>
                <td className="num">{formatPercent(c.aggregate.winRate)}</td>
                <td className={`num${vs.placeGain > 0 ? '' : ' faint'}`}>{formatSigned(vs.placeGain)}</td>
                <td className="r">
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => onWatch(c.strategy)} title="Watch it fight the run's field (a fresh match; generation matches are not recorded)">
                    Watch
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </article>
  );
}
