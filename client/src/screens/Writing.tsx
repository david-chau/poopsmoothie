import { useRef, useState } from 'react';
import { useGame } from '../GameContext';
import { emitAck } from '../socket';
import { primeAudio, submitted } from '../alert';
import RulesDialog from '../components/RulesDialog';
import { FoldingSlip, SlipBox, foldAwayDurationMs } from '../components/FoldingSlip';
import PaperCutIntro from '../components/PaperCutIntro';

export default function Writing() {
  const { state, identity, isHost, leaveToLanding } = useGame();
  const [words, setWords] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // words held while they fold into the box, so the animation has something to
  // show after the inputs are gone
  const [folding, setFolding] = useState<string[] | null>(null);
  // the sheet-into-slips intro, once per visit to the writing screen
  const [cutting, setCutting] = useState(true);
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

  /**
   * Fold, drop in the box, *then* submit — in that order, and the screen doesn't
   * move on until it's done.
   *
   * Submitting first meant the server's reply flipped `hasSubmitted` immediately
   * and the "words in" view replaced the animation before it could play. Doing
   * the physical part first also matches the table: you fold your slips and put
   * them in the box, and only then are you ready.
   */
  async function submit() {
    primeAudio(); // user gesture: unlock audio here so the round sounds work later
    // checked here rather than after the animation — the server would reject an
    // empty slip, and animating first would make that rejection arrive late
    if (values.some((v) => !v.trim())) return setError(`Fill in all ${n} slips first`);

    setBusy(true);
    setError(null);
    setFolding(values);
    await new Promise((resolve) => setTimeout(resolve, foldAwayDurationMs(values.length)));
    submitted(); // they've landed in the box

    const res = await emitAck<{ ok: boolean; error?: string }>('submit-words', { words: values });
    setBusy(false);
    setFolding(null);
    setError(res.ok ? null : (res.error ?? 'could not submit'));
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
      {cutting && !hasSubmitted ? (
        <PaperCutIntro count={n} onDone={() => setCutting(false)} />
      ) : (
        <>
      {values.map((v, i) => (
        <div key={i} className="word-row">
          {/* a slip you write on, not a form field: painted paper behind a
              transparent input, so the ink sits on the paper itself */}
          {folding ? (
            <FoldingSlip text={v} index={i} total={values.length} />
          ) : (
            <div className="write-slip">
              <div className="paper-surface write-slip-paper" />
              <input
                className="write-slip-input"
                value={v}
                onChange={(e) => setWord(i, e.target.value)}
                placeholder={`Word or phrase ${i + 1}`}
                maxLength={80}
              />
            </div>
          )}
          {/* gone once folding starts: there is nothing left to re-roll, and
              leaving it there pushed the slips off-centre from the box */}
          {!folding && (
            <button
              className="btn dice-btn"
              onClick={() => suggestOne(i)}
              aria-label={`Suggest a word or phrase for slot ${i + 1}`}
              title="Suggest one for me"
            >
              🎲
            </button>
          )}
        </div>
      ))}
      {folding ? (
        <SlipBox />
      ) : (
        <>
          <button className="btn" onClick={suggestRest} disabled={!hasEmpty}>
            🎲 Fill the empty ones for me
          </button>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary btn-bottom" disabled={busy} onClick={submit}>
            Submit
          </button>
        </>
      )}
        </>
      )}
    </div>
  );
}
