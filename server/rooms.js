import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';

// ponytail: single in-memory Map is the whole "database" — room count is
// party-scale (a handful of rooms, a dozen players each), no need for a real store.
export const rooms = new Map();

// A party needs a handful of rooms. Without a ceiling, one socket in a loop
// creates unlimited rooms — each one a JSON file on disk — so this is the
// difference between "annoying" and "fills the NAS".
export const MAX_ROOMS = 50;

export function roomCount() {
  return rooms.size;
}

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
      // rounds 2 and 3 open behind a ready gate so the recap isn't racing a
      // drawer who already tapped start
      awaitingReady: false,
      ready: [], // playerId[]
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
  // String() not `code || ''` — a client can send any JSON type here, and an
  // object/array/number has no .toUpperCase to call
  return rooms.get(String(code ?? '').toUpperCase());
}

/** Evict a room from memory (disk removal is persist.deleteRoom's job). */
export function destroyRoom(code) {
  rooms.delete(code);
}

/** Rejoin credentials are stored hashed, so a room file on the NAS can't be
 *  read to impersonate players. The raw secret is handed to its owner once, at
 *  join time, and never written down server-side. */
export function hashSecret(secret) {
  return createHash('sha256').update(String(secret ?? '')).digest('hex');
}

/** Constant-time compare so a wrong guess can't be narrowed by timing. */
function secretMatches(hash, candidate) {
  const a = Buffer.from(String(hash ?? ''), 'utf8');
  const b = Buffer.from(hashSecret(candidate), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function addPlayer(room, name) {
  const id = randomUUID();
  const secret = randomUUID();
  const countA = [...room.players.values()].filter((p) => p.team === 'A').length;
  const countB = [...room.players.values()].filter((p) => p.team === 'B').length;
  const player = {
    id,
    secretHash: hashSecret(secret),
    // coerce before slicing: `{}` has no .slice, and an array's .slice would
    // quietly produce an array where a string is expected
    name: (String(name ?? '').trim() || 'Player').slice(0, 40),
    team: countA <= countB ? 'A' : 'B',
    connected: true,
    socketId: null,
  };
  room.players.set(id, player);
  if (!room.hostId) room.hostId = id;
  // Raw secret rides back on the returned player so the caller can hand it to
  // its owner, but non-enumerably: object spread and JSON.stringify both skip
  // it, so persist.js writes only the hash. Callers still get the real player
  // object to mutate (socketId, isBot), not a copy.
  Object.defineProperty(player, 'secret', { value: secret, enumerable: false, configurable: true });
  return player;
}

export function findPlayerBySecret(room, playerId, secret) {
  const player = room.players.get(playerId);
  if (!player || !secretMatches(player.secretHash, secret)) return null;
  return player;
}

/** Issue fresh credentials for an existing slot (see reclaimSlot). */
export function resetSecret(player) {
  const secret = randomUUID();
  player.secretHash = hashSecret(secret);
  return secret;
}

/**
 * Someone whose device forgot its credentials (cleared storage, dead battery,
 * borrowed phone) has no way back to their own slot: `rejoin` needs a secret
 * they no longer have, and `join-room` would mint a brand-new player, losing
 * their team and their score attribution — or be refused outright with hot
 * join off. So a *disconnected* slot with a matching name can be reclaimed,
 * with fresh credentials issued.
 *
 * Only disconnected slots, so this can never boot a player who is actively
 * connected. Name alone is weak proof, but it is exactly as strong as the rest
 * of this app's model: no passwords, everyone in one room, network is the
 * boundary (see README). Returns the raw secret for the reclaimer.
 */
export function reclaimSlot(room, name) {
  const wanted = String(name ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const slot = [...room.players.values()].find((p) => !p.connected && !p.isBot && p.name.toLowerCase() === wanted);
  if (!slot) return null;
  const secret = resetSecret(slot); // old credential dies with the old device
  slot.connected = true;
  return { player: slot, secret };
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
