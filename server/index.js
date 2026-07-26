import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';

import { rooms } from './rooms.js';
import * as game from './game.js';
import * as persist from './persist.js';
import { registerSocketHandlers } from './events.js';
import * as bots from './bots.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4321;
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

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

io.on('connection', (socket) => registerSocketHandlers(io, socket));

httpServer.listen(PORT, () => console.log(`poopsmoothie listening on :${PORT}`));
