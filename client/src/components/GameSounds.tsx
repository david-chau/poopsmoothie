import { useEffect, useRef } from 'react';
import { useGame } from '../GameContext';
import { correct, playerJoined, roundEnd, fanfare } from '../alert';

/** Headless. Room-wide moments are played off the broadcast state rather than
 *  from the click that caused them, so *everyone* hears a correct guess, not
 *  just the drawer who tapped it.
 *
 *  Every watcher starts from the first state it sees rather than from zero,
 *  so refreshing or joining mid-game doesn't replay the whole game at you.
 *  Turn-countdown sounds live in Turn.tsx, where the deadline is. */
export default function GameSounds() {
  const { state } = useGame();
  const players = state?.players.length ?? 0;
  const guessed = state?.round.guessedCount ?? 0;
  const roundsDone = state?.roundScores.length ?? 0;
  const phase = state?.phase ?? null;

  const prev = useRef<{ players: number; guessed: number; roundsDone: number; phase: string | null } | null>(null);

  useEffect(() => {
    const now = { players, guessed, roundsDone, phase };
    const before = prev.current;
    prev.current = now;
    if (!before) return; // first sighting is the baseline, not news

    if (now.guessed > before.guessed) correct();
    if (now.players > before.players) playerJoined();
    if (now.roundsDone > before.roundsDone) roundEnd();
    if (now.phase === 'SCORES' && before.phase !== 'SCORES') fanfare();
  }, [players, guessed, roundsDone, phase]);

  return null;
}
