import { randomUUID } from 'node:crypto';

// ponytail: single in-memory Map is the whole "database" — room count is
// party-scale (a handful of rooms, a dozen players each), no need for a real store.
export const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code)); // gap #I: regenerate on collision
  return code;
}

export function newRoom() {
  const code = generateRoomCode();
  const room = {
    code,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    hostId: null,
    // Pass/skip enabled per round by default — off for Password (round 3):
    // one-word clues don't leave much room for "come back to this one later".
    // hotJoin: latecomers can drop into a game already under way. Off means
    // the doors shut the moment the game starts (the original behaviour).
    config: {
      wordsPerPlayer: 5,
      turnSeconds: 60,
      hotJoin: true,
      allowSkip: { ROUND1: true, ROUND2: true, ROUND3: false },
    },
    players: new Map(), // playerId -> { id, secret, name, team, connected, socketId }
    phase: 'LOBBY', // LOBBY -> WRITING -> ROUND1 -> ROUND2 -> ROUND3 -> SCORES
    submissions: {}, // playerId -> string[]
    pool: {}, // slipId -> { id, text, authorId }
    activeTeam: 'A',
    turnOrder: { A: [], B: [] },
    turnPointer: { A: 0, B: 0 },
    round: {
      number: 0,
      remaining: [], // slipId[]
      guessed: [], // slipId[]
      currentSlipId: null,
      turnId: null,
      drawerId: null,
      turnEndsAt: null,
      remainingMsAtPause: null,
      paused: false,
      pauseReason: null,
      timeoutHandle: null,
    },
    // both derived from pool[].scoredBy by game.recomputeScores — cached here
    // only so the broadcast payload stays cheap
    teamScores: { A: 0, B: 0 },
    roundScores: [], // [{A,B}] per completed round
  };
  rooms.set(code, room);
  return room;
}

export function getRoom(code) {
  return rooms.get((code || '').toUpperCase());
}

/** Evict a room from memory (disk removal is persist.deleteRoom's job). */
export function destroyRoom(code) {
  rooms.delete(code);
}

export function addPlayer(room, name) {
  const id = randomUUID();
  const secret = randomUUID();
  const countA = [...room.players.values()].filter((p) => p.team === 'A').length;
  const countB = [...room.players.values()].filter((p) => p.team === 'B').length;
  const player = {
    id,
    secret,
    name: (name || 'Player').slice(0, 40),
    team: countA <= countB ? 'A' : 'B',
    connected: true,
    socketId: null,
  };
  room.players.set(id, player);
  if (!room.hostId) room.hostId = id;
  return player;
}

export function findPlayerBySecret(room, playerId, secret) {
  const player = room.players.get(playerId);
  if (!player || player.secret !== secret) return null;
  return player;
}

/** Can a newcomer still get in? Always during the lobby; mid-game only when the
 *  host left hot join on. Never once the game is over — there's nothing to join. */
export function canJoin(room) {
  if (room.phase === 'SCORES') return false;
  return room.phase === 'LOBBY' || room.config.hotJoin !== false;
}

export function isHost(room, playerId) {
  return room.hostId === playerId;
}

/** gap #4: host disconnect transfers to oldest connected player. */
export function transferHostIfNeeded(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return;
  const next = [...room.players.values()].find((p) => p.connected);
  room.hostId = next ? next.id : room.hostId;
}

/** Explicit "Leave room" click: fully remove the slot (unlike a disconnect,
 *  which keeps it for reconnect). Otherwise leave+rejoin piles up ghost
 *  entries with the same name forever. */
export function removePlayer(room, playerId) {
  room.players.delete(playerId);
  delete room.submissions[playerId];
  if (room.hostId === playerId) {
    const next = [...room.players.values()].find((p) => p.connected);
    room.hostId = next ? next.id : null;
  }
}

/** gap #S: is a team fully empty of connected players. */
export function teamHasConnectedPlayer(room, team) {
  return [...room.players.values()].some((p) => p.team === team && p.connected);
}

export function connectedCount(room) {
  return [...room.players.values()].filter((p) => p.connected).length;
}

/**
 * set-team: host may move anyone, a player may only move themself.
 */
export function setTeam(room, callerPlayerId, targetPlayerId, team) {
  if (team !== 'A' && team !== 'B') return { ok: false, error: 'invalid team' };
  const target = room.players.get(targetPlayerId);
  if (!target) return { ok: false, error: 'player not found' };
  if (callerPlayerId !== targetPlayerId && !isHost(room, callerPlayerId)) {
    return { ok: false, error: 'only host can move other players' };
  }
  target.team = team;
  return { ok: true };
}
