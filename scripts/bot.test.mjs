import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bots-'));
const { registerSocketHandlers } = await import('../server/events.js');
const { createBot } = await import('./bot.mjs');

let httpServer;
let io;
let url;
const cleanup = [];

before(async () => {
  httpServer = createServer();
  io = new Server(httpServer);
  io.on('connection', (socket) => registerSocketHandlers(io, socket));
  await new Promise((r) => httpServer.listen(0, r));
  url = `http://localhost:${httpServer.address().port}`;
});

after(() => {
  cleanup.forEach((fn) => fn());
  io.close();
  httpServer.close();
});

const ack = (c, event, payload) => new Promise((r) => c.emit(event, payload ?? {}, r));
function connect() {
  return new Promise((resolve) => {
    const c = ioClient(url, { reconnection: false, forceNew: true });
    cleanup.push(() => c.disconnect());
    c.once('connect', () => resolve(c));
  });
}
/** poll until predicate(state) is true or timeout */
function until(getState, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const s = getState();
      if (s && predicate(s)) return resolve(s);
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout waiting for state'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('bots auto-submit words and auto-play a turn end to end', async () => {
  // host (human control socket) creates the room + 3 bots join = 4 players
  const host = await connect();
  let state = null;
  host.on('state', (s) => (state = s));
  const create = await ack(host, 'create-room', { name: 'Host' });

  const bots = [1, 2, 3].map((i) =>
    createBot({ url, roomCode: create.roomCode, name: `Bot${i}`, startDelayMs: 0, guessDelayMs: 0, correctProbability: 1 }),
  );
  bots.forEach((b) => cleanup.push(() => b.socket.disconnect()));

  await until(
    () => state,
    (s) => s.players.length === 4,
  );

  // 1 word each, then start — bots should auto-submit and the game reaches ROUND1
  await ack(host, 'set-config', { wordsPerPlayer: 1 });
  await ack(host, 'start-game');
  await ack(host, 'submit-words', { words: ['host-word'] }); // host submits its own

  await until(
    () => state,
    (s) => s.phase === 'ROUND1',
    4000,
  );

  // every bot's word made it into the pool build (all submitted)
  const botIds = bots.map((b) => b.getId());
  assert.ok(
    botIds.every((id) => id),
    'all bots joined and have ids',
  );

  // hand the turn to team B (a bot) via host force-pass, then the bot should
  // auto-start and auto-guess, scoring for its team without any test input
  const teamBScoreBefore = state.teamScores.B;
  // ensure the current drawer is not already a bot-driven flow we can't observe:
  // force-pass reliably moves control to the other team's next drawer.
  await ack(host, 'force-pass-team');

  await until(
    () => state,
    (s) => s.teamScores.B > teamBScoreBefore,
    4000,
  );
  assert.ok(state.teamScores.B > teamBScoreBefore, 'a bot auto-played its turn and scored');
});
