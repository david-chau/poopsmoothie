// Host-spawned bots for test/demo runs, so a game can be tried out without
// rounding up four phones.
//
// These are the *same* bots as `npm run bots` (server/bot.js) — real socket.io
// clients that loop back to this server and join like anyone else. That's the
// point: to the game logic a bot is an ordinary player, so turn rotation,
// pause-on-disconnect, host transfer and persistence all keep working with no
// special-casing anywhere. The alternative (virtual players driven inside the
// server) would mean branching every one of those paths.
import { randomUUID } from 'node:crypto';
import { createBot } from './bot.js';

/** Total players a room will hold once bots are in the mix. Bots are cheap but
 *  each is a live socket, and a 12-player game is already very long. */
export const MAX_PLAYERS = 12;
export const MAX_BOTS_PER_CALL = 6;

const byRoom = new Map(); // roomCode -> Set<{ socket, getId }>
const pendingTokens = new Map(); // roomCode -> Set<token>

function nextBotName(taken) {
  for (let i = 1; ; i++) {
    const name = `Bot ${i}`;
    if (!taken.has(name)) return name;
  }
}

export function addBots(room, count, url) {
  const handles = byRoom.get(room.code) ?? new Set();
  const tokens = pendingTokens.get(room.code) ?? new Set();
  const taken = new Set([...room.players.values()].map((p) => p.name));
  for (let i = 0; i < count; i++) {
    const name = nextBotName(taken);
    taken.add(name); // the joins race each other — reserve the name now, not when it lands
    const botToken = randomUUID();
    tokens.add(botToken);
    handles.add(createBot({ url, roomCode: room.code, name, botToken }));
  }
  byRoom.set(room.code, handles);
  pendingTokens.set(room.code, tokens);
}

/** Consume a one-time token issued by addBots, marking that join as a bot.
 *  Server-generated and single-use on purpose: the flag has to be settled
 *  synchronously *at join time*. Deriving it later from the client handle's own
 *  id doesn't work — the server broadcasts the new roster before the bot's
 *  join-room ack reaches the bot, so the flag would flicker false on the very
 *  state everyone renders. Also means a browser can't claim to be a bot. */
export function claimBotToken(roomCode, token) {
  const tokens = pendingTokens.get(roomCode);
  if (!token || !tokens?.has(token)) return false;
  tokens.delete(token);
  return true;
}

export function botIds(room) {
  return [...room.players.values()].filter((p) => p.isBot).map((p) => p.id);
}

/** True when the humans have all left and only bots are holding the room open —
 *  without this a demo room full of bots would live on disk forever. */
export function onlyBotsRemain(room) {
  if (room.players.size === 0) return false;
  return [...room.players.values()].every((p) => p.isBot);
}

/** Close every bot socket in a room and hand back their player ids, so the
 *  caller can drop them from the roster. Deliberately not an emitted
 *  'leave-room': that ack would race the disconnect() right behind it, and the
 *  caller is already holding the room and can remove them synchronously. */
export function removeBots(room) {
  const ids = botIds(room);
  for (const handle of byRoom.get(room.code) ?? []) handle.socket.disconnect();
  byRoom.delete(room.code);
  pendingTokens.delete(room.code);
  return ids;
}

/** Drop the handle bookkeeping without touching sockets — for a room that's
 *  already being destroyed. */
export function forgetRoom(roomCode) {
  byRoom.delete(roomCode);
  pendingTokens.delete(roomCode);
}

/** Teardown hook: close every bot socket this process owns. Without it a test
 *  run (or a shutdown) hangs on the open handles. */
export function removeAllBots() {
  for (const handles of byRoom.values()) {
    for (const handle of handles) handle.socket.disconnect();
  }
  byRoom.clear();
  pendingTokens.clear();
}
