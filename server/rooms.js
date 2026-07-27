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
    // chatEnabled: off by default — the audit-trail chat (and open-mic voice
    // on top of it) is a newer, heavier feature than the core game; a host
    // opts in per room rather than every table getting it unasked.
    // voiceLanguage: one language, never mixed — a single bilingual ASR model
    // was tried and dropped for cross-contaminating English with Chinese
    // (see server/stt.js). Only meaningful when chatEnabled and the server
    // actually has that language's model loaded.
    config: {
      wordsPerPlayer: 5,
      turnSeconds: 60,
      hotJoin: true,
      chatEnabled: false,
      voiceLanguage: 'en',
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
      // audit trail for the live round only — see game.js startRound/resetForRematch
      chat: [], // { id, playerId, name, team, wasDrawer, via, text, at }[]
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

/**
 * Reserved to bots, so a bot name can never be typed by a person.
 *
 * Without a namespace the two are indistinguishable: a human calling themselves
 * "Jill" and a bot called "Jill" collide on the one thing the app uses as
 * identity, and reclaim has to guess which is which. A prefix nobody may type
 * settles it by construction. Enforced on the server — a client check is a
 * nicety, not a rule.
 */
export const BOT_NAME_PREFIX = '[🤖] ';

/** Would this name trespass on the bots' namespace? */
export function isReservedName(name) {
  return normalizeName(name).startsWith(BOT_NAME_PREFIX.trim().toLowerCase());
}

export function normalizeName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase();
}

/** Names identify players, so no two in a room may share one. Reclaiming
 *  handles the usual case (same person coming back); this covers the rest —
 *  chiefly someone typing a bot's name, which reclaim deliberately won't take. */
function uniqueName(room, wanted) {
  const taken = new Set([...room.players.values()].map((p) => normalizeName(p.name)));
  if (!taken.has(normalizeName(wanted))) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted} ${n}`.slice(0, 40);
    if (!taken.has(normalizeName(candidate))) return candidate;
  }
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
    name: uniqueName(room, (String(name ?? '').trim() || 'Player').slice(0, 40)),
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
 * The name is the identity, so names are unique within a room and joining as an
 * existing one means "I am that player".
 *
 * Which of two things that means depends entirely on whether the original
 * device is still connected:
 *   - still connected  -> a genuine name clash. The caller refuses it; taking a
 *                         seat from someone actively playing is never right.
 *   - disconnected     -> the same person coming back on a different device, or
 *                         after clearing storage, or after the server restarted
 *                         under them. They get their slot back — team, score
 *                         attribution, and host if it was only handed on
 *                         because they dropped — with fresh credentials.
 *
 * A stored secret alone is not a reliable way back (storage clears, phones get
 * swapped, servers restart), which is why the name is what identifies you.
 *
 * Bots are excluded: their names are server-assigned, and a human typing
 * "Bot 1" wants a seat, not to become the bot.
 */
export function findByName(room, name) {
  const wanted = normalizeName(name);
  if (!wanted) return null;
  return [...room.players.values()].find((p) => !p.isBot && normalizeName(p.name) === wanted) ?? null;
}

export function reclaimSlot(room, name) {
  const slot = findByName(room, name);
  // never take a seat from someone who is still connected — that's a name
  // clash, and the caller answers it with an error instead
  if (!slot || slot.connected) return null;
  const secret = resetSecret(slot); // the old device's credential dies here
  slot.connected = true;
  // The seat was only on loan. transferHostIfNeeded hands host on when the host
  // drops, so the room isn't stuck; coming back takes it home again.
  const wasHost = !!slot.wasHost;
  delete slot.wasHost;
  return { player: slot, secret, wasHost };
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
/**
 * Keep the host seat with a human who is actually here.
 *
 * A bot must never hold it. Bots have no UI, so handing one the room means the
 * admin controls exist for nobody — and in a solo-plus-bots game that is what
 * happened on every refresh: the human dropped for a moment, the seat went to
 * the first "connected" player (a bot), and rejoining found a connected host
 * and left it there. Permanently hostless.
 *
 * If nobody human is connected, the seat stays where it is rather than moving,
 * so the absent host simply gets it back when they return.
 */
export function transferHostIfNeeded(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected && !host.isBot) return;
  const next = [...room.players.values()].find((p) => p.connected && !p.isBot);
  if (!next || next.id === room.hostId) return;
  // remember that this one only lost the seat by dropping, so reclaiming their
  // name gives it back rather than leaving them a normal player
  if (host && !host.isBot) host.wasHost = true;
  room.hostId = next.id;
}

/** Explicit "Leave room" click: fully remove the slot (unlike a disconnect,
 *  which keeps it for reconnect). Otherwise leave+rejoin piles up ghost
 *  entries with the same name forever. */
export function removePlayer(room, playerId) {
  room.players.delete(playerId);
  delete room.submissions[playerId];
  if (room.hostId === playerId) {
    // a bot holding the seat is the same as nobody holding it (see
    // transferHostIfNeeded); prefer any human, connected or not, over a bot
    const humans = [...room.players.values()].filter((p) => !p.isBot);
    const next = humans.find((p) => p.connected) ?? humans[0];
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
