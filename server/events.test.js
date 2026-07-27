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
const bots = await import('./bots.js');

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
  process.env.SELF_URL = url; // host-spawned bots dial back in here, not :4321
});

after(() => {
  clients.forEach((c) => c.disconnect());
  bots.removeAllBots(); // host-spawned bots aren't in `clients`; their sockets hang the run
  io.close();
  httpServer.close();
});

/** A client that behaves like the real one, which answers the server's liveness
 *  probe (see socket.ts). `alive: false` simulates a locked phone or dead wifi:
 *  the socket is still open server-side but nothing is running to reply. */
function connect({ alive = true } = {}) {
  return new Promise((resolve) => {
    const c = ioClient(url, { reconnection: false, forceNew: true });
    if (alive) c.on('are-you-there', (cb) => cb?.());
    clients.push(c);
    c.once('connect', () => resolve(c));
  });
}
const ack = (c, event, payload) => new Promise((r) => c.emit(event, payload ?? {}, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** poll until predicate() is true, or fail loudly rather than hanging */
async function until(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await wait(25);
  }
  throw new Error('timed out waiting for a condition');
}

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
  // chatEnabled defaults off (a beta feature, opt-in per room) — this test
  // helper is shared by chat tests too, so turn it on here rather than in
  // every individual test
  await ack(socks[0], 'set-config', { wordsPerPlayer: 1, turnSeconds: 60, chatEnabled: true });
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
  // distinct names: the name is the identity, so three "x"s would be one player
  for (const [i, j] of joiners.entries()) {
    assert.equal((await ack(j, 'join-room', { roomCode: create.roomCode, name: `J${i}` })).ok, true);
  }

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
  for (const [i, j] of joiners.entries()) await ack(j, 'join-room', { roomCode: create.roomCode, name: `J${i}` });
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

// Regression: a hostile or buggy client controls the payload shape. Any throw
// inside a socket handler becomes an uncaughtException, and with no
// process-level handler that kills the server for everyone in every room.
test('malformed payloads are rejected, never fatal', async () => {
  const crashes = [];
  const onCrash = (e) => crashes.push(e.message);
  process.on('uncaughtException', onCrash);

  const c = await connect();
  const hostile = [
    ['join-room', { roomCode: {}, name: 'x' }], // no .toUpperCase on an object
    ['join-room', { roomCode: [], name: 'x' }],
    ['join-room', { roomCode: 42, name: 'x' }],
    ['rejoin', { roomCode: {}, playerId: 'a', secret: 'b' }],
    ['create-room', { name: {} }], // no .slice on an object
    ['create-room', null], // `= {}` defaults only fire for undefined
    ['join-room', null],
    ['join-room', 'not-an-object'],
    ['set-config', [1, 2, 3]],
  ];
  for (const [event, payload] of hostile) {
    const res = await ack(c, event, payload);
    assert.ok(res && typeof res === 'object', `${event} must still answer its ack`);
  }

  await wait(50);
  process.off('uncaughtException', onCrash);
  assert.deepEqual(crashes, [], 'no handler may throw out of the socket layer');
});

test('a garbage config value is ignored, not written as NaN', async () => {
  const c = await connect();
  const getState = latestStateOf(c);
  await ack(c, 'create-room', { name: 'H' });
  await wait(50);
  const before = getState().config;

  await ack(c, 'set-config', { wordsPerPlayer: {}, turnSeconds: 'abc' });
  await wait(50);
  // NaN here would make submit-words reject every submission, permanently
  assert.equal(getState().config.wordsPerPlayer, before.wordsPerPlayer);
  assert.equal(getState().config.turnSeconds, before.turnSeconds);

  await ack(c, 'set-config', { wordsPerPlayer: 999 }); // real numbers still clamp
  await wait(50);
  assert.equal(getState().config.wordsPerPlayer, 20);
});

test('a blank or whitespace-only name falls back instead of rendering empty', async () => {
  const c = await connect();
  const getState = latestStateOf(c);
  await ack(c, 'create-room', { name: '   ' });
  await wait(50);
  assert.equal(getState().players[0].name, 'Player');
});

test('room creation is capped per socket so one client cannot flood the disk', async () => {
  const c = await connect();
  const results = [];
  for (let i = 0; i < 10; i++) results.push(await ack(c, 'create-room', { name: 'spam' }));
  const made = results.filter((r) => r.ok).length;
  assert.ok(made > 0 && made < 10, `expected a burst then a stop, got ${made}/10`);
  assert.match(results.at(-1).error, /slow down/);
});

test('suggest-words caps a large exclude list instead of chewing on it', async () => {
  const c = await connect();
  const create = await ack(c, 'create-room', { name: 'H' });
  for (const n of ['B', 'C', 'D']) {
    const j = await connect();
    await ack(j, 'join-room', { roomCode: create.roomCode, name: n });
  }
  await ack(c, 'set-config', { wordsPerPlayer: 1 });
  await ack(c, 'start-game');

  // stays under socket.io's 1MB maxHttpBufferSize, which already rejects
  // anything truly enormous before it reaches us — this covers the rest
  const started = Date.now();
  const res = await ack(c, 'suggest-words', { count: 3, exclude: new Array(20000).fill('filler') });
  assert.equal(res.ok, true);
  assert.equal(res.words.length, 3);
  assert.ok(Date.now() - started < 1000, 'must not scale with the caller-supplied array');
});

test('kick-player: host only, cannot self-kick, and the target is told why', async () => {
  const host = await connect();
  const getState = latestStateOf(host);
  const create = await ack(host, 'create-room', { name: 'Host' });
  const guest = await connect();
  const joined = await ack(guest, 'join-room', { roomCode: create.roomCode, name: 'Pest' });
  await wait(50);

  assert.equal((await ack(guest, 'kick-player', { playerId: create.playerId })).ok, false); // not host
  assert.equal((await ack(host, 'kick-player', { playerId: create.playerId })).ok, false); // no self-kick
  assert.equal((await ack(host, 'kick-player', { playerId: 'ghost' })).ok, false);

  const told = new Promise((r) => guest.once('room-closed', r));
  assert.equal((await ack(host, 'kick-player', { playerId: joined.playerId })).ok, true);
  assert.match((await told).reason, /removed you/i);

  await wait(50);
  assert.equal(getState().players.length, 1); // slot gone, not just marked offline
});

test('kicking the current drawer passes the turn on instead of stranding it', async () => {
  const { socks, getState } = await fullRoomToRound1();
  const hostId = getState().hostId;
  const host = socks[getState().players.findIndex((p) => p.id === hostId)];
  // the host opens round 1 (team A's first player), so hand the turn over
  // before kicking — you can't kick yourself
  await ack(host, 'force-pass-team');
  await wait(50);
  const drawerId = getState().round.drawerId;
  assert.notEqual(drawerId, hostId, 'precondition: host is no longer the drawer');

  assert.equal((await ack(host, 'kick-player', { playerId: drawerId })).ok, true);
  await wait(80);
  assert.notEqual(getState().round.drawerId, drawerId);
  assert.ok(getState().round.drawerId, 'a new drawer took over');
  assert.equal(getState().round.paused, false);
});

test('a player who lost their credentials reclaims their slot by name', async () => {
  const { socks, roomCode, getState } = await fullRoomToRound1();
  const before = getState();
  const victim = before.players.find((p) => p.id !== before.hostId);
  const victimSock = socks[before.players.findIndex((p) => p.id === victim.id)];

  victimSock.disconnect(); // phone died; localStorage gone with it
  await wait(80);
  assert.equal(getState().players.find((p) => p.id === victim.id).connected, false);

  // they come back and just type their name — no secret to offer. First reply
  // is the "is this you?" question; confirming completes the reclaim.
  const returning = await connect();
  const asked = await ack(returning, 'join-room', { roomCode, name: victim.name });
  assert.equal(asked.canReclaim, true);
  const res = await ack(returning, 'join-room', { roomCode, name: victim.name, reclaim: true });
  assert.equal(res.ok, true);
  assert.equal(res.reclaimed, true);
  assert.equal(res.playerId, victim.id, 'same slot, not a new player');
  assert.ok(res.secret, 'issued fresh credentials');

  await wait(80);
  const after = getState();
  assert.equal(after.players.length, before.players.length, 'no duplicate player');
  assert.equal(after.players.find((p) => p.id === victim.id).team, victim.team);
  assert.equal(after.players.find((p) => p.id === victim.id).connected, true);
});

test('a name in use by someone still connected is refused', async () => {
  const host = await connect();
  const create = await ack(host, 'create-room', { name: 'Dave' });
  await wait(50);

  const impostor = await connect();
  const res = await ack(impostor, 'join-room', { roomCode: create.roomCode, name: 'Dave' });
  assert.equal(res.ok, false, 'never take a seat from someone actively playing');
  assert.equal(res.nameTaken, true);
  assert.match(res.error, /already playing/i);

  // even asking to reclaim outright doesn't get you in
  const forced = await ack(impostor, 'join-room', { roomCode: create.roomCode, name: 'Dave', reclaim: true });
  assert.equal(forced.ok, false);
  assert.equal(forced.nameTaken, true);
});

test('an offline name is offered back, but only once you confirm', async () => {
  const dave = await connect();
  const create = await ack(dave, 'create-room', { name: 'Dave' });
  const bob = await connect();
  const state = latestStateOf(bob);
  await ack(bob, 'join-room', { roomCode: create.roomCode, name: 'Bob' });
  await wait(50);

  dave.disconnect();
  await wait(80);

  // first attempt is a question, not a join
  const newDevice = await connect();
  const asked = await ack(newDevice, 'join-room', { roomCode: create.roomCode, name: 'Dave' });
  assert.equal(asked.ok, false);
  assert.equal(asked.canReclaim, true);
  assert.equal(asked.name, 'Dave');
  await wait(50);
  assert.equal(state().players.find((p) => p.name === 'Dave').connected, false, 'nothing happened yet');

  // confirmed: same slot, fresh credentials, no second Dave
  const joined = await ack(newDevice, 'join-room', { roomCode: create.roomCode, name: 'Dave', reclaim: true });
  assert.equal(joined.ok, true);
  assert.equal(joined.reclaimed, true);
  assert.equal(joined.playerId, create.playerId);
  assert.notEqual(joined.secret, create.secret);
  await wait(80);
  assert.equal(state().players.length, 2, 'never two Daves');
});

test('a returning host takes the seat back, since it was only on loan', async () => {
  const dave = await connect();
  const create = await ack(dave, 'create-room', { name: 'Dave' });
  const bob = await connect();
  const state = latestStateOf(bob);
  await ack(bob, 'join-room', { roomCode: create.roomCode, name: 'Bob' });
  await wait(50);
  const bobId = state().players.find((p) => p.name === 'Bob').id;

  dave.disconnect();
  await wait(80);
  assert.equal(state().hostId, bobId, 'host handed on so the room is not stuck');

  const daveAgain = await connect();
  await ack(daveAgain, 'join-room', { roomCode: create.roomCode, name: 'Dave', reclaim: true });
  await wait(80);
  assert.equal(state().hostId, create.playerId, 'Dave is host again');
  assert.equal(state().players.length, 2);
});

test('someone who was never host does not become one by reconnecting', async () => {
  const dave = await connect();
  const create = await ack(dave, 'create-room', { name: 'Dave' });
  const bob = await connect();
  const state = latestStateOf(dave);
  await ack(bob, 'join-room', { roomCode: create.roomCode, name: 'Bob' });
  await wait(50);

  bob.disconnect(); // a non-host drops; host never moves
  await wait(80);
  assert.equal(state().hostId, create.playerId);

  const bobAgain = await connect();
  await ack(bobAgain, 'join-room', { roomCode: create.roomCode, name: 'Bob', reclaim: true });
  await wait(80);
  assert.equal(state().hostId, create.playerId, 'Dave still hosts');
});

test('the bot name prefix is reserved and refused to people', async () => {
  const host = await connect();
  const getState = latestStateOf(host);
  const create = await ack(host, 'create-room', { name: 'Host' });
  await ack(host, 'add-bots', { count: 1 });
  await until(() => getState()?.players.length === 2);

  const botName = getState().players.find((p) => p.isBot).name;
  const human = await connect();

  // exactly a bot's name, and merely wearing the prefix, are both refused
  for (const attempt of [botName, '[🤖] Sneaky', '  [🤖]  hello']) {
    const res = await ack(human, 'join-room', { roomCode: create.roomCode, name: attempt });
    assert.equal(res.ok, false, `"${attempt}" should be refused`);
    assert.match(res.error, /Invalid name/i);
  }
  assert.equal((await ack(human, 'create-room', { name: '[🤖] Sneaky' })).ok, false);

  // an ordinary name is unaffected
  const fine = await ack(human, 'join-room', { roomCode: create.roomCode, name: 'Robot Lover' });
  assert.equal(fine.ok, true);
  await wait(80);
  const names = getState().players.map((p) => p.name);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, 'names stay unique');
  await ack(host, 'remove-bots');
});

// Every host-only event, checked from a non-host socket in one place. These
// guards were previously untested: the underlying game logic is covered in
// game.test.js, but deleting an isHost line broke nothing visible.
test('every host-only event refuses a non-host', async () => {
  const { socks, getState } = await fullRoomToRound1();
  const state = getState();
  const nonHost = socks[state.players.findIndex((p) => p.id !== state.hostId)];

  const hostOnly = [
    ['host-pause', {}],
    ['revert-last-guess', {}],
    ['set-drawer', { playerId: state.hostId }],
    ['set-slip-scorer', { slipId: 'x', round: 1, playerId: null }],
    ['end-game', {}],
    ['force-start-round', {}],
    ['skip-drawer', {}],
    ['force-pass-team', {}],
    ['end-room', {}],
    ['kick-player', { playerId: state.hostId }],
    ['add-bots', { count: 1 }],
    ['remove-bots', {}],
    ['set-config', { turnSeconds: 30 }],
    ['start-game', {}],
  ];
  for (const [event, payload] of hostOnly) {
    const res = await ack(nonHost, event, payload);
    assert.equal(res.ok, false, `${event} must reject a non-host`);
    assert.match(res.error, /host only/, `${event} rejected for the wrong reason: ${res.error}`);
  }

  // the room is untouched by all that
  assert.equal(getState().phase, 'ROUND1');
  assert.equal(getState().players.length, 4);
});

test('end-game cannot be used before the game starts or twice', async () => {
  const host = await connect();
  const getState = latestStateOf(host);
  const create = await ack(host, 'create-room', { name: 'Host' });
  for (const n of ['B', 'C', 'D']) {
    const c = await connect();
    await ack(c, 'join-room', { roomCode: create.roomCode, name: n });
  }
  await wait(50);

  // LOBBY -> SCORES would strand everyone on a results screen with no words
  const early = await ack(host, 'end-game');
  assert.equal(early.ok, false);
  assert.match(early.error, /not started/);
  assert.equal(getState().phase, 'LOBBY');

  await ack(host, 'set-config', { wordsPerPlayer: 1 });
  await ack(host, 'start-game');
  await wait(50);
  assert.equal((await ack(host, 'end-game')).ok, true); // from WRITING is fine
  await wait(50);
  assert.equal(getState().phase, 'SCORES');
  assert.equal((await ack(host, 'end-game')).ok, false); // already over
});

test('a mid-game team switch keeps the player drawing (socket path)', async () => {
  const { socks, getState } = await fullRoomToRound1();
  const before = getState();
  const mover = before.players.find((p) => p.team === 'B');
  const moverSock = socks[before.players.findIndex((p) => p.id === mover.id)];

  assert.equal((await ack(moverSock, 'set-team', { targetPlayerId: mover.id, team: 'A' })).ok, true);
  await wait(80);
  assert.equal(getState().players.find((p) => p.id === mover.id).team, 'A');

  // rotate team A until everyone on it has had a turn; the mover must appear
  const host = socks[before.players.findIndex((p) => p.id === before.hostId)];
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    await ack(host, 'skip-drawer');
    await wait(30);
    seen.add(getState().round.drawerId);
  }
  assert.ok(seen.has(mover.id), 'the switched player still gets turns');
});

/** Bots play their own turns; the human host just steps aside when it lands on
 *  them, which is enough to let a round play itself out in a test. */
async function letBotsPlay(host, getState, hostId, done, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (done()) return;
    const s = getState();
    if (s && !s.round.awaitingReady && s.round.drawerId === hostId && !s.round.turnEndsAt) {
      await ack(host, 'skip-drawer');
    }
    await wait(50);
  }
  throw new Error('timed out letting the bots play');
}

test('the ready gate works over the wire, and bots ready themselves', async () => {
  const host = await connect();
  const getState = latestStateOf(host);
  const create = await ack(host, 'create-room', { name: 'Host' });
  await ack(host, 'set-config', { wordsPerPlayer: 1 });
  await ack(host, 'add-bots', { count: 3 });
  await until(() => getState()?.players.length === 4);

  await ack(host, 'start-game');
  await ack(host, 'submit-words', { words: ['host-word'] });
  await until(() => getState()?.phase === 'ROUND1', 8000);

  // bots finish round 1 on their own, then hit the gate
  await letBotsPlay(host, getState, create.playerId, () => getState()?.round.awaitingReady === true);

  assert.equal(getState().phase, 'ROUND2');
  assert.equal(getState().round.awaitingReady, true, 'round 2 is held shut');
  // the gate flips shut before anyone has answered it, so wait for the bots
  // rather than sampling the instant it closes
  await until(() => getState().round.readyPlayerIds.length === 3, 5000);
  assert.deepEqual(
    getState().round.readyPlayerIds.slice().sort(),
    getState()
      .players.filter((p) => p.isBot)
      .map((p) => p.id)
      .sort(),
    'the bots readied themselves, the human has not',
  );

  await ack(host, 'player-ready');
  await until(() => getState()?.round.awaitingReady === false, 3000);
});

test('start-round-now is host-only and opens the gate for everyone', async () => {
  const host = await connect();
  const getState = latestStateOf(host);
  const create = await ack(host, 'create-room', { name: 'Host' });
  const guest = await connect();
  await ack(guest, 'join-room', { roomCode: create.roomCode, name: 'Guest' });
  await ack(host, 'set-config', { wordsPerPlayer: 1 });
  await ack(host, 'add-bots', { count: 2 });
  await until(() => getState()?.players.length === 4);
  await ack(host, 'start-game');
  await ack(host, 'submit-words', { words: ['a'] });
  await ack(guest, 'submit-words', { words: ['b'] });
  await until(() => getState()?.phase === 'ROUND1', 8000);

  // two humans here, so step both aside and let the bots run the round
  const guestId = getState().players.find((p) => p.name === 'Guest').id;
  const started = Date.now();
  while (getState()?.round.awaitingReady !== true && Date.now() - started < 20000) {
    const s = getState();
    if (s && !s.round.awaitingReady && !s.round.turnEndsAt && (s.round.drawerId === create.playerId || s.round.drawerId === guestId)) {
      await ack(host, 'skip-drawer');
    }
    await wait(50);
  }
  assert.equal(getState().round.awaitingReady, true);

  assert.equal((await ack(guest, 'start-round-now')).ok, false); // not the host
  assert.equal(getState().round.awaitingReady, true);
  assert.equal((await ack(host, 'start-round-now')).ok, true);
  await until(() => getState()?.round.awaitingReady === false, 3000);
});

test('everyone can see what was guessed this round, and only that', async () => {
  const { socks, getState } = await fullRoomToRound1();
  const state = getState();
  const drawerIdx = state.players.findIndex((p) => p.id === state.round.drawerId);
  const watcher = latestStateOf(socks[drawerIdx === 0 ? 1 : 0]); // a non-drawer

  let latest = null;
  socks[drawerIdx].on('slip-revealed', (p) => (latest = p));
  await ack(socks[drawerIdx], 'start-turn');
  await wait(120);
  // snapshot before guessing: the server sends the *next* slip straight after,
  // which would otherwise overwrite what we are asserting about
  const guessedText = latest.slip.text;
  await ack(socks[drawerIdx], 'correct-guess', { slipId: latest.slip.id, turnId: getState().round.turnId });
  await wait(120);

  const seen = watcher().round.guessedThisRound;
  assert.equal(seen.length, 1, 'a non-drawer sees the guessed word');
  assert.equal(seen[0].text, guessedText);
  assert.ok(seen[0].playerName, 'and who got it');
  // the words still in the bag stay secret
  assert.ok(watcher().round.remainingCount > 0);
  assert.equal(JSON.stringify(watcher().round).split('"text"').length - 1, 1);
});

test('play-again is host-only and only once the game is over', async () => {
  const { socks, getState } = await fullRoomToRound1();
  const state = getState();
  const host = socks[state.players.findIndex((p) => p.id === state.hostId)];
  const guest = socks[state.players.findIndex((p) => p.id !== state.hostId)];

  const tooEarly = await ack(host, 'play-again');
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.error, /still going/);

  await ack(host, 'end-game');
  await until(() => getState()?.phase === 'SCORES');

  assert.equal((await ack(guest, 'play-again')).ok, false); // not the host
  assert.equal((await ack(host, 'play-again')).ok, true);

  await until(() => getState()?.phase === 'LOBBY');
  assert.equal(getState().players.length, 4, 'nobody had to rejoin');
  assert.deepEqual(getState().teamScores, { A: 0, B: 0 });
  assert.deepEqual(getState().roundScores, []);
});

test('a name is only defended by a socket that actually answers', async () => {
  // A live tab answers the probe and keeps its name...
  const dave = await connect();
  const create = await ack(dave, 'create-room', { name: 'Dave' });
  await wait(50);

  const other = await connect();
  const refused = await ack(other, 'join-room', { roomCode: create.roomCode, name: 'Dave' });
  assert.equal(refused.ok, false);
  assert.equal(refused.nameTaken, true);

  // ...but a socket the server still believes in, which no longer answers
  // (locked phone, dead wifi — TCP not yet torn down), does not.
  dave.off('are-you-there');
  const asked = await ack(other, 'join-room', { roomCode: create.roomCode, name: 'Dave' });
  assert.equal(asked.ok, false);
  assert.equal(asked.canReclaim, true, 'offered back rather than blocked for ~15s');

  const joined = await ack(other, 'join-room', { roomCode: create.roomCode, name: 'Dave', reclaim: true });
  assert.equal(joined.ok, true);
  assert.equal(joined.playerId, create.playerId);
});

test('an idle phone stays in the game — only the name probe cares about liveness', async () => {
  // A locked screen suspends the tab, so it answers nothing. That must not
  // remove someone from the room: `connected` drives the turn rotation, the
  // ready gate and the writing auto-advance, so dropping idle players skips
  // their turns and can stall the round.
  const host = await connect();
  const getState = latestStateOf(host);
  const create = await ack(host, 'create-room', { name: 'Host' });
  const napping = await connect({ alive: false }); // phone face-down on the table
  await ack(napping, 'join-room', { roomCode: create.roomCode, name: 'Sleepy' });
  await wait(50);

  // someone else's join triggers a probe of *their* name, not of everyone
  const third = await connect();
  await ack(third, 'join-room', { roomCode: create.roomCode, name: 'Third' });
  await wait(80);

  const sleepy = getState().players.find((p) => p.name === 'Sleepy');
  assert.equal(sleepy.connected, true, 'an idle player is still in the room');
  assert.equal(getState().players.length, 3);
});

test('refreshing in a solo game with bots gets the host controls back', async () => {
  const host = await connect();
  const getState = latestStateOf(host);
  const create = await ack(host, 'create-room', { name: 'David' });
  await ack(host, 'add-bots', { count: 3 });
  await until(() => getState()?.players.length === 4);
  assert.equal(getState().hostId, create.playerId);

  // a browser refresh: the socket drops, then comes back with the stored secret
  host.disconnect();
  await wait(120);

  const refreshed = await connect();
  const back = latestStateOf(refreshed);
  const res = await ack(refreshed, 'rejoin', {
    roomCode: create.roomCode,
    playerId: create.playerId,
    secret: create.secret,
  });
  assert.equal(res.ok, true);
  await wait(120);

  // a bot holding the seat would leave the admin controls with nobody
  assert.equal(back().hostId, create.playerId, 'the human is host again after a refresh');
  const holder = back().players.find((p) => p.id === back().hostId);
  assert.equal(holder.isBot, false);

  await ack(refreshed, 'remove-bots');
});

// chat-send deliberately does NOT persistAndBroadcast (see the handler), so a
// cached `state` never updates from it alone — these tests listen on
// 'chat-message' directly, which is the real fast path (and what the client
// actually appends into its local state; see GameContext).
function chatLogOf(socket) {
  const log = [];
  socket.on('chat-message', (m) => log.push(m));
  return log;
}

test('chat-send: authed, phase-gated, trimmed and capped, broadcast to everyone', async () => {
  const host = await connect();
  await ack(host, 'create-room', { name: 'Host' });

  // no room, no round yet — both refused
  const stray = await connect();
  assert.equal((await ack(stray, 'chat-send', { text: 'hi' })).ok, false);
  assert.equal((await ack(host, 'chat-send', { text: 'too early' })).ok, false); // LOBBY

  const { socks } = await fullRoomToRound1();
  const senderLog = chatLogOf(socks[0]);
  const otherLog = chatLogOf(socks[1]); // a DIFFERENT socket, not just the sender's own echo

  const res = await ack(socks[0], 'chat-send', { text: '  hello table  ' });
  assert.equal(res.ok, true);
  await wait(60);

  assert.equal(senderLog.length, 1);
  const msg = senderLog[0];
  assert.equal(msg.text, 'hello table'); // trimmed
  assert.equal(msg.name, 'Host');
  assert.equal(msg.via, 'text');
  assert.ok(msg.id && msg.at);
  assert.deepEqual(otherLog[0], msg);

  // empty / whitespace-only refused
  assert.equal((await ack(socks[0], 'chat-send', { text: '   ' })).ok, false);
  // absurdly long text is capped, not rejected
  const long = await ack(socks[0], 'chat-send', { text: 'x'.repeat(500) });
  assert.equal(long.ok, true);
  await wait(60);
  assert.equal(senderLog.at(-1).text.length, 200);
});

test('chat-send: the drawer badge follows whoever is drawing right now', async () => {
  const { socks, getState } = await fullRoomToRound1();
  const drawerIdx = getState().players.findIndex((p) => p.id === getState().round.drawerId);
  const otherIdx = drawerIdx === 0 ? 1 : 0;
  const log = chatLogOf(socks[drawerIdx]);

  await ack(socks[drawerIdx], 'chat-send', { text: 'from the drawer' });
  await ack(socks[otherIdx], 'chat-send', { text: 'from a guesser' });
  await wait(60);

  assert.equal(log[0].wasDrawer, true);
  assert.equal(log[1].wasDrawer, false);
});

test('chat is cleared at the start of every round, not carried forward', async () => {
  const { socks, getState } = await fullRoomToRound1();
  await ack(socks[0], 'chat-send', { text: 'round 1 chatter' });
  await wait(60);
  assert.equal(getState().round.remainingCount, 4); // 1 word x 4 players, precondition

  // guess every slip from the same drawer (correct-guess only rotates drawer at
  // a round *boundary*, so one drawer clears the whole round in one turn)
  const drawerIdx = getState().players.findIndex((p) => p.id === getState().round.drawerId);
  const drawer = socks[drawerIdx];
  let revealed = new Promise((r) => drawer.once('slip-revealed', r));
  await ack(drawer, 'start-turn');
  let { slip, turnId } = await revealed;
  for (let i = 0; i < 4; i++) {
    const next = i < 3 ? new Promise((r) => drawer.once('slip-revealed', r)) : null;
    await ack(drawer, 'correct-guess', { slipId: slip.id, turnId });
    if (next) ({ slip, turnId } = await next);
  }
  await wait(80);
  assert.equal(getState().phase, 'ROUND2');

  // round 2 opens behind the ready gate — lift it directly rather than re-play
  if (getState().round.awaitingReady) {
    for (const s of socks) await ack(s, 'player-ready');
    await wait(80);
  }
  assert.equal(getState().round.chat.length, 0, 'new round starts with an empty transcript');
});

test('chat-send is rate-limited per socket', async () => {
  const { socks } = await fullRoomToRound1();
  const results = [];
  for (let i = 0; i < 12; i++) results.push(await ack(socks[0], 'chat-send', { text: `msg ${i}` }));
  const ok = results.filter((r) => r.ok).length;
  assert.ok(ok >= 1 && ok < 12, `expected a burst then a stop, got ${ok}/12 ok`);
  assert.match(results.at(-1).error ?? '', /slow down/);
});

test('a hot-joiner sees the existing chat history via state, not just new messages', async () => {
  const { socks, roomCode, getState } = await fullRoomToRound1();
  await ack(socks[0], 'chat-send', { text: 'already said this' });
  await wait(60);

  const late = await connect();
  const lateState = latestStateOf(late);
  await ack(late, 'join-room', { roomCode, name: 'Latecomer' });
  await wait(80);

  assert.equal(getState().config.hotJoin, true);
  assert.ok(lateState().round.chat.some((m) => m.text === 'already said this'));
});
