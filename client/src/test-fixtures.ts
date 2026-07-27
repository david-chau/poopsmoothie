import type { GameState, Phase } from './types';

/** Minimal valid GameState for component/unit tests; override any field. */
export function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    code: 'ABCD',
    hostId: 'p1',
    config: {
      wordsPerPlayer: 5,
      turnSeconds: 60,
      hotJoin: true,
      chatEnabled: false,
      voiceLanguage: 'en',
      allowSkip: { ROUND1: true, ROUND2: true, ROUND3: false },
    },
    phase: 'LOBBY' as Phase,
    players: [
      { id: 'p1', name: 'Alice', team: 'A', connected: true },
      { id: 'p2', name: 'Bob', team: 'B', connected: true },
      { id: 'p3', name: 'Carol', team: 'A', connected: true },
      { id: 'p4', name: 'Dave', team: 'B', connected: true },
    ],
    submittedPlayerIds: [],
    activeTeam: 'A',
    teamScores: { A: 0, B: 0 },
    roundScores: [],
    round: {
      number: 0,
      remainingCount: 0,
      guessedCount: 0,
      drawerId: null,
      turnId: null,
      turnEndsAt: null,
      paused: false,
      pauseReason: null,
      awaitingReady: false,
      readyPlayerIds: [],
      guessedThisRound: [],
      chat: [],
    },
    serverNow: Date.now(),
    ...overrides,
  };
}
