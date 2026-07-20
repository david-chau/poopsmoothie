import type { GameState } from '../types';
import { playerName, playerTeamClass } from '../lib';

/** A player's name, always colored by their current team. */
export default function PlayerName({
  state,
  playerId,
}: {
  state: GameState | null;
  playerId: string | null | undefined;
}) {
  return <span className={playerTeamClass(state, playerId)}>{playerName(state, playerId)}</span>;
}
