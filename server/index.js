import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { Server } from 'socket.io';

import { rooms } from './rooms.js';
import * as game from './game.js';
import * as persist from './persist.js';
import { registerSocketHandlers } from './events.js';
import * as bots from './bots.js';
import { getOrCreateCert } from './tls.js';
import * as stt from './stt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4321;
const HTTPS_PORT = process.env.PS_HTTPS_PORT || 4322;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
const STT_MODEL_DIR = process.env.PS_STT_MODEL_DIR || path.join(__dirname, '..', 'models');

function positiveIntEnv(name, fallback) {
  const n = Math.trunc(Number(process.env[name]));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// gap #2: reload persisted rooms, then force any mid-turn room to a paused
// state — the in-memory setTimeout and wall-clock trust are both gone after a restart.
let orphanedBots = 0;
for (const room of persist.loadAllRooms()) {
  // bots died with the previous process; their players would otherwise linger
  // as permanently disconnected ghosts nobody can remove mid-game
  const dropped = bots.dropOrphanedBots(room);
  orphanedBots += dropped;
  if (game.ROUND_PHASES.includes(room.phase)) {
    game.pauseForBootRecovery(room);
  }
  if (room.players.size === 0) {
    // a room that was only ever bots has nobody left to come back to it
    rooms.delete(room.code);
    persist.deleteRoom(room.code);
  } else if (dropped || game.ROUND_PHASES.includes(room.phase)) {
    persist.saveRoom(room);
  }
}
if (orphanedBots) console.log(`cleared ${orphanedBots} bot(s) left over from the previous run`);
console.log(`loaded ${rooms.size} room(s) from disk`);

const app = express();
app.use(express.static(CLIENT_DIST));
app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));

const httpServer = createServer(app);
// gap #13: same-origin (this server serves the static client too), no CORS needed on the NAS.
// Deliberately *more* forgiving than the 25s/20s defaults, not less.
//
// Only the drawer is looking at their phone. Everyone else puts theirs down or
// locks it for the length of a turn, and a suspended mobile tab stops answering
// pings — so an eager timeout marks half the table as gone. `connected` is not
// cosmetic: it drives the turn rotation (a team with no "connected" player gets
// skipped, and both teams empty pauses the game outright), the between-round
// ready gate, and the auto-advance out of the writing phase. Dropping idle
// players out costs real gameplay; keeping a dead socket around for another
// minute costs nothing.
//
// The one place waiting genuinely hurts — someone picking up a second device and
// finding their own name in use — is handled precisely instead, by probing that
// single socket at that moment (see isSocketAlive in events.js). A stuck drawer
// has the host's "Skip stuck drawer" as an immediate manual escape.
const io = new Server(httpServer, { pingInterval: 25000, pingTimeout: 60000 });

// Voice capture (open mic -> VAD -> streaming ASR, see stt.js) needs a
// native addon plus ~100MB of ONNX models that only exist once the Docker
// image's `models` build stage has fetched them. Same "optional, never
// fatal" shape as the HTTPS cert below: a dev box or an image built without
// them just runs text-chat-only, logged once, nothing else affected.
let sttEngine = null;
try {
  const models = await stt.loadModels(STT_MODEL_DIR, { numThreads: positiveIntEnv('PS_STT_THREADS', 1) });
  sttEngine = stt.createEngine(models, { maxConcurrent: positiveIntEnv('PS_STT_MAX_CONCURRENT', 4) });
  console.log('voice capture: models loaded, open-mic transcription is available');
} catch (err) {
  console.warn(`voice capture unavailable, text chat still works (${err.message})`);
}

io.on('connection', (socket) => {
  socket.emit('server-info', { voiceAvailable: !!sttEngine, voiceLanguages: sttEngine?.languages ?? [] });
  registerSocketHandlers(io, socket, sttEngine);
});

httpServer.listen(PORT, () => console.log(`poopsmoothie listening on :${PORT}`));

// getUserMedia (mic capture, Phase 3+) requires a secure context, and this app
// otherwise only serves plain HTTP on the LAN. socket.io's engine can attach to
// more than one httpServer at once — same `io`, same rooms/game state, clients
// just arrive via whichever listener their browser used. A cert problem (e.g. a
// read-only volume) should cost mic support, never the whole server, so this is
// deliberately isolated from the http listener above.
try {
  const { key, cert } = await getOrCreateCert(DATA_DIR);
  const httpsServer = createHttpsServer({ key, cert }, app);
  io.attach(httpsServer);
  httpsServer.listen(HTTPS_PORT, () => console.log(`poopsmoothie (https, for mic access) listening on :${HTTPS_PORT}`));
} catch (err) {
  console.warn(`HTTPS listener not started, mic capture will be unavailable (${err.message})`);
}
