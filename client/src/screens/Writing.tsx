import { useRef, useState } from 'react';
import { useGame } from '../GameContext';
import { emitAck } from '../socket';
import RulesDialog from '../components/RulesDialog';

export default function Writing() {
  const { state, identity, isHost, leaveToLanding } = useGame();
  const [words, setWords] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rulesRef = useRef<HTMLDialogElement>(null);
  if (!state || !identity) return null;

  const n = state.config.wordsPerPlayer;
  const values = Array.from({ length: n }, (_, i) => words[i] ?? '');
  const hasSubmitted = state.submittedPlayerIds.includes(identity.playerId);
  const connectedPlayers = state.players.filter((p) => p.connected);
  const connectedTotal = connectedPlayers.length;
  // submittedPlayerIds accumulates all-time, so someone who submitted then
  // disconnected would otherwise push the numerator past the denominator.
  const connectedSubmittedCount = connectedPlayers.filter((p) => state.submittedPlayerIds.includes(p.id)).length;

  function setWord(i: number, value: string) {
    const next = values.slice();
    next[i] = value;
    setWords(next);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await emitAck<{ ok: boolean; error?: string }>('submit-words', { words: values });
    setBusy(false);
    setError(res.ok ? null : (res.error ?? 'could not submit'));
  }

  async function forceStart() {
    const res = await emitAck<{ ok: boolean; error?: string }>('force-start-round');
    setError(res.ok ? null : (res.error ?? 'could not force start'));
  }

  if (hasSubmitted) {
    return (
      <div className="screen screen-center">
        <div className="lobby-topbar">
          <button className="link-btn leave-link" onClick={leaveToLanding}>
            &larr; Leave room
          </button>
          <button className="link-btn" onClick={() => rulesRef.current?.showModal()}>
            📜 How to play
          </button>
        </div>
        <RulesDialog ref={rulesRef} />
        <h1 className="title">Words in! ✍️</h1>
        <p className="subtitle">
          Waiting on the rest of the table: {connectedSubmittedCount}/{connectedTotal}
        </p>
        {isHost && (
          <button className="btn" onClick={forceStart}>
            Start now with whoever&rsquo;s ready
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="lobby-topbar">
        <button className="link-btn leave-link" onClick={leaveToLanding}>
          &larr; Leave room
        </button>
        <button className="link-btn" onClick={() => rulesRef.current?.showModal()}>
          📜 How to play
        </button>
      </div>
      <RulesDialog ref={rulesRef} />
      <h1 className="title">Write {n} words</h1>
      <p className="subtitle">Nouns, names, phrases — anything guessable. Keep them varied!</p>
      {values.map((v, i) => (
        <input
          key={i}
          className="word-input"
          value={v}
          onChange={(e) => setWord(i, e.target.value)}
          placeholder={`Word ${i + 1}`}
          maxLength={80}
        />
      ))}
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary btn-bottom" disabled={busy} onClick={submit}>
        Submit
      </button>
    </div>
  );
}
