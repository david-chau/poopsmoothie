import { useGame } from '../GameContext';
import { TEAM_CLASS, TEAM_LABELS } from '../types';

/** "You're <name>" chrome, pinned above every in-room screen so nobody has to
 *  remember which phone is whose. Team-colored from the writing phase onward;
 *  in the lobby teams are still being shuffled and the roster already shows
 *  which column you're in. Renders nothing on Landing (no room yet). */
export default function MyNameBadge() {
  const { state, myPlayer } = useGame();
  if (!state || !myPlayer) return null;

  const showTeam = state.phase !== 'LOBBY';
  return (
    <div className="my-name-badge">
      You&rsquo;re <span className={showTeam ? TEAM_CLASS[myPlayer.team] : undefined}>{myPlayer.name}</span>
      {/* team spelled out as well as colored — the color alone isn't an
          accessible signal, and it's the thing people forget mid-game */}
      {showTeam && <span className={TEAM_CLASS[myPlayer.team]}> · Team {TEAM_LABELS[myPlayer.team]}</span>}
    </div>
  );
}
