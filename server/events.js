import * as rooms from './rooms.js';
import * as game from './game.js';
import * as persist from './persist.js';

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

function persistAndBroadcast(io, room) {
  persist.saveRoom(room);
  broadcastState(io, room);
}

export function registerSocketHandlers(io, socket) {
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

  socket.on('create-room', ({ name } = {}, ack) => {
    const room = rooms.newRoom();
    const player = rooms.addPlayer(room, name);
    player.socketId = socket.id;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    persistAndBroadcast(io, room);
    ack?.({ ok: true, roomCode: room.code, playerId: player.id, secret: player.secret });
  });

  socket.on('join-room', ({ roomCode, name } = {}, ack) => {
    const room = rooms.getRoom(roomCode);
    if (!room) return ack?.({ ok: false, error: 'room not found' });
    if (room.phase !== 'LOBBY') return ack?.({ ok: false, error: 'game already started' });
    const player = rooms.addPlayer(room, name);
    player.socketId = socket.id;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    persistAndBroadcast(io, room);
    ack?.({ ok: true, roomCode: room.code, playerId: player.id, secret: player.secret });
  });

  socket.on('rejoin', ({ roomCode, playerId, secret } = {}, ack) => {
    const room = rooms.getRoom(roomCode);
    const player = room && rooms.findPlayerBySecret(room, playerId, secret);
    if (!room || !player) return ack?.({ ok: false, error: 'rejoin-failed' }); // gap #7
    player.connected = true;
    player.socketId = socket.id;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    persistAndBroadcast(io, room);
    sendSlipToDrawer(io, room); // gap #B: drawer gets their word back
    ack?.({ ok: true, roomCode: room.code, playerId: player.id });
  });

  socket.on('set-team', ({ targetPlayerId, team } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    const result = rooms.setTeam(ctx.room, ctx.player.id, targetPlayerId, team);
    if (result.ok) persistAndBroadcast(io, ctx.room);
    ack?.(result);
  });

  socket.on('set-config', (config = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    if (ctx.room.phase !== 'LOBBY' && ctx.room.phase !== 'WRITING') {
      return ack?.({ ok: false, error: 'config locked once play starts' }); // gap #R
    }
    // `!= null` not truthiness — 0 is a valid (if nonsensical) input and should still clamp, not be ignored
    if (config.wordsPerPlayer != null) ctx.room.config.wordsPerPlayer = Math.max(1, Math.min(20, +config.wordsPerPlayer));
    if (config.turnSeconds != null) ctx.room.config.turnSeconds = Math.max(10, Math.min(300, +config.turnSeconds));
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  socket.on('start-game', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    if (ctx.room.phase !== 'LOBBY') return ack?.({ ok: false, error: 'already started' });
    if (rooms.connectedCount(ctx.room) < 4) return ack?.({ ok: false, error: 'need at least 4 players' }); // gap #11
    game.startWriting(ctx.room);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  socket.on('submit-words', ({ words } = {}, ack) => {
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

  socket.on('force-start-round', (_data, ack) => {
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

  socket.on('start-turn', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    const result = game.startTurn(ctx.room, ctx.player.id, onTimeout);
    if (!result.ok) return ack?.(result);
    persistAndBroadcast(io, ctx.room);
    sendSlipToDrawer(io, ctx.room);
    ack?.({ ok: true });
  });

  socket.on('correct-guess', ({ slipId, turnId } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    const result = game.correctGuess(ctx.room, ctx.player.id, slipId, turnId);
    if (!result.ok) return ack?.(result);
    game.endTurnIfRoundOver(ctx.room, result.roundEnded);
    persistAndBroadcast(io, ctx.room);
    if (!result.roundEnded) sendSlipToDrawer(io, ctx.room);
    ack?.({ ok: true });
  });

  socket.on('pass-turn', ({ slipId, turnId } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    const result = game.passTurn(ctx.room, ctx.player.id, slipId, turnId);
    if (!result.ok) return ack?.(result);
    game.endTurnIfRoundOver(ctx.room, result.roundEnded);
    persistAndBroadcast(io, ctx.room);
    if (!result.roundEnded) sendSlipToDrawer(io, ctx.room);
    ack?.({ ok: true });
  });

  socket.on('skip-drawer', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    // gap #5/#V: host role always transfers to a connected player on disconnect
    // (rooms.transferHostIfNeeded), so "host only" never deadlocks a stuck drawer.
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    game.skipDrawer(ctx.room);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  socket.on('force-pass-team', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    if (!ROUND_PHASES.includes(ctx.room.phase)) return ack?.({ ok: false, error: 'no turn in progress' });
    game.forcePassTeam(ctx.room);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  socket.on('resume-turn', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    const result = game.resumeTurn(ctx.room, ctx.player.id, onTimeout);
    if (!result.ok) return ack?.(result);
    persistAndBroadcast(io, ctx.room);
    sendSlipToDrawer(io, ctx.room);
    ack?.({ ok: true });
  });

  socket.on('end-game', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    game.endGameNow(ctx.room);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  socket.on('leave-room', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: true });
    const wasDrawer = ROUND_PHASES.includes(ctx.room.phase) && ctx.room.round.drawerId === ctx.player.id;
    rooms.removePlayer(ctx.room, ctx.player.id); // voluntary leave: drop the slot, not just mark offline
    if (wasDrawer) game.skipDrawer(ctx.room); // they're gone for good, don't leave the turn paused forever
    persistAndBroadcast(io, ctx.room);
    socket.leave(ctx.room.code);
    delete socket.data.roomCode;
    delete socket.data.playerId;
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
