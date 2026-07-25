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
const { createBot } = await import('../server/bot.js');
const bots = await import('../server/bots.js');

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
  process.env.SELF_URL = url; // where host-spawned bots dial back in
});

after(() => {
  cleanup.forEach((fn) => fn());
  bots.removeAllBots(); // host-spawned bots aren't in `cleanup` — their sockets would hang the run
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

test('host can add bots from the UI and they show up flagged as bots', async () => {
  const host = await connect();
  let state = null;
  host.on('state', (s) => (state = s));
  await ack(host, 'create-room', { name: 'Host' });

  const added = await ack(host, 'add-bots', { count: 3 });
  assert.equal(added.ok, true);

  await until(
    () => state,
    (s) => s.players.length === 4,
  );
  const bots = state.players.filter((p) => p.isBot);
  assert.equal(bots.length, 3);
  assert.equal(state.players.find((p) => p.id === state.hostId).isBot, false); // the human isn't
  assert.deepEqual(
    bots.map((p) => p.name).sort(),
    ['Bot 1', 'Bot 2', 'Bot 3'], // distinct names even though the joins race
  );

  const removed = await ack(host, 'remove-bots');
  assert.equal(removed.removed, 3);
  await until(
    () => state,
    (s) => s.players.length === 1,
  );
});

test('add-bots is host-only, lobby-only, and capped', async () => {
  const host = await connect();
  let state = null;
  host.on('state', (s) => (state = s));
  const create = await ack(host, 'create-room', { name: 'Host' });

  const guest = await connect();
  await ack(guest, 'join-room', { roomCode: create.roomCode, name: 'Guest' });
  assert.equal((await ack(guest, 'add-bots', { count: 1 })).ok, false); // not the host

  // a silly count clamps to MAX_BOTS_PER_CALL rather than erroring...
  const clamped = await ack(host, 'add-bots', { count: 99 });
  assert.equal(clamped.ok, true);
  await until(
    () => state,
    (s) => s.players.length === 8, // host + guest + 6
  );
  // ...but the room-wide cap does refuse once there's no space left
  const overCap = await ack(host, 'add-bots', { count: 6 });
  assert.equal(overCap.ok, false);
  assert.match(overCap.error, /at most/);

  await ack(host, 'start-game');
  await until(
    () => state,
    (s) => s.phase === 'WRITING',
  );
  const afterStart = await ack(host, 'add-bots', { count: 1 });
  assert.equal(afterStart.ok, false); // lobby only — join-room won't take them now
  assert.match(afterStart.error, /lobby/);

  await ack(host, 'remove-bots');
});

test('the last human out takes the bots (and the room) with them', async () => {
  const host = await connect();
  let state = null;
  host.on('state', (s) => (state = s));
  const create = await ack(host, 'create-room', { name: 'Host' });
  await ack(host, 'add-bots', { count: 2 });
  await until(
    () => state,
    (s) => s.players.length === 3,
  );

  await ack(host, 'leave-room');
  // room is gone: a fresh socket can't join it any more
  const stray = await connect();
  const rejoin = await ack(stray, 'join-room', { roomCode: create.roomCode, name: 'Late' });
  assert.equal(rejoin.ok, false);
  assert.match(rejoin.error, /not found/);
});
