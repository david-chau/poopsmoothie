import { forwardRef } from 'react';
import { ROUND_ICONS } from '../types';

/** Native <dialog> — showModal()/close() from the parent via ref gives us a
 * backdrop, focus trap, and Esc-to-close for free, no extra dependency. */
const RulesDialog = forwardRef<HTMLDialogElement>((_props, ref) => {
  return (
    <dialog ref={ref} className="rules-dialog">
      <h2>How to play</h2>

      <p>
        Everyone writes a few words or phrases — one per slip, anything guessable. Split into{' '}
        <span className="team-blue">Team Blue</span> and <span className="team-red">Team Red</span>.
      </p>

      <h3>3 rounds, same slips every time</h3>
      <div className="rules-rounds">
        <div className="rules-round">
          <span className="rules-round-icon">{ROUND_ICONS.ROUND1}</span>
          <div>
            <strong>Round 1 — Taboo</strong>
            <p>Describe it any way you like — just don&rsquo;t say the word, spell it, or say what it rhymes with.</p>
          </div>
        </div>
        <div className="rules-round">
          <span className="rules-round-icon">{ROUND_ICONS.ROUND2}</span>
          <div>
            <strong>Round 2 — Charades</strong>
            <p>Act it out. No talking, no sounds.</p>
          </div>
        </div>
        <div className="rules-round">
          <span className="rules-round-icon">{ROUND_ICONS.ROUND3}</span>
          <div>
            <strong>Round 3 — Password</strong>
            <p>One single word as a clue. That&rsquo;s it.</p>
          </div>
        </div>
      </div>

      <h3>Playing a turn</h3>
      <p>
        You&rsquo;ve got a timer to get your team guessing as many slips as you can. Guessed it? Straight on to the
        next one. Stuck? Pass and come back to it. When time runs out, whatever&rsquo;s in your hand goes back in the
        pile for next time.
      </p>

      <p className="rules-winner">🏆 Most correct guesses across all 3 rounds wins.</p>

      <form method="dialog">
        <button className="btn btn-primary">Got it</button>
      </form>
    </dialog>
  );
});

export default RulesDialog;
