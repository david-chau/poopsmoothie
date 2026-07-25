import * as rooms from './rooms.js';
import * as game from './game.js';
import * as persist from './persist.js';
import * as suggestions from './suggestions.js';
import * as bots from './bots.js';

const ROUND_PHASES = ['ROUND1', 'ROUND2', 'ROUND3'];

/** Public snapshot broadcast to the whole room. Never contains slip text
 *  (gaps #1/#O) — only counts, scores, and identifiers. */
function publicState(room) {
  const roundIdx = ROUND_PHASES.indexOf(room.phase);
  return {
    code: room.code,
    hostId: room.hostId,
    config: room.config,
    phase: room.phase,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      connected: p.connected,
      isBot: !!p.isBot,
    })),
    submittedPlayerIds: Object.keys(room.submissions),
    activeTeam: room.activeTeam,
    teamScores: room.teamScores,
    roundScores: room.roundScores,
    round: {
      number: roundIdx === -1 ? (room.phase === 'SCORES' ? 3 : 0) : roundIdx + 1,
      remainingCount: room.round.remaining.length,
      guessedCount: room.round.guessed.length,
      drawerId: room.round.drawerId,
      turnId: room.round.turnId,
      turnEndsAt: room.round.turnEndsAt,
      paused: room.round.paused,
      pauseReason: room.round.pauseReason,
    },
    serverNow: Date.now(),
    // gap #O: full pool + authors only revealed once the game is over.
    pool: room.phase === 'SCORES' ? Object.values(room.pool) : undefined,
    // Slips that have already been guessed out loud at least once — no longer
    // secret from anybody, so they're safe to name mid-game and are what the
    // host's scoring table edits. Unguessed slips stay hidden, and authorId is
    // withheld until the SCORES reveal either way.
    guessedSlips: Object.values(room.pool)
      .filter((s) => s.scoredBy?.length)
      .map((s) => ({ id: s.id, text: s.text, scoredBy: s.scoredBy })),
  };
}

function broadcastState(io, room) {
  io.to(room.code).emit('state', publicState(room));
}

/** gap #1/#O/#B: current slip text goes ONLY to the drawer's own socket. */
function sendSlipToDrawer(io, room) {
  if (!room.round.drawerId || !room.round.currentSlipId) return;
  const drawer = room.players.get(room.round.drawerId);
  if (!drawer || !drawer.socketId) return;
  io.to(drawer.socketId).emit('slip-revealed', {
    slip: room.pool[room.round.currentSlipId],
    turnId: room.round.turnId,
  });
}

/** Open rooms, for the landing screen's lobby list. Only rooms still in LOBBY
 *  (you can't join once play starts) and only ones with somebody actually
 *  connected, so a room whose players all closed their tabs stops advertising
 *  itself. Codes are deliberately public: everyone here is on the same wifi,
 *  and picking your game off a list beats reading letters out loud. */
function publicLobbies() {
  return [...rooms.rooms.values()]
    .filter((room) => rooms.canJoin(room))
    .map((room) => ({
      code: room.code,
      playerCount: [...room.players.values()].filter((p) => p.connected).length,
      hostName: room.players.get(room.hostId)?.name ?? null,
      phase: room.phase, // so the list can say "Round 2" rather than just "open"
    }))
    .filter((lobby) => lobby.playerCount > 0)
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Everyone gets this, including sockets not in any room — that's the point,
 *  the landing screen is where it's rendered. */
function broadcastLobbies(io) {
  io.emit('lobbies', publicLobbies());
}

function persistAndBroadcast(io, room) {
  persist.saveRoom(room);
  broadcastState(io, room);
  broadcastLobbies(io); // joins/leaves/starts all change what's joinable
}

/** Where bots dial back in. Loopback, not the LAN address: the bot process is
 *  this process, so it never needs to leave the box. */
function selfUrl() {
  return process.env.SELF_URL || `http://127.0.0.1:${process.env.PORT || 4321}`;
}

/** Clamp to a range, keeping the old value for anything non-numeric. Without
 *  the NaN check, `{}` or "abc" clamped to NaN and wrote NaN into the config —
 *  wordsPerPlayer:NaN makes submit-words reject every submission, so the room
 *  can never start and there's no UI to fix it. */
function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function registerSocketHandlers(io, socket) {
  /**
   * Every handler is registered through here rather than socket.on directly.
   * A client controls both the payload *shape* and whether it sends one at all,
   * and socket.io does not sanitise either:
   *   - `emit('join-room', null)` defeats a `= {}` default (it only fires for
   *     `undefined`), so destructuring throws;
   *   - a throw inside a socket handler surfaces as an uncaughtException, which
   *     with no process-level handler kills the server for *everyone*.
   * So: payload coerced to an object, callback located wherever it landed, and
   * anything that still throws becomes an error ack instead of a dead process.
   */
  function on(event, handler) {
    socket.on(event, (payload, maybeAck) => {
      // `emit(event, cb)` with no payload puts the callback in the first slot
      const ack = typeof maybeAck === 'function' ? maybeAck : typeof payload === 'function' ? payload : undefined;
      const data = payload && typeof payload === 'object' ? payload : {};
      try {
        handler(data, ack);
      } catch (err) {
        console.error(`socket handler '${event}' threw:`, err);
        ack?.({ ok: false, error: 'server error' });
      }
    });
  }

  // socket.data.{roomCode, playerId} set once on join/rejoin; every later
  // event trusts only these server-held values, never client-supplied identity.
  function context() {
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return null;
    const player = room.players.get(socket.data.playerId);
    if (!player) return null;
    return { room, player };
  }

  function onTimeout(room) {
    game.timeoutTurn(room);
    persistAndBroadcast(io, room);
  }

  // initial fill for a freshly-loaded landing screen; updates arrive by broadcast
  on('list-lobbies', (_data, ack) => ack?.({ ok: true, lobbies: publicLobbies() }));

  on('create-room', ({ name } = {}, ack) => {
    const room = rooms.newRoom();
    const player = rooms.addPlayer(room, name);
    player.socketId = socket.id;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    persistAndBroadcast(io, room);
    ack?.({ ok: true, roomCode: room.code, playerId: player.id, secret: player.secret });
  });

  on('join-room', ({ roomCode, name, botToken } = {}, ack) => {
    const room = rooms.getRoom(roomCode);
    if (!room) return ack?.({ ok: false, error: 'room not found' });
    if (!rooms.canJoin(room)) return ack?.({ ok: false, error: 'game already started' });
    const player = rooms.addPlayer(room, name);
    // settle the bot flag here, before the roster broadcast below goes out
    if (bots.claimBotToken(room.code, botToken)) player.isBot = true;
    game.addLatePlayer(room, player); // mid-game joiner needs a slot in the rotation
    player.socketId = socket.id;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    persistAndBroadcast(io, room);
    ack?.({ ok: true, roomCode: room.code, playerId: player.id, secret: player.secret });
  });

  on('rejoin', ({ roomCode, playerId, secret } = {}, ack) => {
    const room = rooms.getRoom(roomCode);
    const player = room && rooms.findPlayerBySecret(room, playerId, secret);
    if (!room || !player) return ack?.({ ok: false, error: 'rejoin-failed' }); // gap #7
    player.connected = true;
    player.socketId = socket.id;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    // if the host was offline, hand host to whoever's back — otherwise a turn
    // paused on a disconnected drawer can't be skipped (host-only) and the
    // game is stuck until the exact original host/drawer happens to return.
    rooms.transferHostIfNeeded(room);
    game.recoverStrandedTurn(room); // and un-stick a fully-offline round if that's the state
    persistAndBroadcast(io, room);
    sendSlipToDrawer(io, room); // gap #B: drawer gets their word back
    ack?.({ ok: true, roomCode: room.code, playerId: player.id });
  });

  on('set-team', ({ targetPlayerId, team } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    const result = rooms.setTeam(ctx.room, ctx.player.id, targetPlayerId, team);
    if (result.ok) persistAndBroadcast(io, ctx.room);
    ack?.(result);
  });

  on('set-config', (config = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    // hotJoin isn't a game-balance setting — it's a door. Let the host shut it
    // (or reopen it) mid-game, unlike everything below which locks at start.
    if (config.hotJoin != null) {
      ctx.room.config.hotJoin = !!config.hotJoin;
      persistAndBroadcast(io, ctx.room);
      if (Object.keys(config).length === 1) return ack?.({ ok: true });
    }
    if (ctx.room.phase !== 'LOBBY' && ctx.room.phase !== 'WRITING') {
      return ack?.({ ok: false, error: 'config locked once play starts' }); // gap #R
    }
    // `!= null` not truthiness — 0 is a valid (if nonsensical) input and should still clamp, not be ignored
    if (config.wordsPerPlayer != null) ctx.room.config.wordsPerPlayer = clampInt(config.wordsPerPlayer, 1, 20, ctx.room.config.wordsPerPlayer);
    if (config.turnSeconds != null) ctx.room.config.turnSeconds = clampInt(config.turnSeconds, 10, 300, ctx.room.config.turnSeconds);
    if (config.allowSkip && typeof config.allowSkip === 'object') {
      for (const phase of ROUND_PHASES) {
        if (config.allowSkip[phase] != null) ctx.room.config.allowSkip[phase] = !!config.allowSkip[phase];
      }
    }
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  // Test/demo helper: fill the lobby with auto-playing fake players. LOBBY only,
  // because that's the only phase join-room accepts — same door as a real guest.
  on('add-bots', ({ count } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    if (ctx.room.phase !== 'LOBBY') return ack?.({ ok: false, error: 'bots can only be added from the lobby' });
    const n = Math.max(1, Math.min(bots.MAX_BOTS_PER_CALL, Math.trunc(Number(count)) || 1));
    if (ctx.room.players.size + n > bots.MAX_PLAYERS) {
      return ack?.({ ok: false, error: `room holds at most ${bots.MAX_PLAYERS} players` });
    }
    bots.addBots(ctx.room, n, selfUrl());
    // no broadcast here — each bot's own join-room does it as it lands
    ack?.({ ok: true });
  });

  on('remove-bots', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    const removed = bots.removeBots(ctx.room);
    for (const botId of removed) rooms.removePlayer(ctx.room, botId);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true, removed: removed.length });
  });

  on('start-game', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    if (ctx.room.phase !== 'LOBBY') return ack?.({ ok: false, error: 'already started' });
    if (rooms.connectedCount(ctx.room) < 4) return ack?.({ ok: false, error: 'need at least 4 players' }); // gap #11
    game.startWriting(ctx.room);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  on('submit-words', ({ words } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (ctx.room.phase !== 'WRITING') return ack?.({ ok: false, error: 'not in writing phase' });
    const result = game.submitWords(ctx.room, ctx.player.id, words);
    if (!result.ok) return ack?.(result);
    // gap #10: auto-advance once every connected player has submitted.
    if (game.allConnectedSubmitted(ctx.room)) {
      game.beginRound1(ctx.room);
      persistAndBroadcast(io, ctx.room);
      sendSlipToDrawer(io, ctx.room);
    } else {
      persistAndBroadcast(io, ctx.room);
    }
    ack?.({ ok: true });
  });

  // read-only: hands back suggestions, never writes them into submissions —
  // the player still has to look at them and hit Submit.
  on('suggest-words', ({ count, exclude } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (ctx.room.phase !== 'WRITING') return ack?.({ ok: false, error: 'not in writing phase' });
    const n = Math.max(1, Math.min(20, Math.trunc(Number(count)) || 1));
    const words = suggestions.suggestWords(ctx.room, n, Array.isArray(exclude) ? exclude : []);
    ack?.({ ok: true, words });
  });

  on('force-start-round', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    if (ctx.room.phase !== 'WRITING') return ack?.({ ok: false, error: 'not in writing phase' });
    if (Object.keys(ctx.room.pool).length === 0 && Object.keys(ctx.room.submissions).length === 0) {
      return ack?.({ ok: false, error: 'no words submitted yet' });
    }
    game.beginRound1(ctx.room);
    persistAndBroadcast(io, ctx.room);
    sendSlipToDrawer(io, ctx.room);
    ack?.({ ok: true });
  });

  on('start-turn', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    const result = game.startTurn(ctx.room, ctx.player.id, onTimeout);
    if (!result.ok) return ack?.(result);
    persistAndBroadcast(io, ctx.room);
    sendSlipToDrawer(io, ctx.room);
    ack?.({ ok: true });
  });

  on('correct-guess', ({ slipId, turnId } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    const result = game.correctGuess(ctx.room, ctx.player.id, slipId, turnId);
    if (!result.ok) return ack?.(result);
    game.endTurnIfRoundOver(ctx.room, result.roundEnded);
    persistAndBroadcast(io, ctx.room);
    if (!result.roundEnded) sendSlipToDrawer(io, ctx.room);
    ack?.({ ok: true });
  });

  on('pass-turn', ({ slipId, turnId } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    const result = game.passTurn(ctx.room, ctx.player.id, slipId, turnId);
    if (!result.ok) return ack?.(result);
    game.endTurnIfRoundOver(ctx.room, result.roundEnded);
    persistAndBroadcast(io, ctx.room);
    if (!result.roundEnded) sendSlipToDrawer(io, ctx.room);
    ack?.({ ok: true });
  });

  on('skip-drawer', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    // gap #5/#V: host role always transfers to a connected player on disconnect
    // (rooms.transferHostIfNeeded), so "host only" never deadlocks a stuck drawer.
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    game.skipDrawer(ctx.room);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  on('force-pass-team', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    if (!ROUND_PHASES.includes(ctx.room.phase)) return ack?.({ ok: false, error: 'no turn in progress' });
    game.forcePassTeam(ctx.room);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  on('resume-turn', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    const result = game.resumeTurn(ctx.room, ctx.player.id, onTimeout, {
      isHost: rooms.isHost(ctx.room, ctx.player.id),
    });
    if (!result.ok) return ack?.(result);
    persistAndBroadcast(io, ctx.room);
    sendSlipToDrawer(io, ctx.room);
    ack?.({ ok: true });
  });

  on('host-pause', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    if (!ROUND_PHASES.includes(ctx.room.phase)) return ack?.({ ok: false, error: 'no turn in progress' });
    const result = game.hostPause(ctx.room);
    if (!result.ok) return ack?.(result);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  on('revert-last-guess', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    const result = game.revertLastGuess(ctx.room);
    if (!result.ok) return ack?.(result);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true, text: result.text });
  });

  on('set-drawer', ({ playerId } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    const result = game.setDrawer(ctx.room, playerId);
    if (!result.ok) return ack?.(result);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  on('set-slip-scorer', ({ slipId, round, playerId } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    const result = game.setSlipScorer(ctx.room, slipId, round, playerId ?? null);
    if (!result.ok) return ack?.(result);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  // Nuke the room for everyone. Unlike end-game (which just jumps to SCORES and
  // leaves the room joinable), this destroys it — so every client gets told
  // explicitly, before the room is gone, and sends itself back to the landing.
  on('end-room', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    const code = ctx.room.code;
    bots.removeBots(ctx.room);
    io.to(code).emit('room-closed', { reason: 'The host ended the game.' });
    io.socketsLeave(code); // nobody left to broadcast to after this
    rooms.destroyRoom(code);
    bots.forgetRoom(code);
    persist.deleteRoom(code);
    broadcastLobbies(io); // it just stopped being joinable
    ack?.({ ok: true });
  });

  on('end-game', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    game.endGameNow(ctx.room);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  on('leave-room', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: true });
    const wasDrawer = ROUND_PHASES.includes(ctx.room.phase) && ctx.room.round.drawerId === ctx.player.id;
    rooms.removePlayer(ctx.room, ctx.player.id); // voluntary leave: drop the slot, not just mark offline
    socket.leave(ctx.room.code);
    delete socket.data.roomCode;
    delete socket.data.playerId;
    // bots don't know to go home: once the humans are gone they'd hold the room
    // open forever, so the last human out takes them with them.
    if (bots.onlyBotsRemain(ctx.room)) {
      for (const botId of bots.removeBots(ctx.room)) rooms.removePlayer(ctx.room, botId);
    }
    // last one out: tear the room down instead of leaving an empty husk in
    // memory and on disk forever (nobody to broadcast to, either).
    if (ctx.room.players.size === 0) {
      rooms.destroyRoom(ctx.room.code);
      bots.forgetRoom(ctx.room.code);
      persist.deleteRoom(ctx.room.code);
      broadcastLobbies(io);
      return ack?.({ ok: true });
    }
    if (wasDrawer) game.skipDrawer(ctx.room); // they're gone for good, don't leave the turn paused forever
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const ctx = context();
    if (!ctx) return;
    ctx.player.connected = false;
    ctx.player.socketId = null;
    handleDisconnectSideEffects(io, ctx.room, ctx.player);
    persistAndBroadcast(io, ctx.room);
  });
}

/** gap #4/#D/#S: host transfer, drawer-only pause, team-empty pause. */
function handleDisconnectSideEffects(io, room, player) {
  rooms.transferHostIfNeeded(room);
  if (ROUND_PHASES.includes(room.phase) && room.round.drawerId === player.id) {
    game.pauseForDisconnectedDrawer(room);
  }
}
