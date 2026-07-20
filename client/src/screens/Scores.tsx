import { useGame } from '../GameContext';
import { playerName, playerTeamClass } from '../lib';
import { TEAM_LABELS, ROUND_LABELS, ROUND_ICONS, type Team, type Slip, type GameState } from '../types';
import Confetti from '../components/Confetti';
import PlayerName from '../components/PlayerName';

function ScoredByCell({ scoredBy, state }: { scoredBy?: Slip['scoredBy']; state: GameState }) {
  return (
    <div className="scored-by-list">
      {[1, 2, 3].map((round) => {
        const hit = scoredBy?.find((s) => s.round === round);
        return (
          <div
            key={round}
            className="scored-by-row"
            title={`${ROUND_LABELS[`ROUND${round}`]}${hit ? `: ${playerName(state, hit.playerId)}` : ': not guessed'}`}
          >
            <span className="scored-by-round">{ROUND_ICONS[`ROUND${round}`]}</span>
            {hit ? (
              <span className={playerTeamClass(state, hit.playerId)}>{playerName(state, hit.playerId)}</span>
            ) : (
              <span className="scored-by-empty">—</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function teamMvp(state: GameState, team: Team): { playerId: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const slip of state.pool ?? []) {
    for (const s of slip.scoredBy ?? []) {
      if (s.team !== team) continue;
      counts.set(s.playerId, (counts.get(s.playerId) ?? 0) + 1);
    }
  }
  let best: { playerId: string; count: number } | null = null;
  for (const [playerId, count] of counts) {
    if (!best || count > best.count) best = { playerId, count };
  }
  return best;
}

export default function Scores() {
  const { state, leaveToLanding } = useGame();
  if (!state) return null;

  const winner: Team | 'tie' =
    state.teamScores.A === state.teamScores.B ? 'tie' : state.teamScores.A > state.teamScores.B ? 'A' : 'B';
  const maxRoundScore = Math.max(1, ...state.roundScores.flatMap((r) => [r.A, r.B]));
  const mvpA = teamMvp(state, 'A');
  const mvpB = teamMvp(state, 'B');

  return (
    <div className="screen">
      {winner !== 'tie' && <Confetti />}
      <h1 className="title">Final scores</h1>
      {winner === 'tie' && <p className="subtitle">It&rsquo;s a tie!</p>}

      <div className="card score-summary">
        <div className="score-summary-side">
          <h2 className="team-blue">
            Team {TEAM_LABELS.A}
            {winner === 'A' && <span className="trophy">🏆</span>}
          </h2>
          <p className="big-score team-blue">{state.teamScores.A}</p>
          {mvpA && (
            <p className="mvp-line">
              ⭐ MVP: <PlayerName state={state} playerId={mvpA.playerId} /> ({mvpA.count})
            </p>
          )}
        </div>
        <div className="score-summary-divider" />
        <div className="score-summary-side">
          <h2 className="team-red">
            Team {TEAM_LABELS.B}
            {winner === 'B' && <span className="trophy">🏆</span>}
          </h2>
          <p className="big-score team-red">{state.teamScores.B}</p>
          {mvpB && (
            <p className="mvp-line">
              ⭐ MVP: <PlayerName state={state} playerId={mvpB.playerId} /> ({mvpB.count})
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h2>By round</h2>
        <div className="round-chart">
          {state.roundScores.map((r, i) => (
            <div className="round-chart-group" key={i}>
              <div className="round-chart-label">
                {ROUND_ICONS[`ROUND${i + 1}`]} Round {i + 1}
              </div>
              <div className="round-chart-vs">
                <span className="round-chart-value round-chart-value-left team-blue">{r.A}</span>
                <div className="round-chart-track-row">
                  <div className="round-chart-half round-chart-half-left">
                    <div className="round-chart-bar team-blue-bg" style={{ width: `${(r.A / maxRoundScore) * 100}%` }} />
                  </div>
                  <div className="round-chart-half round-chart-half-right">
                    <div className="round-chart-bar team-red-bg" style={{ width: `${(r.B / maxRoundScore) * 100}%` }} />
                  </div>
                </div>
                <span className="round-chart-value round-chart-value-right team-red">{r.B}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {state.pool && state.pool.length > 0 && (
        <div className="card">
          <h2>Every slip</h2>
          <div className="pool-table-scroll">
            <table className="pool-table">
              <thead>
                <tr>
                  <th className="pool-table-word">Word</th>
                  <th>Written by</th>
                  <th>Scored by</th>
                </tr>
              </thead>
              <tbody>
                {state.pool.map((slip) => (
                  <tr key={slip.id}>
                    <td className="pool-table-word">{slip.text}</td>
                    <td>
                      <PlayerName state={state} playerId={slip.authorId} />
                    </td>
                    <td>
                      <ScoredByCell scoredBy={slip.scoredBy} state={state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <button className="btn btn-bottom" onClick={leaveToLanding}>
        Leave room
      </button>
    </div>
  );
}
