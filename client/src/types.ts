export type Phase = 'LOBBY' | 'WRITING' | 'ROUND1' | 'ROUND2' | 'ROUND3' | 'SCORES';
export type Team = 'A' | 'B';

export interface PlayerPublic {
  id: string;
  name: string;
  team: Team;
  connected: boolean;
  /** host-spawned test player (server/bots.js), not a real device */
  isBot?: boolean;
}

export interface Slip {
  id: string;
  text: string;
  authorId: string;
  /** captured when the pool was built — players who leave are removed from the
   *  roster, and the recap would otherwise credit their words to "someone" */
  authorName?: string | null;
  /** who scored it, per round (same slip is reused every round) */
  scoredBy?: { round: number; team: Team; playerId: string; playerName?: string | null }[];
}

export interface RoundPublic {
  number: number;
  remainingCount: number;
  guessedCount: number;
  drawerId: string | null;
  turnId: string | null;
  turnEndsAt: number | null;
  paused: boolean;
  pauseReason: string | null;
  /** rounds 2 and 3 open behind a ready gate */
  awaitingReady: boolean;
  readyPlayerIds: string[];
  /** guessed so far *this round* — resets each round, since remembering the
   *  earlier rounds' words is the game */
  guessedThisRound: { id: string; text: string; playerName: string | null; team: Team | null }[];
}

/** Mirrors server events.js `publicState()`. Never carries slip text
 * (gaps #1/#O) except the final `pool` reveal once phase is SCORES. */
export interface GameState {
  code: string;
  hostId: string;
  config: {
    wordsPerPlayer: number;
    turnSeconds: number;
    /** latecomers can drop into a game already in progress */
    hotJoin: boolean;
    allowSkip: Record<'ROUND1' | 'ROUND2' | 'ROUND3', boolean>;
  };
  phase: Phase;
  players: PlayerPublic[];
  submittedPlayerIds: string[];
  activeTeam: Team;
  teamScores: { A: number; B: number };
  roundScores: { A: number; B: number }[];
  round: RoundPublic;
  serverNow: number;
  pool?: Slip[];
  /** already-guessed slips (public knowledge), for the host's scoring table */
  guessedSlips?: Pick<Slip, 'id' | 'text' | 'scoredBy'>[];
}

export const ROUND_LABELS: Record<string, string> = {
  ROUND1: 'Taboo',
  ROUND2: 'Charades',
  ROUND3: 'Password',
};

export const ROUND_ICONS: Record<string, string> = {
  ROUND1: '🗣️',
  ROUND2: '🎭',
  ROUND3: '🔑',
};

// Display-only — wire protocol/server keeps plain 'A'/'B'. Blue/Red chosen
// for colorblind safety (distinguishable under all common CVD types), not
// red/green.
export const TEAM_LABELS: Record<Team, string> = { A: 'Blue', B: 'Red' };
export const TEAM_CLASS: Record<Team, string> = { A: 'team-blue', B: 'team-red' };
export const TEAM_BG_CLASS: Record<Team, string> = { A: 'team-blue-bg', B: 'team-red-bg' };

/** Mirrors server/rooms.js — the server is authoritative, this is just so the
 *  UI can say so before making a round trip. */
export const BOT_NAME_PREFIX = '[🤖] ';
