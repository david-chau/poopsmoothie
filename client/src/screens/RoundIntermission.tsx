import { useGame } from '../GameContext';
import { ROUND_LABELS, ROUND_ICONS, TEAM_LABELS, TEAM_CLASS, type Team } from '../types';
import { emitAck } from '../socket';

/** A screen, not an overlay. The recap used to be a modal on top of a live
 *  round, so the next drawer could start their turn while everybody else was
 *  still reading — the game genuinely carried on behind the card. Now the
 *  server holds the round shut until people are ready, and this is what they
 *  see meanwhile. There is no intermission into the final scores: that screen
 *  is the recap. */
export default function RoundIntermission() {
  const { state, identity, isHost } = useGame();
  if (!state) return null;

  const justFinished = state.roundScores.length; // 1 after round 1, 2 after round 2
  const score = state.roundScores[justFinished - 1];
  const finishedPhase = (['ROUND1', 'ROUND2', 'ROUND3'] as const)[justFinished - 1];
  const winner: Team | 'tie' = !score ? 'tie' : score.A === score.B ? 'tie' : score.A > score.B ? 'A' : 'B';

  const connected = state.players.filter((p) => p.connected);
  const ready = connected.filter((p) => state.round.readyPlayerIds.includes(p.id));
  const iAmReady = !!identity && state.round.readyPlayerIds.includes(identity.playerId);

  return (
    <div className="screen screen-center">
      <div className="intermission">
        {score && finishedPhase && (
          <>
            <p className="recap-kicker">
              {ROUND_ICONS[finishedPhase]} Round {justFinished} done — {ROUND_LABELS[finishedPhase]}
            </p>
            <div className="recap-scores">
              <div>
                <span className={TEAM_CLASS.A}>Team {TEAM_LABELS.A}</span>
                <p className={`recap-points ${TEAM_CLASS.A}`}>+{score.A}</p>
              </div>
              <div>
                <span className={TEAM_CLASS.B}>Team {TEAM_LABELS.B}</span>
                <p className={`recap-points ${TEAM_CLASS.B}`}>+{score.B}</p>
              </div>
            </div>
            <p className="recap-line">
              {winner === 'tie' ? (
                'Dead even that round.'
              ) : (
                <>
                  Team <span className={TEAM_CLASS[winner]}>{TEAM_LABELS[winner]}</span> took the round.
                </>
              )}
            </p>
            <p className="recap-total">
              Overall <span className={TEAM_CLASS.A}>{state.teamScores.A}</span>
              {' – '}
              <span className={TEAM_CLASS.B}>{state.teamScores.B}</span>
            </p>
          </>
        )}

        <h2 className="intermission-next">
          Next: {ROUND_ICONS[state.phase]} Round {state.round.number} — {ROUND_LABELS[state.phase]}
        </h2>
        <p className="subtitle">Same words, all over again.</p>

        <button className="btn btn-primary" disabled={iAmReady} onClick={() => emitAck('player-ready')}>
          {iAmReady ? "Waiting for the others…" : "I'm ready"}
        </button>
        <p className="intermission-count">
          {ready.length} of {connected.length} ready
          {ready.length > 0 && <span className="intermission-names"> · {ready.map((p) => p.name).join(', ')}</span>}
        </p>

        {isHost && (
          <button className="link-btn skip-link" onClick={() => emitAck('start-round-now')}>
            Start the round now
          </button>
        )}
      </div>
    </div>
  );
}
