import { randomUUID } from 'node:crypto';
import * as rooms from './rooms.js';
import * as game from './game.js';
import * as persist from './persist.js';
import * as suggestions from './suggestions.js';
import * as bots from './bots.js';
import { SettleBuffer, matchEnrolledSpeaker } from './arbiter.js';
import { LANGUAGES as VOICE_LANGUAGES, DEFAULT_MIN_ENERGY } from './stt.js';

const ROUND_PHASES = ['ROUND1', 'ROUND2', 'ROUND3'];
const INVALID_NAME = 'Invalid name — that prefix is reserved for bots';

// Overridable for the same reason as the settle window below — tuned per the
// plan's ~0.45-0.55 estimate; scripts/stt-bench.mjs is where you'd actually
// tune this for a real room full of enrolled voices.
const VOICE_EMBEDDING_THRESHOLD = Number(process.env.PS_VOICE_EMBEDDING_THRESHOLD) || 0.5;

/** Every currently-enrolled player in the room, as playerId -> Float32Array —
 *  the shape matchEnrolledSpeaker wants. Rebuilt fresh each delivery rather
 *  than cached: enrollment can happen at any time, including mid-round. */
function enrolledEmbeddingsFor(room) {
  const map = new Map();
  for (const p of room.players.values()) {
    if (p.voiceEmbedding) map.set(p.id, Float32Array.from(p.voiceEmbedding));
  }
  return map;
}

// One cross-device dedup buffer per room (not per socket — the whole point is
// collapsing utterances *across* different players' phones), created lazily
// on first use. Lives here rather than on the room object itself: it holds a
// live timer, same reasoning as round.timeoutHandle never being persisted.
const voiceBuffers = new Map(); // room code -> SettleBuffer

// Which sockets currently have a live mic, per room. Only used to answer "is
// anyone else even listening?" — with one mic in the room there is nothing to
// dedup against, so the settle window below is pure latency and gets skipped.
const liveMics = new Map(); // room code -> Set of socket ids

function addLiveMic(code, socketId) {
  let set = liveMics.get(code);
  if (!set) liveMics.set(code, (set = new Set()));
  set.add(socketId);
}

function removeLiveMic(code, socketId) {
  const set = liveMics.get(code);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) liveMics.delete(code);
}

function soloMic(code) {
  return (liveMics.get(code)?.size ?? 0) <= 1;
}

// Overridable so tests don't have to burn real wall-clock time per assertion.
// 250ms, down from an original 800ms: this is pure added latency for the
// common case (one speaker, nobody to dedup against). Two phones hearing the
// same shout fire their VADs within tens of ms of each other and are a couple
// of ms apart on a LAN, so the window only has to cover that jitter.
const VOICE_SETTLE_MS = Number(process.env.PS_VOICE_SETTLE_MS) || 250;

function voiceBufferFor(io, room) {
  let buf = voiceBuffers.get(room.code);
  if (!buf) {
    buf = new SettleBuffer((result) => deliverVoiceMessage(io, room.code, result), { windowMs: VOICE_SETTLE_MS });
    voiceBuffers.set(room.code, buf);
  }
  return buf;
}

function forgetVoiceBuffer(code) {
  voiceBuffers.get(code)?.flushNow();
  voiceBuffers.delete(code);
  liveMics.delete(code);
}

/** The settle window's flush callback — fires up to ~0.8s after the winning
 *  utterance was captured, so the room/round may have moved on since. Re-fetch
 *  everything fresh rather than trusting anything closed over at submit time,
 *  same principle as onFinal re-checking context() before it hands off here. */
function deliverVoiceMessage(io, roomCode, result) {
  const room = rooms.getRoom(roomCode);
  if (!room || !room.config.chatEnabled || !ROUND_PHASES.includes(room.phase)) return;

  // Device-prior attribution (whichever socket the winning capture arrived
  // on) is the default; a confident voice match overrides it — this is what
  // closes the "David's phone was in his pocket, only Jill's phone heard him"
  // gap that dedup alone can't (nobody's own device captured him at all).
  let playerId = result.playerId;
  const matched = matchEnrolledSpeaker(result.embedding, enrolledEmbeddingsFor(room), VOICE_EMBEDDING_THRESHOLD);
  if (matched) playerId = matched;

  const player = room.players.get(playerId);
  if (!player) return; // they left before this settled
  const message = {
    id: randomUUID(),
    playerId: player.id,
    name: player.name,
    team: player.team,
    wasDrawer: room.round.drawerId === player.id,
    via: 'voice',
    text: result.text,
    at: Date.now(),
  };
  room.round.chat.push(message);
  if (room.round.chat.length > 200) room.round.chat.shift();
  persist.saveRoom(room);
  io.to(room.code).emit('chat-message', message);
}

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
      // whether they've recorded a voiceprint (Phase 5) — never the print
      // itself, which is meaningless to a client and not something to hand out
      voiceEnrolled: !!p.voiceEmbedding,
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
      awaitingReady: !!room.round.awaitingReady,
      readyPlayerIds: room.round.ready ?? [],
      // What's been guessed *this round*, for everyone. Safe: these were all
      // said out loud as they were guessed. Scoped to the round on purpose —
      // the pile resets each round and remembering the earlier rounds' words
      // is the game, so we don't hand that back to people.
      guessedThisRound: room.round.guessed.map((slipId) => {
        const slip = room.pool[slipId];
        const hit = slip?.scoredBy?.find((e) => e.round === roundIdx + 1);
        return {
          id: slipId,
          text: slip?.text ?? '',
          playerName: hit?.playerName ?? null,
          team: hit?.team ?? null,
        };
      }),
      // audit trail for the live round; ?? for rooms persisted before this existed
      chat: room.round.chat ?? [],
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

/**
 * Is this socket actually there, right now?
 *
 * `player.connected` only turns false once socket.io's ping cycle gives up, and
 * that is deliberately generous (~85s — see index.js: idle phones must stay in
 * the game). Which leaves one bad window: picking up a second device and being
 * told your own name is "already playing". Rather than making the global
 * timeouts eager enough to cover it — which would evict every player whose
 * screen locked — ask the one socket in question and give it a moment to
 * answer.
 */
function isSocketAlive(io, socketId, ms = 1200) {
  const sock = socketId && io.sockets.sockets.get(socketId);
  if (!sock) return Promise.resolve(false);
  return new Promise((resolve) => {
    sock.timeout(ms).emit('are-you-there', (err) => resolve(!err));
  });
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

/** clampInt's fractional twin — the mic sensitivity floor is an RMS value in
 *  the 0..0.2 range, so truncating it to an integer would flatten every
 *  setting to 0. Same NaN-guard reasoning: `{}` or "abc" must land on the
 *  default rather than writing NaN into a comparison that then never matches. */
function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function registerSocketHandlers(io, socket, stt = null) {
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
      const fail = (err) => {
        console.error(`socket handler '${event}' threw:`, err);
        ack?.({ ok: false, error: 'server error' });
      };
      try {
        // a rejected promise from an async handler is just as fatal as a throw
        Promise.resolve(handler(data, ack)).catch(fail);
      } catch (err) {
        fail(err);
      }
    });
  }

  // Per-socket budget for room creation. Deliberately generous — a real host
  // making a room, misreading the code and making another shouldn't be told to
  // wait — but it stops a loop from minting hundreds.
  const CREATE_BURST = 5;
  const CREATE_WINDOW_MS = 30_000;
  let createTimes = [];
  function allowCreate() {
    const now = Date.now();
    createTimes = createTimes.filter((t) => now - t < CREATE_WINDOW_MS);
    if (createTimes.length >= CREATE_BURST) return false;
    createTimes.push(now);
    return true;
  }

  // Per-socket chat budget — same shape as allowCreate above. Generous enough
  // that nobody notices it while playing normally; it exists to stop a loop
  // from flooding the room (and disk — every message is persisted).
  const CHAT_BURST = 8;
  const CHAT_WINDOW_MS = 5_000;
  let chatTimes = [];
  function allowChat() {
    const now = Date.now();
    chatTimes = chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
    if (chatTimes.length >= CHAT_BURST) return false;
    chatTimes.push(now);
    return true;
  }

  // Open-mic frames arrive automatically (~4/s while a mic is on), not from a
  // user action, so this isn't a "burst of clicking" guard like the ones
  // above — it's a ceiling on how far a buggy or hostile client can stray from
  // the ~250ms cadence the real capture code uses, plus a hard per-frame size
  // cap so nobody can hand the server an arbitrarily large "frame".
  const AUDIO_FRAME_MAX_BYTES = 64 * 1024; // real frames are ~8KB (250ms @ 16kHz Int16)
  // A one-shot enrollment clip, not a stream — generous enough for an ~8s
  // recording (16kHz * 2 bytes/sample * 8s = 256KB) with room to spare.
  const ENROLL_MAX_BYTES = 320 * 1024;
  // Frames are 120ms now (was 250ms — shorter frames mean the tail of an
  // utterance reaches the VAD sooner), so ~16.7 arrive per window rather than
  // 8. Raised to keep roughly the same headroom over the real cadence; at the
  // old 20 a normal speaker would have been rate-limited mid-sentence.
  const AUDIO_FRAME_BURST = 40;
  const AUDIO_FRAME_WINDOW_MS = 2_000;
  let audioFrameTimes = [];
  function allowAudioFrame() {
    const now = Date.now();
    audioFrameTimes = audioFrameTimes.filter((t) => now - t < AUDIO_FRAME_WINDOW_MS);
    if (audioFrameTimes.length >= AUDIO_FRAME_BURST) return false;
    audioFrameTimes.push(now);
    return true;
  }

  // One STT session per socket, only while its mic is toggled on. Lives here
  // (not on ctx.room/player) same reasoning as the rate-limit buckets above —
  // it's per-connection, not per-player, so a reconnect starts clean rather
  // than inheriting a stale native handle from a socket that's already gone.
  let micSession = null;
  // Remembered separately from socket.data.roomCode: a disconnect can clear
  // the socket's room before this runs, and a mic left in `liveMics` would
  // permanently convince the room it has two listeners — reinstating the
  // settle-window latency for everyone with nothing to dedup against.
  let micRoomCode = null;
  function closeMicSession() {
    micSession?.close();
    micSession = null;
    if (micRoomCode) removeLiveMic(micRoomCode, socket.id);
    micRoomCode = null;
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
    if (rooms.isReservedName(name)) return ack?.({ ok: false, error: INVALID_NAME });
    if (rooms.roomCount() >= rooms.MAX_ROOMS) {
      return ack?.({ ok: false, error: 'too many rooms on this server right now' });
    }
    if (!allowCreate()) return ack?.({ ok: false, error: 'slow down — try again in a moment' });
    const room = rooms.newRoom();
    const player = rooms.addPlayer(room, name);
    player.socketId = socket.id;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    persistAndBroadcast(io, room);
    ack?.({ ok: true, roomCode: room.code, playerId: player.id, secret: player.secret });
  });

  on('join-room', async ({ roomCode, name, botToken, reclaim } = {}, ack) => {
    const room = rooms.getRoom(roomCode);
    if (!room) return ack?.({ ok: false, error: 'room not found' });
    // bots are named by the server; a person taking that prefix would make the
    // two indistinguishable on the one field used as identity. Bots themselves
    // arrive with a token, so they're exempt.
    if (!botToken && rooms.isReservedName(name)) return ack?.({ ok: false, error: INVALID_NAME });

    // The name is the identity, so an existing name means "I am that player".
    // What that entitles you to depends on whether they're still here.
    const existing = rooms.findByName(room, name);
    if (existing?.connected) {
      // Don't take socket.io's word for it — this is exactly the case where
      // someone has just picked up a second device and the old one may already
      // be dead, with the ping cycle yet to notice.
      if (await isSocketAlive(io, existing.socketId)) {
        return ack?.({ ok: false, nameTaken: true, error: `"${existing.name}" is already playing in this room` });
      }
      existing.connected = false;
      existing.socketId = null;
      handleDisconnectSideEffects(io, room, existing);
      persistAndBroadcast(io, room);
    }
    if (existing && !reclaim) {
      // don't silently assume an identity — let the client confirm it's them
      return ack?.({
        ok: false,
        canReclaim: true,
        name: existing.name,
        error: `"${existing.name}" is already in this room but offline`,
      });
    }
    // Checked ahead of canJoin so you can get back in even after the doors shut.
    const reclaimed = existing && rooms.reclaimSlot(room, name);
    if (reclaimed) {
      reclaimed.player.socketId = socket.id;
      socket.data.roomCode = room.code;
      socket.data.playerId = reclaimed.player.id;
      socket.join(room.code);
      // the seat was only on loan while they were gone
      if (reclaimed.wasHost) room.hostId = reclaimed.player.id;
      rooms.transferHostIfNeeded(room);
      game.recoverStrandedTurn(room);
      persistAndBroadcast(io, room);
      sendSlipToDrawer(io, room); // they may have been mid-turn when they dropped
      return ack?.({
        ok: true,
        roomCode: room.code,
        playerId: reclaimed.player.id,
        secret: reclaimed.secret,
        reclaimed: true,
      });
    }

    if (!rooms.canJoin(room)) return ack?.({ ok: false, error: 'game already started' });
    const player = rooms.addPlayer(room, name);
    // settle the bot flag here, before the roster broadcast below goes out
    if (bots.claimBotToken(room.code, botToken)) player.isBot = true;
    game.addLatePlayer(room, player); // mid-game joiner needs a slot in the rotation
    player.socketId = socket.id;
    // the seat stays with an absent human rather than going to a bot, so a real
    // arrival should be able to pick up one nobody is sitting in
    rooms.transferHostIfNeeded(room);
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
    if (result.ok) {
      // keep the turn rotation in step — without this a mid-game switch drops
      // the player out of the draw order permanently
      const moved = ctx.room.players.get(targetPlayerId);
      if (moved) game.movePlayerInTurnOrder(ctx.room, moved);
      persistAndBroadcast(io, ctx.room);
    }
    ack?.(result);
  });

  on('set-config', (config = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    // hotJoin, chatEnabled and voiceLanguage aren't game-balance settings —
    // they're doors. Let the host flip any of them any time, unlike
    // everything below which locks once play starts.
    let doorFieldsSet = 0;
    if (config.hotJoin != null) {
      ctx.room.config.hotJoin = !!config.hotJoin;
      doorFieldsSet++;
    }
    if (config.chatEnabled != null) {
      ctx.room.config.chatEnabled = !!config.chatEnabled;
      doorFieldsSet++;
    }
    if (config.voiceLanguage != null) {
      if (!VOICE_LANGUAGES.includes(config.voiceLanguage)) return ack?.({ ok: false, error: 'unknown voice language' });
      ctx.room.config.voiceLanguage = config.voiceLanguage;
      doorFieldsSet++;
    }
    if (doorFieldsSet > 0) {
      persistAndBroadcast(io, ctx.room);
      if (Object.keys(config).length === doorFieldsSet) return ack?.({ ok: true });
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

  // Rooms are listed openly and hot join is on by default, so a wrong-room
  // joiner or a nuisance needs a way out that isn't "everybody restart".
  on('kick-player', ({ playerId } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    if (playerId === ctx.player.id) return ack?.({ ok: false, error: "you can't kick yourself" });
    const target = ctx.room.players.get(playerId);
    if (!target) return ack?.({ ok: false, error: 'player not found' });

    const wasDrawer = ROUND_PHASES.includes(ctx.room.phase) && ctx.room.round.drawerId === target.id;
    const socketId = target.socketId;
    rooms.removePlayer(ctx.room, target.id);
    // don't strand the turn — or the ready gate — on someone who has gone
    if (wasDrawer) game.skipDrawer(ctx.room);
    game.refreshReadyGate(ctx.room);
    // tell them why before cutting them loose, so the client can show a reason
    // rather than silently bouncing to the landing screen
    if (socketId) {
      io.to(socketId).emit('room-closed', { reason: 'The host removed you from the room.' });
      io.in(socketId).socketsLeave(ctx.room.code);
      // a kicked bot has no UI to obey the message — cut its socket or it
      // lingers as a connected client belonging to no room
      if (target.isBot) io.in(socketId).disconnectSockets(true);
    }
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
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
    // the caller's own boxes — capped so a client can't hand us a million
    // strings to normalise on every keystroke
    const skip = Array.isArray(exclude) ? exclude.slice(0, 50) : [];
    const words = suggestions.suggestWords(ctx.room, n, skip);
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

  on('player-ready', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    const result = game.markReady(ctx.room, ctx.player.id);
    if (!result.ok) return ack?.(result);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  on('start-round-now', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    const result = game.startRoundNow(ctx.room);
    if (!result.ok) return ack?.(result);
    persistAndBroadcast(io, ctx.room);
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

  // Audit trail, not gameplay: text (and later voice) chat scoped to the live
  // round. Deliberately NOT persistAndBroadcast — a full state + lobbies
  // rebroadcast per chat line is a lot of weight for one line of text, and
  // nobody else's view of the game changes when a message is sent. The full
  // history still rides in publicState().round.chat for join/rejoin/refresh;
  // this event is just the fast path so new messages show up immediately.
  on('chat-send', ({ text } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!ctx.room.config.chatEnabled) return ack?.({ ok: false, error: 'chat is turned off for this room' });
    if (!ROUND_PHASES.includes(ctx.room.phase)) return ack?.({ ok: false, error: 'no round in progress' });
    const trimmed = String(text ?? '').trim().slice(0, 200);
    if (!trimmed) return ack?.({ ok: false, error: 'message is empty' });
    if (!allowChat()) return ack?.({ ok: false, error: 'slow down — try again in a moment' });

    // name/team/wasDrawer captured now, not looked up at render time — same
    // reasoning as pool[].scoredBy: a player who later leaves or a turn that
    // moves on must not rewrite what already happened in the transcript.
    const message = {
      id: randomUUID(),
      playerId: ctx.player.id,
      name: ctx.player.name,
      team: ctx.player.team,
      wasDrawer: ctx.room.round.drawerId === ctx.player.id,
      via: 'text',
      text: trimmed,
      at: Date.now(),
    };
    ctx.room.round.chat.push(message);
    if (ctx.room.round.chat.length > 200) ctx.room.round.chat.shift(); // cap, drop oldest
    persist.saveRoom(ctx.room);
    io.to(ctx.room.code).emit('chat-message', message);
    ack?.({ ok: true });
  });

  // Correcting your own line — mainly for voice: the ASR sometimes mishears
  // ("Too" landing as "True."), and there was previously no way to fix that
  // short of it sitting there wrong for the rest of the round. Scoped to only
  // the message's own author, same as everything else here trusting
  // ctx.player rather than anything the client asserts about identity.
  // `edited` is kept and shown in the log rather than silently rewriting
  // history — this transcript is a dispute-resolution tool, so a correction
  // has to be visibly a correction, not indistinguishable from what was
  // actually said at the time.
  on('chat-edit', ({ id, text } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!ctx.room.config.chatEnabled) return ack?.({ ok: false, error: 'chat is turned off for this room' });
    if (!ROUND_PHASES.includes(ctx.room.phase)) return ack?.({ ok: false, error: 'no round in progress' });
    const message = ctx.room.round.chat.find((m) => m.id === id);
    if (!message) return ack?.({ ok: false, error: 'message not found' });
    if (message.playerId !== ctx.player.id) return ack?.({ ok: false, error: 'you can only edit your own messages' });
    const trimmed = String(text ?? '').trim().slice(0, 200);
    if (!trimmed) return ack?.({ ok: false, error: 'message can\'t be empty — delete it instead' });
    if (!allowChat()) return ack?.({ ok: false, error: 'slow down — try again in a moment' });

    message.text = trimmed;
    message.edited = true;
    persist.saveRoom(ctx.room);
    io.to(ctx.room.code).emit('chat-message-updated', message);
    ack?.({ ok: true });
  });

  on('chat-delete', ({ id } = {}, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!ctx.room.config.chatEnabled) return ack?.({ ok: false, error: 'chat is turned off for this room' });
    if (!ROUND_PHASES.includes(ctx.room.phase)) return ack?.({ ok: false, error: 'no round in progress' });
    const index = ctx.room.round.chat.findIndex((m) => m.id === id);
    if (index === -1) return ack?.({ ok: false, error: 'message not found' });
    if (ctx.room.round.chat[index].playerId !== ctx.player.id) {
      return ack?.({ ok: false, error: 'you can only delete your own messages' });
    }
    if (!allowChat()) return ack?.({ ok: false, error: 'slow down — try again in a moment' });

    ctx.room.round.chat.splice(index, 1);
    persist.saveRoom(ctx.room);
    io.to(ctx.room.code).emit('chat-message-deleted', { id });
    ack?.({ ok: true });
  });

  // Open mic: same audit trail as chat-send, just fed by voice-to-text instead
  // of typing. `stt` is the whole server's shared engine (models + one
  // NAS-wide concurrency-capped decode queue, see stt.js) — null when the box
  // has no model files, exactly like a missing TLS cert disables https rather
  // than crashing the app.
  on('mic-on', (data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!ctx.room.config.chatEnabled) return ack?.({ ok: false, error: 'chat is turned off for this room' });
    if (!ROUND_PHASES.includes(ctx.room.phase)) return ack?.({ ok: false, error: 'no round in progress' });
    if (!stt) return ack?.({ ok: false, error: 'voice capture is not available on this server' });
    closeMicSession(); // re-enabling mid-session (e.g. after a drop) starts clean, not doubled up
    micRoomCode = ctx.room.code;
    addLiveMic(micRoomCode, socket.id);
    micSession = stt.createSession({
      // fixed for this session's lifetime — changing the room's language
      // mid-stream takes effect on the next mic-on, not retroactively
      language: ctx.room.config.voiceLanguage,
      // How loud a segment has to be before it's worth decoding. Comes from
      // the device (a phone across the table needs a different floor than one
      // in your hand) but is clamped here rather than trusted — same treatment
      // as every other client-supplied number, see clampInt above.
      minEnergy: clampFloat(data?.minEnergy, 0, 0.2, DEFAULT_MIN_ENERGY),
      // Nobody enrolled means nothing to match a voiceprint against, so
      // computing one per utterance is pure latency. Attribution falls back to
      // the device prior + dedup, which is the documented no-enrollment path.
      wantEmbedding: [...ctx.room.players.values()].some((p) => p.voiceEmbedding),
      // Not posted directly: handed to the room's cross-device dedup buffer
      // (server/arbiter.js), which holds it for a short settle window in case
      // another phone's mic caught the same shout, then delivers the best
      // capture via deliverVoiceMessage. Re-checked here (not just at
      // mic-on) because the segment may finish decoding well after the round
      // ended, the player left, or the host turned chat off mid-stream.
      onFinal: (text, meta) => {
        const c = context();
        if (!c || !c.room.config.chatEnabled || !ROUND_PHASES.includes(c.room.phase)) return;
        const buf = voiceBufferFor(io, c.room);
        buf.submit({ playerId: c.player.id, text: text.slice(0, 200), ...meta });
        // One live mic in the room: nothing can arrive to dedup against, so
        // waiting out the settle window would just be latency for its own sake.
        if (soloMic(c.room.code)) buf.flushNow();
      },
      onWarn: (err) => console.warn(`voice: session error for socket ${socket.id}:`, err.message),
    });
    ack?.({ ok: true });
  });

  on('mic-off', (_data, ack) => {
    closeMicSession();
    ack?.({ ok: true });
  });

  // A ~4s deliberate sample (not the continuous audio-frame stream — this is
  // a one-shot action, so a normal acked event is fine) computed into a
  // voiceprint and stored on the player. Persists with the room like anything
  // else on it; re-enrolling just overwrites. Allowed any time a room exists
  // (not phase-gated) — it's a profile action, not gameplay, and the point is
  // getting it done with zero friction, including before the round it'd help with.
  on('enroll-voice', (data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!ctx.room.config.chatEnabled) return ack?.({ ok: false, error: 'chat is turned off for this room' });
    if (!stt) return ack?.({ ok: false, error: 'voice capture is not available on this server' });
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length === 0 || buf.length > ENROLL_MAX_BYTES || buf.length % 2 !== 0) {
      return ack?.({ ok: false, error: 'invalid recording' });
    }
    try {
      const embedding = stt.computeEnrollment(new Int16Array(new Uint8Array(buf).buffer));
      ctx.player.voiceEmbedding = Array.from(embedding);
    } catch (err) {
      console.warn(`voice: enrollment failed for socket ${socket.id}:`, err.message);
      return ack?.({ ok: false, error: 'could not process recording' });
    }
    persistAndBroadcast(io, ctx.room); // voiceEnrolled is part of publicState's player list
    ack?.({ ok: true });
  });

  // Fire-and-forget: no ack (an ack round-trip on every ~500ms frame is pure
  // overhead the caller doesn't need — see useOpenMic.ts's volatile emit).
  // Binary payload, not the usual `{field: ...}` shape — the guarded `on()`
  // wrapper's payload-coercion only requires *an object*, which an
  // ArrayBuffer/Buffer already is, so it passes through untouched.
  on('audio-frame', (data) => {
    const ctx = context();
    if (!ctx || !micSession || !ctx.room.config.chatEnabled || !ROUND_PHASES.includes(ctx.room.phase)) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length === 0 || buf.length > AUDIO_FRAME_MAX_BYTES || buf.length % 2 !== 0) return;
    if (!allowAudioFrame()) return;
    // Buffer.from a socket.io binary payload can land anywhere inside Node's
    // shared pool — `buf.byteOffset` is not guaranteed even, and Int16Array
    // requires that. `new Uint8Array(buf)` copies into a fresh, zero-offset
    // ArrayBuffer (constructing a typed array from another one always
    // copies), so the Int16Array view over *that* is safe regardless of where
    // the original Buffer came from.
    micSession.pushFrame(new Int16Array(new Uint8Array(buf).buffer));
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
    suggestions.forgetRoom(code);
    forgetVoiceBuffer(code);
    persist.deleteRoom(code);
    broadcastLobbies(io); // it just stopped being joinable
    ack?.({ ok: true });
  });

  on('end-game', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    // there's nothing to end before the words exist — jumping LOBBY -> SCORES
    // lands everyone on a results screen with an empty pool
    if (ctx.room.phase === 'LOBBY') return ack?.({ ok: false, error: 'game has not started' });
    if (ctx.room.phase === 'SCORES') return ack?.({ ok: false, error: 'game already over' });
    game.endGameNow(ctx.room);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  on('play-again', (_data, ack) => {
    const ctx = context();
    if (!ctx) return ack?.({ ok: false, error: 'not in a room' });
    if (!rooms.isHost(ctx.room, ctx.player.id)) return ack?.({ ok: false, error: 'host only' });
    if (ctx.room.phase !== 'SCORES') return ack?.({ ok: false, error: 'the game is still going' });
    game.resetForRematch(ctx.room);
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
      suggestions.forgetRoom(ctx.room.code);
      forgetVoiceBuffer(ctx.room.code);
      persist.deleteRoom(ctx.room.code);
      broadcastLobbies(io);
      return ack?.({ ok: true });
    }
    if (wasDrawer) game.skipDrawer(ctx.room); // they're gone for good, don't leave the turn paused forever
    game.refreshReadyGate(ctx.room);
    persistAndBroadcast(io, ctx.room);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    closeMicSession();
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
  // don't wait forever on someone who just dropped
  game.refreshReadyGate(room);
  if (ROUND_PHASES.includes(room.phase) && room.round.drawerId === player.id) {
    game.pauseForDisconnectedDrawer(room);
  }
}
