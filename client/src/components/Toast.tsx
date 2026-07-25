import { useEffect } from 'react';
import { useGame } from '../GameContext';

const AUTO_DISMISS_MS = 6000;

/** One-line banner for things that happen *to* you rather than because of you —
 *  right now just "the host ended the game". Auto-dismisses, and is tappable
 *  so it can be cleared early. */
export default function Toast() {
  const { notice, dismissNotice } = useGame();

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(dismissNotice, AUTO_DISMISS_MS);
    return () => clearTimeout(id); // a new notice restarts the clock
  }, [notice, dismissNotice]);

  if (!notice) return null;
  return (
    <div className="toast" role="status" onClick={dismissNotice}>
      {notice}
    </div>
  );
}
