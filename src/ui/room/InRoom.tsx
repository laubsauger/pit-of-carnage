// Owned by: net
// Inside a room: the code to share, the match being played (radar and line-up), the pool, the room
// leaderboard, who is here, the host's controls and the last matches with their battle reports
// (and their strategies, when the host reveals them).
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { MAX_FIGHTERS, MIN_FIGHTERS } from '../../core';
import type { GameController } from '../../core';
import { toRating } from '../../gym/ratings';
import { roomLink } from '../../net/code';
import type { StreamPlayer } from '../../net/player';
import { MAX_ENTRIES_PER_MEMBER } from '../../net/protocol';
import type { RoomState } from '../../net/protocol';
import type { MatchExtras, RoomSession, RoomView } from '../../net/session';
import { MAPS } from '../../sim';
import { buildLine, formatClock, strategyLabel } from '../format';
import { WeaponIcon } from '../icons';
import { copyAndToast } from '../toast';
import { NumberField, RatingCell } from '../widgets';
import { historyLine, latestPerName, matchLength, statusLine } from './model';
import { Radar } from './Radar';

type Props = {
  session: RoomSession;
  controller: GameController;
  active: boolean;
  /** Host of the TURN relay in use, or null for direct connections. */
  relay: string | null;
  onLeave: () => void;
};

/** The room's view, re-read whenever the session says something changed. */
function useRoomView(session: RoomSession): RoomView {
  return useSyncExternalStore(
    useCallback((fn: () => void) => session.subscribe(fn), [session]),
    useCallback(() => session.getView(), [session]),
  );
}

export function InRoom({ session, controller, active, relay, onLeave }: Props) {
  const view = useRoomView(session);
  const room = view.room;
  const status = statusLine(view);
  const meName = room?.members.find((m) => m.id === view.me)?.name ?? null;

  return (
    <>
      <header className="rm-bar">
        <div className="rm-bar-code">
          <span className="rm-label">Room</span>
          <span className="rm-code" aria-label={`Room code ${view.code.split('').join(' ')}`}>
            {view.code.split('').map((c, i) => (
              <i key={i}>{c}</i>
            ))}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => void copyAndToast(view.code, 'Room code')}>
            Copy code
          </button>
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => void copyAndToast(roomLink(window.location.href, view.code), 'Invite link')}>
            Copy invite link
          </button>
        </div>
        <div className={`rm-status ${status.tone}`} role="status">
          <i aria-hidden />
          {status.text}
        </div>
        <button type="button" className="btn btn-sm" onClick={onLeave}>
          {view.role === 'host' ? 'Close room' : 'Leave'}
        </button>
      </header>

      <div className="rm-grid">
        <div className="rm-main">
          <NowFighting session={session} controller={controller} active={active} room={room} status={view.status} />
          <Pool session={session} controller={controller} view={view} active={active} />
          <Board room={room} meName={meName} />
        </div>
        <aside className="rm-side">
          <People room={room} me={view.me} />
          {view.role === 'host' && room ? <HostControls session={session} room={room} waiting={view.waiting} /> : null}
          <History room={room} session={session} />
          <Activity view={view} player={session.player} relay={relay} />
        </aside>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The match
// ---------------------------------------------------------------------------------------------

type Live = {
  matchId: number;
  mapId: string;
  tick: number;
  countdown: number | null;
  finished: boolean;
  fighters: { id: string; name: string; color: string; alive: boolean; kills: number; owner: string | null; place: number | null }[];
};

/** The streamed match as the radar shows it, read 4 times a second while the screen is visible. */
function useLive(player: StreamPlayer, active: boolean): Live | null {
  const [live, setLive] = useState<Live | null>(null);
  useEffect(() => {
    if (!active) return;
    const read = () => {
      const now = performance.now();
      const s = player.sample(now);
      const info = player.info;
      if (!s || !info) {
        setLive(null);
        return;
      }
      const owners = new Map(info.fighters.map((f) => [f.id, f.owner]));
      setLive({
        matchId: info.id,
        mapId: info.mapId,
        tick: s.curr.tick,
        countdown: player.countdownAt(now),
        finished: s.curr.finished,
        fighters: s.curr.fighters.map((f) => ({ id: f.id, name: f.name, color: f.color, alive: f.alive, kills: f.kills, owner: owners.get(f.id) ?? null, place: f.place })),
      });
    };
    read();
    const id = window.setInterval(read, 250);
    return () => window.clearInterval(id);
  }, [player, active]);
  return live;
}

type NowProps = { session: RoomSession; controller: GameController; active: boolean; room: RoomState | null; status: RoomView['status'] };

function NowFighting({ session, controller, active, room, status }: NowProps) {
  const live = useLive(session.player, active);
  const extras = live?.finished ? session.extras(live.matchId) : null;
  const standing = live ? live.fighters.filter((f) => f.alive).length : 0;
  const order = live ? [...live.fighters].sort((a, b) => Number(b.alive) - Number(a.alive) || (a.place ?? 99) - (b.place ?? 99) || b.kills - a.kills) : [];

  return (
    <section className="rm-card rm-now">
      <div className="rm-card-head">
        <h2>{live ? (live.finished ? 'Just finished' : 'Now fighting') : 'Between matches'}</h2>
        {live ? (
          <span className="rm-meta">
            Match {live.matchId} · {MAPS[live.mapId]?.name ?? live.mapId} · <span className="num">{formatClock(live.tick)}</span> · {standing} of{' '}
            {live.fighters.length} standing
          </span>
        ) : null}
      </div>
      {live ? (
        <div className="rm-now-body">
          <div className="rm-stage">
            <Radar player={session.player} active={active} />
            {live.countdown !== null && live.countdown > 0 ? <div className="rm-countdown num">{live.countdown}</div> : null}
            {live.countdown === 0 ? <div className="rm-countdown fight">Fight</div> : null}
          </div>
          <ol className="rm-lineup">
            {order.map((f) => (
              <li key={f.id} className={f.alive ? '' : 'out'}>
                <i style={{ background: f.color }} aria-hidden />
                <span className="rm-lineup-name">{f.name}</span>
                <span className="rm-lineup-owner">{f.owner ?? 'house'}</span>
                <span className="num rm-lineup-kills">{f.kills > 0 ? `${f.kills}k` : ''}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="rm-empty-now">
          {status === 'host-gone'
            ? 'No host, no fight. If the host reopens the room with the same code, you are back in automatically.'
            : status === 'refused' || status === 'closed'
              ? 'Not in this room.'
              : room?.match
                ? 'The next match is about to start…'
                : session.role === 'host'
                  ? 'The next match starts as soon as there is a line-up.'
                  : 'Waiting for the host to start a match.'}
        </div>
      )}
      {extras ? <Leftovers extras={extras} /> : null}
      <div className="rm-watch">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!live}
          onClick={() => {
            controller.watchStream(session.player);
            window.location.hash = 'watch';
          }}
        >
          Watch in the arena
        </button>
        <span className="rm-note">
          Full arena with blood, sound and the HUD; select a fighter to see what it is thinking. Everyone sees the same fight,
          a beat behind the host.
        </span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------------------------

function Pool({ session, controller, view, active }: { session: RoomSession; controller: GameController; view: RoomView; active: boolean }) {
  const room = view.room;
  const entries = room?.entries ?? [];
  const mine = entries.filter((e) => e.member === view.me).length;
  // The library changes only from the Gym; re-read it whenever the Room comes into view.
  const library = useMemo(() => (active ? latestPerName(controller.strategies.list()) : []), [controller, active]);
  const [pick, setPick] = useState('');
  const [paste, setPaste] = useState('');
  const [answer, setAnswer] = useState<{ ok: boolean; line: string } | null>(null);
  const full = mine >= MAX_ENTRIES_PER_MEMBER;
  const connected = view.status === 'hosting' || view.status === 'connected';

  const addPicked = () => {
    const s = library.find((x) => x.id === pick) ?? library[0];
    if (!s) return;
    // The library's version number is the one that counts (as in match setup).
    setAnswer(session.add({ ...s.strategy, version: s.version }, 'saved'));
  };
  const addPasted = () => {
    const text = paste.trim();
    if (!text) return;
    const r = session.add(text, text.startsWith('PIT2.') ? 'code' : 'paste');
    setAnswer(r);
    if (r.ok) setPaste('');
  };

  return (
    <section className="rm-card">
      <div className="rm-card-head">
        <h2>The pool</h2>
        <span className="rm-meta">
          {entries.length} {entries.length === 1 ? 'strategy' : 'strategies'} · yours {mine} of {MAX_ENTRIES_PER_MEMBER}
        </span>
      </div>
      {room?.settings.revealStrategies ? (
        <p className="rm-reveal-note">
          <b>Strategies are revealed here.</b> The host shares every strategy as a code after each match: whatever you add,
          everyone can copy once it has fought.
        </p>
      ) : null}
      {entries.length === 0 ? (
        <p className="rm-sub">Nothing in the pool yet. Until someone brings a strategy, the house stacks warm up.</p>
      ) : (
        <ul className="rm-pool">
          {entries.map((e) => {
            const own = e.member === view.me;
            return (
              <li key={e.id} className={own ? 'mine' : ''}>
                <WeaponIcon weapon={e.weapon} size={15} />
                <span className="rm-pool-name">{strategyLabel(e.name, e.version)}</span>
                <span className="rm-pool-build">{buildLine(e.weapon, e.skill)}</span>
                <span className="rm-pool-owner">{own ? 'you' : (e.owner ?? 'house')}</span>
                <span className="rm-pool-played num">{e.matches === 1 ? '1 match' : `${e.matches} matches`}</span>
                {own || view.role === 'host' ? (
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => session.remove(e.id)} title="Take it out of the pool">
                    Remove
                  </button>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="rm-add">
        <div className="rm-add-row">
          {library.length > 0 ? (
            <>
              <select className="select" value={pick || library[0]!.id} onChange={(e) => setPick(e.target.value)} aria-label="Strategy from your library">
                {library.map((s) => (
                  <option key={s.id} value={s.id}>
                    {strategyLabel(s.name, s.version)}, {buildLine(s.strategy.build.weapon, s.strategy.build.skill)}
                  </option>
                ))}
              </select>
              <button type="button" className="btn" disabled={full || !connected} onClick={addPicked}>
                Add to the pool
              </button>
            </>
          ) : (
            <span className="rm-sub">
              Your library is empty. Build one in the <a href="#gym">Gym</a>, or paste a strategy code.
            </span>
          )}
        </div>
        <div className="rm-add-row">
          <input
            className="input rm-paste"
            value={paste}
            spellCheck={false}
            placeholder="Or paste a strategy code (PIT2.…) or JSON"
            onChange={(e) => setPaste(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addPasted();
            }}
          />
          <button type="button" className="btn" disabled={full || !connected || paste.trim() === ''} onClick={addPasted}>
            Add
          </button>
        </div>
        {full ? <div className="rm-sub">You have {MAX_ENTRIES_PER_MEMBER} in the pool, the most allowed. Remove one to add another.</div> : null}
        {answer ? <div className={`rm-answer ${answer.ok ? 'good' : 'bad'}`}>{answer.line}</div> : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------------------------

function Board({ room, meName }: { room: RoomState | null; meName: string | null }) {
  const rows = room?.board ?? [];
  return (
    <section className="rm-card">
      <div className="rm-card-head">
        <h2>Room leaderboard</h2>
        <span className="rm-meta">openskill over every room match</span>
      </div>
      {rows.length === 0 ? (
        <p className="rm-sub">No results yet. The first finished match puts everyone who fought on the board.</p>
      ) : (
        <div className="rm-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="rank">#</th>
                <th>Strategy</th>
                <th>Brought by</th>
                <th className="r" title="1000 + 40 x (mu - 3 sigma). New strategies start at 1000.">
                  Rating
                </th>
                <th className="r">Matches</th>
                <th className="r">Wins</th>
                <th className="r">Avg place</th>
                <th className="r">Kills</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const rating = toRating(r.mu, r.sigma);
                return (
                  <tr key={r.key} className={meName !== null && r.owner === meName ? 'mine' : ''}>
                    <td className="rank">{i + 1}</td>
                    <td>{strategyLabel(r.name, r.version)}</td>
                    <td className={r.owner ? '' : 'faint'}>{r.owner ?? 'house'}</td>
                    <td className="num">
                      <RatingCell rating={rating} matches={r.matches} />
                    </td>
                    <td className="num">{r.matches}</td>
                    <td className="num">{r.wins}</td>
                    <td className="num">{r.avgPlace.toFixed(1)}</td>
                    <td className="num">{r.kills}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Side column
// ---------------------------------------------------------------------------------------------

function People({ room, me }: { room: RoomState | null; me: string | null }) {
  const members = room?.members ?? [];
  const online = members.filter((m) => m.online).length;
  return (
    <section className="rm-card">
      <div className="rm-card-head">
        <h2>People</h2>
        <span className="rm-meta">{online} here</span>
      </div>
      {members.length === 0 ? (
        <p className="rm-sub">Waiting for the host…</p>
      ) : (
        <ul className="rm-people">
          {[...members]
            .sort((a, b) => Number(b.host) - Number(a.host) || Number(b.online) - Number(a.online))
            .map((m) => (
              <li key={m.id} className={m.online ? '' : 'away'}>
                <i className={m.online ? 'on' : ''} aria-label={m.online ? 'online' : 'away'} />
                <span className="rm-people-name">{m.name}</span>
                {m.host ? <span className="chip">host</span> : null}
                {m.id === me ? <span className="chip">you</span> : null}
                {!m.online ? <span className="faint">away</span> : null}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function HostControls({ session, room, waiting }: { session: RoomSession; room: RoomState; waiting: string | null }) {
  const s = room.settings;
  return (
    <section className="rm-card">
      <div className="rm-card-head">
        <h2>Host controls</h2>
      </div>
      <div className="rm-controls">
        <NumberField label="Fighters per match" value={s.fighters} min={MIN_FIGHTERS} max={MAX_FIGHTERS} width={64} onChange={(n) => session.setSettings({ fighters: n })} />
        <label className="field">
          <span>Map</span>
          <select className="select" value={s.mapId} onChange={(e) => session.setSettings({ mapId: e.target.value })}>
            <option value="rotate">Every map in turn</option>
            {Object.values(MAPS).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.fillWithHouse} onChange={(e) => session.setSettings({ fillWithHouse: e.target.checked })} />
          Fill empty seats with house stacks
        </label>
        <label className="check">
          <input type="checkbox" checked={s.revealStrategies} onChange={(e) => session.setSettings({ revealStrategies: e.target.checked })} />
          Reveal strategies after each match
        </label>
        <div className="rm-sub">
          {s.revealStrategies
            ? 'Everyone gets the strategies of every finished match as codes to copy, study and steal. The pool says so.'
            : 'Off: strategies never leave your browser. Others see names, weapons and skills only.'}
        </div>
        <button type="button" className={`btn ${s.running ? '' : 'btn-primary'}`} onClick={() => session.setSettings({ running: !s.running })}>
          {s.running ? 'Pause after this match' : 'Resume matches'}
        </button>
        {!s.running ? <div className="rm-sub">{room.match ? 'Pausing after this match.' : 'Paused. Nothing plays until you resume.'}</div> : null}
        {waiting && s.running ? <div className="rm-sub">{waiting}</div> : null}
      </div>
    </section>
  );
}

function History({ room, session }: { room: RoomState | null; session: RoomSession }) {
  const history = room?.history ?? [];
  if (history.length === 0) return null;
  return (
    <section className="rm-card">
      <div className="rm-card-head">
        <h2>Last matches</h2>
      </div>
      <ul className="rm-history">
        {history.map((h) => {
          const extras = session.extras(h.id);
          return (
            <li key={h.id}>
              <span className="num faint">#{h.id}</span>
              <span>{historyLine(h)}</span>
              <span className="num faint">{matchLength(h.ticks)}</span>
              {extras ? <Leftovers extras={extras} compact /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What a finished match left: its battle report to copy, and its strategies when the host reveals them. */
function Leftovers({ extras, compact = false }: { extras: MatchExtras; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const revealed = extras.revealed;
  if (!extras.report && !revealed) return null;
  return (
    <div className={`rm-leftovers${compact ? ' compact' : ''}`}>
      <div className="rm-leftovers-row">
        {extras.report ? (
          <button type="button" className="btn btn-sm" onClick={() => void copyAndToast(extras.report!, 'Battle report')} title="The battle report as text, ready for an LLM">
            Copy battle report
          </button>
        ) : null}
        {revealed && revealed.length > 0 ? (
          <button type="button" className="btn btn-sm btn-quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide strategies' : `Strategies (${revealed.length})`}
          </button>
        ) : null}
      </div>
      {open && revealed ? (
        <ul className="rm-revealed">
          {revealed.map((r) => (
            <li key={r.fighterId}>
              <WeaponIcon weapon={r.weapon} size={13} />
              <span className="rm-revealed-name">{r.name}</span>
              <span className="rm-revealed-owner">{r.owner ?? 'house'}</span>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => void copyAndToast(r.code, `${r.name}'s strategy code`)} title={buildLine(r.weapon, r.skill)}>
                Copy code
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Activity({ view, player, relay }: { view: RoomView; player: StreamPlayer; relay: string | null }) {
  const notices = [...view.notices].reverse();
  return (
    <section className="rm-card rm-activity">
      <div className="rm-card-head">
        <h2>Activity</h2>
      </div>
      {notices.length === 0 ? <p className="rm-sub">Nothing yet.</p> : null}
      <ul>
        {notices.map((n) => (
          <li key={n.id} className={n.tone}>
            {n.text}
          </li>
        ))}
      </ul>
      <p className="rm-diag">
        {view.peers} {view.peers === 1 ? 'connection' : 'connections'}
        {relay ? ` (TURN relay ${relay} when needed)` : ''} · stream {player.lagMs} ms behind the host
        {view.rejected + player.dropped > 0 ? ` · ${view.rejected + player.dropped} bad messages dropped` : ''}
      </p>
    </section>
  );
}
