import { useRef, useState } from 'react';
import { useGame } from '../GameContext';
import { emitAck } from '../socket';
import { primeAudio, submitted } from '../alert';
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
  const hasEmpty = values.some((v) => !v.trim());
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
    primeAudio(); // user gesture: unlock audio here so the round sounds work later
    setBusy(true);
    setError(null);
    const res = await emitAck<{ ok: boolean; error?: string }>('submit-words', { words: values });
    setBusy(false);
    setError(res.ok ? null : (res.error ?? 'could not submit'));
    if (res.ok) submitted();
  }

  async function forceStart() {
    const res = await emitAck<{ ok: boolean; error?: string }>('force-start-round');
    setError(res.ok ? null : (res.error ?? 'could not force start'));
  }

  /** Ask the server for suggestions that clash with nobody — it knows what
   *  everyone else has submitted, `exclude` covers our own unsaved boxes. */
  async function suggest(count: number, exclude: string[]) {
    const res = await emitAck<{ ok: boolean; error?: string; words?: string[] }>('suggest-words', { count, exclude });
    if (!res.ok || !res.words?.length) {
      setError(res.error ?? 'no suggestions left — write your own!');
      return null;
    }
    setError(null);
    return res.words;
  }

  async function suggestOne(i: number) {
    const picked = await suggest(1, values.filter((_, j) => j !== i));
    if (picked) setWord(i, picked[0]);
  }

  async function suggestRest() {
    const emptyIndexes = values.flatMap((v, i) => (v.trim() ? [] : [i]));
    if (emptyIndexes.length === 0) return;
    const picked = await suggest(emptyIndexes.length, values);
    if (!picked) return;
    const next = values.slice();
    emptyIndexes.forEach((slot, k) => {
      if (picked[k]) next[slot] = picked[k];
    });
    setWords(next);
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
      <h1 className="title">
        Write {n} words or phrases
      </h1>
      <p className="subtitle">Nouns, names, films, things people do — anything guessable. Keep them varied!</p>
      {values.map((v, i) => (
        <div key={i} className="word-row">
          <input
            className="word-input"
            value={v}
            onChange={(e) => setWord(i, e.target.value)}
            placeholder={`Word or phrase ${i + 1}`}
            maxLength={80}
          />
          <button
            className="btn dice-btn"
            onClick={() => suggestOne(i)}
            aria-label={`Suggest a word or phrase for slot ${i + 1}`}
            title="Suggest one for me"
          >
            🎲
          </button>
        </div>
      ))}
      <button className="btn" onClick={suggestRest} disabled={!hasEmpty}>
        🎲 Fill the empty ones for me
      </button>
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary btn-bottom" disabled={busy} onClick={submit}>
        Submit
      </button>
    </div>
  );
}
