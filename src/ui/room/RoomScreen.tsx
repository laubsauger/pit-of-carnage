// Owned by: ui
import { useEffect, useState } from 'react';
import { displayRating } from '../../core';
import type { GameController, LeaderboardEntry } from '../../core';
import { formatAgo, formatPercent, strategyLabel } from '../format';
import { isProvisional } from '../reports';

/**
 * Room: the local leaderboard. Online rooms come later; until then this ranks every strategy that
 * played a rated gym batch in this browser.
 */
export function RoomScreen({ controller, active }: { controller: GameController; active: boolean }) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  // Ratings change only when a batch finishes, so reading on arrival is enough.
  useEffect(() => {
    if (active) setEntries([...controller.gym.leaderboard()]);
  }, [active, controller]);
  const now = Date.now();

  return (
    <div className="room">
      <h1>Room</h1>
      <div className="notice">
        <span className="notice-tag">Coming later</span>
        <span>
          <b>Online rooms are not open yet.</b> You will bring a strategy, meet other people's, and the Pit decides. For now this is
          your local board: every strategy that has played a rated gym batch in this browser, ranked by rating.
        </span>
      </div>

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
    </div>
  );
}
