// Owned by: net (online rooms); the local leaderboard at the bottom was the ui builder's.
//
// Room: host or join a peer-to-peer room by code, bring strategies, watch the host's matches and
// the room's leaderboard. Below it, this browser's own gym leaderboard. The WebRTC code loads only
// when a room opens.
import { useCallback, useEffect, useState } from 'react';
import { displayRating } from '../../core';
import type { GameController, LeaderboardEntry } from '../../core';
import { codeFromSearch, newClientId, newRoomCode, parseRoomCode } from '../../net/code';
import { cleanName } from '../../net/protocol';
import { hostStorageKey, hostedRooms } from '../../net/saved';
import type { HostedRoom } from '../../net/saved';
import type { RoomSession } from '../../net/session';
import { canWatchStreams } from '../../net/watch';
import { formatAgo, formatPercent, strategyLabel } from '../format';
import { readStored, useStoredState, writeStored } from '../hooks';
import { isProvisional } from '../reports';
import { InRoom } from './InRoom';
import { defaultName } from './model';
import './room.css';

const NAME_KEY = 'poc.room.name.v1';
const LAST_KEY = 'poc.room.last.v1';
const CLIENT_KEY = 'poc.room.client.v1';

type LastRoom = { code: string; role: 'host' | 'peer' } | null;

function sanitizeLast(v: unknown): LastRoom {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as { code?: unknown; role?: unknown };
  if (typeof r.code !== 'string' || !('code' in parseRoomCode(r.code))) return null;
  return { code: r.code, role: r.role === 'host' ? 'host' : 'peer' };
}

/**
 * This tab's identity towards hosts. Per tab (sessionStorage): two tabs are two people, and a
 * reload keeps you the same member with the same strategies.
 */
function tabClientId(): string {
  try {
    const have = window.sessionStorage.getItem(CLIENT_KEY);
    if (have && /^[A-Za-z0-9_-]{16,64}$/.test(have)) return have;
    const id = newClientId();
    window.sessionStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch {
    return newClientId();
  }
}

function localStore() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Rooms this browser hosted and kept (newest first, at most three offered). */
function readHosted(): HostedRoom[] {
  const store = localStore();
  return store ? hostedRooms(store).slice(0, 3) : [];
}

export function RoomScreen({ controller, active }: { controller: GameController; active: boolean }) {
  const [session, setSession] = useState<RoomSession | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useStoredState<string>(NAME_KEY, () => defaultName(), (v, fb) => (typeof v === 'string' ? v : fb));
  const [last, setLast] = useState<LastRoom>(() => readStored(LAST_KEY, null, sanitizeLast));
  const [invite] = useState<string | null>(() => (typeof window === 'undefined' ? null : codeFromSearch(window.location.search)));
  const [hosted, setHosted] = useState<HostedRoom[]>(readHosted);
  // Back in the lobby (or back on the screen): the hosted list may have changed.
  useEffect(() => {
    if (!session && active) setHosted(readHosted());
  }, [session, active]);
  const forget = useCallback((code: string) => {
    try {
      window.localStorage.removeItem(hostStorageKey(code));
    } catch {
      // Nothing to forget without storage.
    }
    setHosted(readHosted());
  }, []);

  const open = useCallback(
    async (role: 'host' | 'peer', code: string) => {
      const clean = cleanName(name);
      if (!clean) {
        setProblem('Pick a name first: it is how the room knows you.');
        return;
      }
      setProblem(null);
      setOpening(role === 'host' ? `Opening room ${code}…` : `Joining room ${code}…`);
      try {
        const { openRoom } = await import('../../net/room');
        const s = await openRoom({ role, code, name: clean, clientId: tabClientId(), storage: localStore() });
        setSession(s);
        const next = { code, role };
        setLast(next);
        writeStored(LAST_KEY, next);
      } catch (err) {
        console.error('Could not open the room.', err);
        setProblem(`Could not open the room: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setOpening(null);
      }
    },
    [name],
  );

  const leave = useCallback(() => {
    if (!session) return;
    if (canWatchStreams(controller)) controller.watchStream(null);
    session.leave();
    setSession(null);
  }, [session, controller]);

  // Closing the tab says goodbye (the host tells everyone the room closed).
  useEffect(() => {
    if (!session) return;
    const bye = () => session.leave();
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, [session]);

  return (
    <div className="room rm">
      {session ? (
        <InRoom session={session} controller={controller} active={active} onLeave={leave} />
      ) : (
        <Lobby name={name} setName={setName} opening={opening} problem={problem} invite={invite} last={last} hosted={hosted} onOpen={open} onForget={forget} />
      )}
      <LocalBoard controller={controller} active={active} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------------------------

type LobbyProps = {
  name: string;
  setName: (v: string) => void;
  opening: string | null;
  problem: string | null;
  invite: string | null;
  last: LastRoom;
  hosted: HostedRoom[];
  onOpen: (role: 'host' | 'peer', code: string) => void;
  onForget: (code: string) => void;
};

function Lobby({ name, setName, opening, problem, invite, last, hosted, onOpen, onForget }: LobbyProps) {
  const [code, setCode] = useState(invite ?? '');
  const [codeProblem, setCodeProblem] = useState<string | null>(null);
  const busy = opening !== null;

  const join = () => {
    const r = parseRoomCode(code);
    if ('problem' in r) {
      setCodeProblem(r.problem);
      return;
    }
    setCodeProblem(null);
    onOpen('peer', r.code);
  };

  return (
    <>
      <div className="rm-hero">
        <h1>Room</h1>
        <span className="rm-tag">Prototype</span>
      </div>
      <p className="rm-lede">
        Bring your strategies, meet your friends' and let the Pit decide. One browser hosts and runs every match; everyone else
        watches the same fight and climbs the same board.
      </p>

      {invite ? (
        <div className="rm-invite">
          You were invited to room <b className="rm-code-inline">{invite}</b>. Pick a name and press Join.
        </div>
      ) : null}

      <label className="field rm-name">
        <span>Your name in the room</span>
        <input className="input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} placeholder="Ringside Regular" />
      </label>

      <div className="rm-doors">
        <section className="rm-card rm-door">
          <h2>Host a room</h2>
          <p>
            You get a five-letter code to share. Your browser runs the matches and streams them, so keep this tab open while
            the room lives.
          </p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onOpen('host', newRoomCode())}>
            Create a room
          </button>
        </section>
        <section className="rm-card rm-door">
          <h2>Join a room</h2>
          <p>Type the code the host gave you.</p>
          <form
            className="rm-join"
            onSubmit={(e) => {
              e.preventDefault();
              join();
            }}
          >
            <input
              className="input rm-code-input"
              value={code}
              maxLength={8}
              spellCheck={false}
              autoCapitalize="characters"
              aria-label="Room code"
              placeholder="KRZBW"
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setCodeProblem(null);
              }}
            />
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Join
            </button>
          </form>
          {codeProblem ? <div className="rm-problem">{codeProblem}</div> : null}
        </section>
      </div>

      {hosted.length > 0 ? (
        <div className="rm-rooms">
          <span className="rm-label">Rooms you hosted</span>
          {hosted.map((h) => (
            <div key={h.code} className="rm-last">
              <b className="rm-code-inline">{h.code}</b>
              <span className="faint">
                {h.strategies === 1 ? '1 strategy' : `${h.strategies} strategies`}, {h.matches === 1 ? '1 match' : `${h.matches} matches`}
              </span>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onOpen('host', h.code)}>
                Reopen
              </button>
              <button type="button" className="btn btn-sm btn-quiet" disabled={busy} onClick={() => onForget(h.code)} title="Delete this room's pool and board from this browser">
                Forget
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {last?.role === 'peer' && !hosted.some((h) => h.code === last.code) ? (
        <div className="rm-last">
          <span className="rm-label">Last room</span>
          <b className="rm-code-inline">{last.code}</b>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onOpen('peer', last.code)}>
            Rejoin
          </button>
        </div>
      ) : null}
      {opening ? <div className="rm-opening">{opening}</div> : null}
      {problem ? <div className="rm-problem">{problem}</div> : null}

      <section className="rm-limits">
        <h2>How rooms work, honestly</h2>
        <ul>
          <li>
            <b>Peer to peer, no server.</b> Browsers connect directly over WebRTC and find each other through public relays.
            There is no session browser and no account: the code is the only way in.
          </li>
          <li>
            <b>Some networks will not connect.</b> Strict office, school and mobile networks block direct connections. Those
            need a TURN relay, which this prototype does not have.
          </li>
          <li>
            <b>The host runs everything.</b> Matches are simulated only in the host's browser and streamed to the rest. If
            the host leaves, the room pauses until they reopen it with the same code.
          </li>
          <li>
            <b>Strategies stay private.</b> Every strategy passes the same gate on the host as anywhere else. Other players see
            its name, weapon and skill, never the strategy itself.
          </li>
          <li>Up to 8 people, 3 strategies each. Empty seats go to the house stacks.</li>
        </ul>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// This browser's gym leaderboard
// ---------------------------------------------------------------------------------------------

function LocalBoard({ controller, active }: { controller: GameController; active: boolean }) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  // Ratings change only when a batch finishes, so reading on arrival is enough.
  useEffect(() => {
    if (active) setEntries([...controller.gym.leaderboard()]);
  }, [active, controller]);
  const now = Date.now();

  return (
    <section className="rm-local">
      <h2>Your gym leaderboard</h2>
      <p className="rm-sub">Every strategy that played a rated gym batch in this browser. Room ratings are kept separately, per room.</p>
      {entries.length === 0 ? (
        <div className="empty">
          <b>Nobody has bled for a rating yet.</b>
          Run a batch in the Gym. Every strategy in it, yours and the house stacks, lands here.
          <div style={{ marginTop: 14 }}>
            <a className="btn" href="#gym">
              Open the Gym
            </a>
          </div>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th className="rank">#</th>
              <th>Strategy</th>
              <th className="r" title="1000 + 40 x (mu - 3 sigma). New strategies start at 1000.">
                Rating
              </th>
              <th className="r">Matches</th>
              <th className="r">Wins</th>
              <th className="r">Win rate</th>
              <th className="r">Avg place</th>
              <th className="r">Last played</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={e.key}>
                <td className="rank">{i + 1}</td>
                <td>{strategyLabel(e.name, e.version)}</td>
                <td className="num">
                  {displayRating(e.rating)}
                  {isProvisional(e.rating) ? (
                    <span className="faint" title="Still settling: the rating will move a lot with more matches.">
                      {' '}
                      ?
                    </span>
                  ) : null}
                </td>
                <td className="num">{e.matches}</td>
                <td className="num">{e.wins}</td>
                <td className="num">{formatPercent(e.matches > 0 ? e.wins / e.matches : Number.NaN)}</td>
                <td className="num">{e.avgPlace.toFixed(1)}</td>
                <td className="num faint">{formatAgo(e.lastPlayedAt, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="footnote">
        Ratings use openskill over finishing order, so beating seven fighters counts for more than beating one. A "?" marks a
        rating that is still settling. The number climbs as it settles, even at average play.
      </p>
    </section>
  );
}
