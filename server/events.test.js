import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

// isolate persistence to a temp dir before events.js (-> persist.js) loads
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-events-'));
const { registerSocketHandlers } = await import('./events.js');

let httpServer;
let io;
let url;
const clients = [];

before(async () => {
  httpServer = createServer();
  io = new Server(httpServer);
  io.on('connection', (socket) => registerSocketHandlers(io, socket));
  await new Promise((r) => httpServer.listen(0, r));
  url = `http://localhost:${httpServer.address().port}`;
});

after(() => {
  clients.forEach((c) => c.disconnect());
  io.close();
  httpServer.close();
});

function connect() {
  return new Promise((resolve) => {
    const c = ioClient(url, { reconnection: false, forceNew: true });
    clients.push(c);
    c.once('connect', () => resolve(c));
  });
}
const ack = (c, event, payload) => new Promise((r) => c.emit(event, payload ?? {}, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function latestStateOf(c) {
  let state = null;
  c.on('state', (s) => (state = s));
  return () => state;
}

/** create room + 3 joiners, all 4 submit 1 word, return to ROUND1 awaiting-start */
async function fullRoomToRound1() {
  const socks = await Promise.all([connect(), connect(), connect(), connect()]);
  const getState = latestStateOf(socks[0]);
  const create = await ack(socks[0], 'create-room', { name: 'Host' });
  const creds = [{ playerId: create.playerId, secret: create.secret }];
  for (let i = 1; i < 4; i++) {
    const r = await ack(socks[i], 'join-room', { roomCode: create.roomCode, name: `P${i}` });
    creds.push({ playerId: r.playerId, secret: r.secret });
  }
  await ack(socks[0], 'set-config', { wordsPerPlayer: 1, turnSeconds: 60 });
  await ack(socks[0], 'start-game');
  for (let i = 0; i < 4; i++) await ack(socks[i], 'submit-words', { words: [`w${i}`] });
  await wait(120);
  return { socks, creds, roomCode: create.roomCode, getState };
}

test('create-room returns creds and makes the creator host', async () => {
  const c = await connect();
  const getState = latestStateOf(c);
  const res = await ack(c, 'create-room', { name: 'Al' });
  assert.equal(res.ok, true);
  assert.match(res.roomCode, /^[A-Z2-9]{4}$/);
  assert.ok(res.playerId && res.secret);
  await wait(50);
  assert.equal(getState().hostId, res.playerId);
  assert.equal(getState().players.length, 1);
});

test('join-room: works in lobby, rejected after the game has started', async () => {
  const host = await connect();
  const create = await ack(host, 'create-room', { name: 'Host' });
  const joiners = await Promise.all([connect(), connect(), connect()]);
  for (const j of joiners) assert.equal((await ack(j, 'join-room', { roomCode: create.roomCode, name: 'x' })).ok, true);

  await ack(host, 'set-config', { wordsPerPlayer: 1, hotJoin: false }); // doors shut at start
  await ack(host, 'start-game');

  const late = await connect();
  const res = await ack(late, 'join-room', { roomCode: create.roomCode, name: 'Late' });
  assert.equal(res.ok, false); // WRITING phase + hot join off, no new joiners
});

test('set-config: host-only, clamps values, merges allowSkip without clobbering', async () => {
  const host = await connect();
  const create = await ack(host, 'create-room', { name: 'Host' });
  const guest = await connect();
  await ack(guest, 'join-room', { roomCode: create.roomCode, name: 'G' });
  const getState = latestStateOf(host);

  assert.equal((await ack(guest, 'set-config', { turnSeconds: 30 })).ok, false); // not host

  await ack(host, 'set-config', { wordsPerPlayer: 999, turnSeconds: 1 }); // out of range
  await wait(50);
  assert.equal(getState().config.wordsPerPlayer, 20); // clamped
  assert.equal(getState().config.turnSeconds, 10); // clamped

  await ack(host, 'set-config', { allowSkip: { ROUND3: true } }); // partial patch
  await wait(50);
  assert.deepEqual(getState().config.allowSkip, { ROUND1: true, ROUND2: true, ROUND3: true });
});

test('start-game: host-only and requires at least 4 players', async () => {
  const host = await connect();
  const create = await ack(host, 'create-room', { name: 'Host' });
  assert.equal((await ack(host, 'start-game')).ok, false); // only 1 player

  const joiners = await Promise.all([connect(), connect(), connect()]);
  for (const j of joiners) await ack(j, 'join-room', { roomCode: create.roomCode, name: 'x' });
  assert.equal((await ack(joiners[0], 'start-game')).ok, false); // not host
  assert.equal((await ack(host, 'start-game')).ok, true);
});

test('slip secrecy: room state carries no text; only the drawer gets the word', async () => {
  const { socks, getState } = await fullRoomToRound1();
  const state = getState();
  const drawerIdx = state.players.findIndex((p) => p.id === state.round.drawerId);

  let drawerSlip = null;
  socks[drawerIdx].on('slip-revealed', (p) => (drawerSlip = p));
  let leakedToOther = false;
  socks.forEach((s, i) => i !== drawerIdx && s.on('slip-revealed', () => (leakedToOther = true)));

  await ack(socks[drawerIdx], 'start-turn');
  await wait(120);

  assert.ok(drawerSlip?.slip?.text, 'drawer received the slip text');
  assert.equal(leakedToOther, false, 'no other player received slip-revealed');
  // the broadcast state must not contain the word anywhere
  assert.equal(JSON.stringify(getState()).includes(drawerSlip.slip.text), false);
  assert.equal(getState().pool, undefined); // pool withheld until SCORES
});

test('correct-guess: drawer-only, rejects stale turnId, scores the active team', async () => {
  const { socks, getState } = await fullRoomToRound1();
  const state = getState();
  const drawerIdx = state.players.findIndex((p) => p.id === state.round.drawerId);
  const otherIdx = drawerIdx === 0 ? 1 : 0;

  let slip = null;
  socks[drawerIdx].on('slip-revealed', (p) => (slip = p));
  await ack(socks[drawerIdx], 'start-turn');
  await wait(120);
  const turnId = getState().round.turnId;
  const activeTeam = getState().activeTeam;

  // a non-drawer cannot score
  assert.equal((await ack(socks[otherIdx], 'correct-guess', { slipId: slip.slip.id, turnId })).ok, false);
  // stale turnId rejected
  assert.equal((await ack(socks[drawerIdx], 'correct-guess', { slipId: slip.slip.id, turnId: 'stale' })).ok, false);
  // real guess scores
  assert.equal((await ack(socks[drawerIdx], 'correct-guess', { slipId: slip.slip.id, turnId })).ok, true);
  await wait(80);
  assert.equal(getState().teamScores[activeTeam], 1);
});

test('skip-drawer and force-pass-team are host-only', async () => {
  const { socks, getState } = await fullRoomToRound1();
  const hostId = getState().hostId;
  const nonHost = socks.find((_, i) => getState().players[i].id !== hostId);
  assert.equal((await ack(nonHost, 'skip-drawer')).ok, false);
  assert.equal((await ack(nonHost, 'force-pass-team')).ok, false);
  const host = socks[getState().players.findIndex((p) => p.id === hostId)];
  assert.equal((await ack(host, 'skip-drawer')).ok, true);
});

test('leave-room removes the slot; last leaver tears the room down', async () => {
  const a = await connect();
  const create = await ack(a, 'create-room', { name: 'A' });
  const b = await connect();
  const getState = latestStateOf(b); // attach before joining so we catch the broadcast
  await ack(b, 'join-room', { roomCode: create.roomCode, name: 'B' });
  await wait(50);
  assert.equal(getState().players.length, 2);

  await ack(a, 'leave-room');
  await wait(50);
  assert.equal(getState().players.length, 1); // A's slot gone

  await ack(b, 'leave-room');
  // room now empty -> destroyed; a fresh joiner should not find it
  const late = await connect();
  const res = await ack(late, 'join-room', { roomCode: create.roomCode, name: 'Late' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'room not found');
});

test('rejoin: valid creds restore the player, bad creds fail', async () => {
  const a = await connect();
  const create = await ack(a, 'create-room', { name: 'A' });
  const b = await connect();
  await ack(b, 'join-room', { roomCode: create.roomCode, name: 'B' });
  a.disconnect();
  await wait(80);

  const back = await connect();
  assert.equal((await ack(back, 'rejoin', { roomCode: create.roomCode, playerId: create.playerId, secret: 'wrong' })).ok, false);
  const ok = await ack(back, 'rejoin', { roomCode: create.roomCode, playerId: create.playerId, secret: create.secret });
  assert.equal(ok.ok, true);
});

test('end-room is host-only, tells everyone, and destroys the room', async () => {
  const host = await connect();
  const create = await ack(host, 'create-room', { name: 'Host' });
  const guest = await connect();
  await ack(guest, 'join-room', { roomCode: create.roomCode, name: 'Guest' });

  assert.equal((await ack(guest, 'end-room')).ok, false); // guest can't

  // the guest must hear about it, not just the host who pressed the button
  const closed = new Promise((r) => guest.once('room-closed', r));
  assert.equal((await ack(host, 'end-room')).ok, true);
  const payload = await closed;
  assert.match(payload.reason, /host ended/i);

  // room is really gone — a fresh socket can't join the code any more
  const stray = await connect();
  const rejoin = await ack(stray, 'join-room', { roomCode: create.roomCode, name: 'Late' });
  assert.equal(rejoin.ok, false);
  assert.match(rejoin.error, /not found/);
});

test('guessedSlips reveals a word only once it has actually been guessed', async () => {
  const host = await connect();
  let state = null;
  host.on('state', (s) => (state = s));
  const create = await ack(host, 'create-room', { name: 'Host' });
  const byPlayerId = new Map([[create.playerId, host]]);
  for (const name of ['B', 'C', 'D']) {
    const c = await connect();
    const res = await ack(c, 'join-room', { roomCode: create.roomCode, name });
    byPlayerId.set(res.playerId, c);
  }
  await ack(host, 'set-config', { wordsPerPlayer: 1 });
  await ack(host, 'start-game');
  for (const [i, c] of [...byPlayerId.values()].entries()) await ack(c, 'submit-words', { words: [`word-${i}`] });

  assert.equal(state.phase, 'ROUND1');
  assert.equal(state.guessedSlips.length, 0); // nothing guessed => nothing revealed
  assert.equal(state.pool, undefined); // full pool still withheld mid-game

  const drawer = byPlayerId.get(state.round.drawerId);
  const revealed = new Promise((r) => drawer.once('slip-revealed', r));
  await ack(drawer, 'start-turn');
  const { slip, turnId } = await revealed;
  assert.equal(state.guessedSlips.length, 0); // in the drawer's hand: still secret

  await ack(drawer, 'correct-guess', { slipId: slip.id, turnId });
  assert.deepEqual(
    state.guessedSlips.map((s) => s.text),
    [slip.text], // and only this one, not the three still in the bag
  );
  assert.equal(state.guessedSlips[0].scoredBy.length, 1);
  assert.equal(state.guessedSlips[0].authorId, undefined); // author still hidden until SCORES
});

test('lobbies list advertises open rooms and drops them once play starts', async () => {
  const host = await connect();
  let lobbies = [];
  host.on('lobbies', (l) => (lobbies = l));
  const create = await ack(host, 'create-room', { name: 'Host' });

  const mine = () => lobbies.find((l) => l.code === create.roomCode);
  assert.equal(mine().playerCount, 1);
  assert.equal(mine().hostName, 'Host');

  // a watcher who never joined still sees the list — that's the landing screen
  const watcher = await connect();
  const initial = await ack(watcher, 'list-lobbies');
  assert.ok(initial.lobbies.some((l) => l.code === create.roomCode));

  const others = [];
  for (const name of ['B', 'C', 'D']) {
    const c = await connect();
    await ack(c, 'join-room', { roomCode: create.roomCode, name });
    others.push(c);
  }
  assert.equal(mine().playerCount, 4); // count tracks joins

  await ack(host, 'set-config', { hotJoin: false });
  await ack(host, 'start-game');
  assert.equal(mine(), undefined); // no longer joinable, so no longer advertised
});

test('hot join lets a latecomer into a running game; off shuts the door', async () => {
  const { socks, roomCode, getState } = await fullRoomToRound1();
  assert.equal(getState().config.hotJoin, true); // on by default
  assert.equal(getState().phase, 'ROUND1');

  const late = await connect();
  const joined = await ack(late, 'join-room', { roomCode, name: 'Late' });
  assert.equal(joined.ok, true);
  await wait(80);
  assert.equal(getState().players.length, 5);

  // host can shut the door mid-game (this setting isn't locked like the rest)
  assert.equal((await ack(socks[0], 'set-config', { hotJoin: false })).ok, true);
  await wait(80);
  assert.equal(getState().config.hotJoin, false);

  const tooLate = await connect();
  const refused = await ack(tooLate, 'join-room', { roomCode, name: 'TooLate' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /already started/);
});

test('lobbies list keeps hot-join games but hides closed ones', async () => {
  const { socks, roomCode } = await fullRoomToRound1();
  let lobbies = [];
  const watcher = await connect();
  watcher.on('lobbies', (l) => (lobbies = l));
  const initial = await ack(watcher, 'list-lobbies');
  const mine = initial.lobbies.find((l) => l.code === roomCode);
  assert.equal(mine.phase, 'ROUND1'); // still advertised, and says what it's doing

  await ack(socks[0], 'set-config', { hotJoin: false });
  await wait(80);
  assert.equal(
    lobbies.find((l) => l.code === roomCode),
    undefined,
  );
});
