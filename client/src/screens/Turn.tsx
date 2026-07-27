import { useEffect, useRef, useState } from 'react';
import { useGame } from '../GameContext';
import { emitAck } from '../socket';
import { ROUND_LABELS, ROUND_ICONS, TEAM_LABELS, TEAM_CLASS, type Team } from '../types';
import { tick, timeUp, primeAudio, passed } from '../alert';
import PaperSlip from '../components/PaperSlip';
import PlayerName from '../components/PlayerName';
import AdminDrawer from '../components/AdminDrawer';
import TurnChat from '../components/TurnChat';

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

  const endsAt = state?.round.turnEndsAt ?? null;
  const remaining = endsAt ? Math.max(0, Math.round((endsAt - (Date.now() + clockOffsetMs)) / 1000)) : null;

  // Countdown alerts, scheduled off turnEndsAt rather than watched for on each
  // render. Polling missed the final beep outright: the server clears
  // turnEndsAt the instant the timer fires, so the client often never rendered
  // a "0" to react to. Timers also land on the real second boundaries instead
  // of whenever the 500ms redraw happens to tick.
  // Everyone hears these, not just the drawer — the whole table watches the clock.
  useEffect(() => {
    if (!endsAt) return;
    const msLeft = endsAt - (Date.now() + clockOffsetMs);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (msFromNow: number, fn: () => void) => {
      if (msFromNow > 0) timers.push(setTimeout(fn, msFromNow));
    };
    for (let s = 10; s >= 1; s--) at(msLeft - s * 1000, () => tick(s <= 3));
    at(msLeft, timeUp);
    // cleared on pause, hand-over, or a new turn — whatever changes turnEndsAt
    return () => timers.forEach(clearTimeout);
  }, [endsAt, clockOffsetMs]);

  if (!state) return null;
  const { round } = state;
  const roundLabel = ROUND_LABELS[state.phase] ?? state.phase;
  const roundIcon = ROUND_ICONS[state.phase] ?? '';

  // gap #N: clock-skew-corrected, computed once above so the countdown and the
  // audio alerts can never disagree about what second it is
  const secondsLeft = remaining;
  const scoreFlashTeam = flashEvent?.kind === 'correct' ? flashEvent.team : null;
  const canPass = state.config.allowSkip[state.phase as 'ROUND1' | 'ROUND2' | 'ROUND3'] ?? true;
  const hostPaused = round.paused && round.pauseReason === 'host-paused';

  async function act(event: 'correct-guess' | 'pass-turn') {
    if (!mySlip || !round.turnId) return;
    flashSeq.current += 1;
    setFlashEvent({ id: flashSeq.current, kind: event === 'correct-guess' ? 'correct' : 'pass', team: state!.activeTeam });
    // correct-guess is played room-wide by GameSounds off the guessed count;
    // a pass only shows up as a reshuffle, so the drawer plays it locally
    if (event === 'pass-turn') passed();
    const res = await emitAck<{ ok: boolean; error?: string }>(event, { slipId: mySlip.id, turnId: round.turnId });
    setError(res.ok ? null : (res.error ?? 'action failed'));
  }

  async function startTurn() {
    primeAudio(); // real user gesture — unlocks audio for the beeps below
    const res = await emitAck<{ ok: boolean; error?: string }>('start-turn');
    setError(res.ok ? null : (res.error ?? 'could not start turn'));
  }

  async function resumeTurn() {
    const res = await emitAck<{ ok: boolean; error?: string }>('resume-turn');
    setError(res.ok ? null : (res.error ?? 'could not resume'));
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
          {hostPaused ? (
            <p>Paused by the host.</p>
          ) : (
            <p>
              Paused — waiting for <PlayerName state={state} playerId={round.drawerId} />.
            </p>
          )}
          {/* a host pause is the host's to lift, so they get the button too —
              the drawer may well be the reason the game was stopped */}
          {(isDrawer || (hostPaused && isHost)) && (
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
          <div className={canPass ? 'turn-actions' : 'turn-actions turn-actions-single'}>
            {canPass && (
              <button className="btn btn-pass" onClick={() => act('pass-turn')}>
                Pass
              </button>
            )}
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

      {/* Everyone sees what's gone this round — these were all said out loud as
          they were guessed, so there's nothing to protect. Deliberately reset
          each round: remembering the earlier rounds' words is the game.
          Hidden from the drawer mid-turn: it competes with the slip for the
          flex space, so the paper visibly jumps every time a word lands. */}
      {!(isDrawer && round.turnEndsAt) && round.guessedThisRound.length > 0 && (
        <div className="card guessed-log">
          <h3>Guessed this round</h3>
          <ul>
            {[...round.guessedThisRound].reverse().map((slip) => (
              <li key={slip.id}>
                <span className="guessed-log-word">{slip.text}</span>
                {slip.playerName && (
                  <span className={`guessed-log-who ${slip.team ? TEAM_CLASS[slip.team] : ''}`}>
                    {slip.playerName}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.config.chatEnabled && <TurnChat />}

      {isHost && (
        <div className="host-escape-hatches">
          <AdminDrawer />
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
