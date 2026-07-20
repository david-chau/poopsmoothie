import { useEffect, useRef, useState } from 'react';
import { useGame } from '../GameContext';
import { emitAck } from '../socket';
import { ROUND_LABELS, ROUND_ICONS, TEAM_LABELS, TEAM_CLASS, type Team } from '../types';
import PaperSlip from '../components/PaperSlip';
import PlayerName from '../components/PlayerName';

interface FlashEvent {
  id: number;
  kind: 'correct' | 'pass';
  team: Team;
}

export default function Turn() {
  const { state, mySlip, isDrawer, isHost, clockOffsetMs } = useGame();
  const [error, setError] = useState<string | null>(null);
  // A React boolean cleared by useEffect/setTimeout isn't reliable here: the
  // ack for correct-guess and the broadcast for the NEXT slip can land in the
  // same render batch, so the intermediate "flash on" state sometimes never
  // paints at all. Instead each click gets a unique id and is rendered as a
  // plain CSS @keyframes animation keyed on that id — the browser's own timer
  // drives it, so it's guaranteed to play regardless of React's batching.
  const [flashEvent, setFlashEvent] = useState<FlashEvent | null>(null);
  const flashSeq = useRef(0);
  const [, forceTick] = useState(0);

  // re-render every 500ms so the countdown stays live
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  if (!state) return null;
  const { round } = state;
  const roundLabel = ROUND_LABELS[state.phase] ?? state.phase;
  const roundIcon = ROUND_ICONS[state.phase] ?? '';

  // gap #N: correct for this device's clock skew using the server-supplied offset
  const secondsLeft = round.turnEndsAt
    ? Math.max(0, Math.round((round.turnEndsAt - (Date.now() + clockOffsetMs)) / 1000))
    : null;
  const scoreFlashTeam = flashEvent?.kind === 'correct' ? flashEvent.team : null;

  async function act(event: 'correct-guess' | 'pass-turn') {
    if (!mySlip || !round.turnId) return;
    flashSeq.current += 1;
    setFlashEvent({ id: flashSeq.current, kind: event === 'correct-guess' ? 'correct' : 'pass', team: state!.activeTeam });
    const res = await emitAck<{ ok: boolean; error?: string }>(event, { slipId: mySlip.id, turnId: round.turnId });
    setError(res.ok ? null : (res.error ?? 'action failed'));
  }

  async function startTurn() {
    const res = await emitAck<{ ok: boolean; error?: string }>('start-turn');
    setError(res.ok ? null : (res.error ?? 'could not start turn'));
  }

  async function resumeTurn() {
    const res = await emitAck<{ ok: boolean; error?: string }>('resume-turn');
    setError(res.ok ? null : (res.error ?? 'could not resume'));
  }

  async function skipDrawer() {
    const res = await emitAck<{ ok: boolean; error?: string }>('skip-drawer');
    setError(res.ok ? null : (res.error ?? 'could not skip'));
  }

  async function forcePassTeam() {
    const res = await emitAck<{ ok: boolean; error?: string }>('force-pass-team');
    setError(res.ok ? null : (res.error ?? 'could not pass turn'));
  }

  return (
    <div className="screen">
      <header className="turn-header">
        <span className="round-label">
          {roundIcon} Round {round.number}: {roundLabel}
        </span>
        <span className="score-line">
          <span
            key={scoreFlashTeam === 'A' ? `a-${flashEvent!.id}` : 'a'}
            className={`team-blue${scoreFlashTeam === 'A' ? ' score-flash' : ''}`}
          >
            Team {TEAM_LABELS.A}: {state.teamScores.A}
          </span>
          {' | '}
          <span
            key={scoreFlashTeam === 'B' ? `b-${flashEvent!.id}` : 'b'}
            className={`team-red${scoreFlashTeam === 'B' ? ' score-flash' : ''}`}
          >
            Team {TEAM_LABELS.B}: {state.teamScores.B}
          </span>
        </span>
      </header>

      {secondsLeft !== null && <div className="timer">{secondsLeft}s</div>}

      {round.paused && (
        <div className="card banner">
          <p>
            Paused — waiting for <PlayerName state={state} playerId={round.drawerId} />.
          </p>
          {isDrawer && (
            <button className="btn btn-primary" onClick={resumeTurn}>
              Resume
            </button>
          )}
        </div>
      )}

      {!round.paused && isDrawer && !round.turnEndsAt && (
        <div className="card screen-center">
          <p>
            You&rsquo;re up! Team <span className={TEAM_CLASS[state.activeTeam]}>{TEAM_LABELS[state.activeTeam]}</span>.
          </p>
          <button className="btn btn-primary btn-bottom" onClick={startTurn}>
            Ready — start turn
          </button>
        </div>
      )}

      {!round.paused && isDrawer && round.turnEndsAt && mySlip && (
        <>
          <PaperSlip
            text={mySlip.text}
            slipKey={mySlip.id}
            flash={flashEvent ? { id: flashEvent.id, kind: flashEvent.kind } : null}
          />
          <div className="turn-actions">
            <button className="btn btn-pass" onClick={() => act('pass-turn')}>
              Pass
            </button>
            <button className="btn btn-correct" onClick={() => act('correct-guess')}>
              Correct!
            </button>
          </div>
        </>
      )}

      {!isDrawer && !round.paused && (
        <div className="screen-center">
          <p className="drawer-status">
            <PlayerName state={state} playerId={round.drawerId} /> is drawing for Team{' '}
            <span className={TEAM_CLASS[state.activeTeam]}>{TEAM_LABELS[state.activeTeam]}</span>
          </p>
          <p className="subtitle">
            {round.guessedCount} guessed · {round.remainingCount} left
          </p>
        </div>
      )}

      {isHost && (
        <div className="host-escape-hatches">
          <button className="link-btn skip-link" onClick={skipDrawer}>
            Skip stuck drawer
          </button>
          <button className="link-btn skip-link" onClick={forcePassTeam}>
            Force pass to other team
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
