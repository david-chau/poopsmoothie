import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';

import { rooms } from './rooms.js';
import * as game from './game.js';
import * as persist from './persist.js';
import { registerSocketHandlers } from './events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4321;
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

// gap #2: reload persisted rooms, then force any mid-turn room to a paused
// state — the in-memory setTimeout and wall-clock trust are both gone after a restart.
for (const room of persist.loadAllRooms()) {
  if (game.ROUND_PHASES.includes(room.phase)) {
    game.pauseForBootRecovery(room);
    persist.saveRoom(room);
  }
}
console.log(`loaded ${rooms.size} room(s) from disk`);

const app = express();
app.use(express.static(CLIENT_DIST));
app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));

const httpServer = createServer(app);
// gap #13: same-origin (this server serves the static client too), no CORS needed on the NAS.
const io = new Server(httpServer);

io.on('connection', (socket) => registerSocketHandlers(io, socket));

httpServer.listen(PORT, () => console.log(`poopsmoothie listening on :${PORT}`));
