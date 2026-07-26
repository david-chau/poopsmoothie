import { useGame } from '../GameContext';
import { emitAck } from '../socket';
import { recordedName } from '../lib';
import { TEAM_LABELS, TEAM_CLASS, ROUND_LABELS, ROUND_ICONS, type Team, type Slip, type GameState } from '../types';
import Confetti from '../components/Confetti';

function ScoredByCell({ scoredBy, state }: { scoredBy?: Slip['scoredBy']; state: GameState }) {
  return (
    <div className="scored-by-list">
      {[1, 2, 3].map((round) => {
        const hit = scoredBy?.find((s) => s.round === round);
        return (
          <div
            key={round}
            className="scored-by-row"
            title={`${ROUND_LABELS[`ROUND${round}`]}${
              hit ? `: ${recordedName(state, hit.playerId, hit.playerName)}` : ': not guessed'
            }`}
          >
            <span className="scored-by-round">{ROUND_ICONS[`ROUND${round}`]}</span>
            {hit ? (
              // team comes off the record too, so a departed player keeps their colour
              <span className={TEAM_CLASS[hit.team]}>{recordedName(state, hit.playerId, hit.playerName)}</span>
            ) : (
              <span className="scored-by-empty">—</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function teamMvp(state: GameState, team: Team): { name: string; count: number } | null {
  // keyed by id, but the name is carried alongside so someone who has since
  // left the room is still named rather than shown as "someone"
  const tally = new Map<string, { name: string; count: number }>();
  for (const slip of state.pool ?? []) {
    for (const s of slip.scoredBy ?? []) {
      if (s.team !== team) continue;
      const seen = tally.get(s.playerId);
      const name = recordedName(state, s.playerId, s.playerName);
      tally.set(s.playerId, { name, count: (seen?.count ?? 0) + 1 });
    }
  }
  let best: { name: string; count: number } | null = null;
  for (const entry of tally.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best;
}

export default function Scores() {
  const { state, leaveToLanding, isHost } = useGame();
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
              ⭐ MVP: <span className={TEAM_CLASS.A}>{mvpA.name}</span> ({mvpA.count})
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
              ⭐ MVP: <span className={TEAM_CLASS.B}>{mvpB.name}</span> ({mvpB.count})
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
                      {recordedName(state, slip.authorId, slip.authorName)}
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

      {/* pinned rather than sitting at the end of a long scroll — after a game
          people want out (or another one) without scrolling past every slip */}
      <div className="scores-actions">
        {isHost && (
          <button className="btn btn-primary" onClick={() => emitAck('play-again')}>
            🔁 Play again — same people
          </button>
        )}
        <button className="btn" onClick={leaveToLanding}>
          Leave room
        </button>
      </div>
    </div>
  );
}
