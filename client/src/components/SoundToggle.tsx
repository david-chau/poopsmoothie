import { useState } from 'react';
import { isMuted, setMuted, primeAudio, tick } from '../alert';

/** Shell chrome, so it's reachable from every screen — including before a turn
 *  starts, which is the moment someone realises they want it off. */
export default function SoundToggle() {
  const [muted, setLocal] = useState(isMuted);

  function toggle() {
    const next = !muted;
    setMuted(next);
    setLocal(next);
    // unmuting is a user gesture, so it's the right moment to unlock audio and
    // confirm it actually works — a silent toggle gives no feedback at all
    if (!next) {
      primeAudio();
      tick();
    }
  }

  return (
    <button
      className="link-btn sound-toggle"
      onClick={toggle}
      aria-pressed={muted}
      aria-label={muted ? 'Unmute turn alerts' : 'Mute turn alerts'}
      title={muted ? 'Turn alerts are muted' : 'Turn alerts are on'}
    >
      {muted ? '🔇' : '🔊'}
    </button>
  );
}
