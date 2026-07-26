import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rooms from './rooms.js';

test('newRoom: unique codes, LOBBY phase, default config with per-round skip', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(rooms.newRoom().code);
  assert.equal(seen.size, 200); // no collisions across 200 rooms

  const room = rooms.newRoom();
  assert.equal(room.phase, 'LOBBY');
  assert.equal(room.config.wordsPerPlayer, 5);
  assert.equal(room.config.turnSeconds, 60);
  assert.deepEqual(room.config.allowSkip, { ROUND1: true, ROUND2: true, ROUND3: false });
  assert.match(room.code, /^[A-Z2-9]{4}$/); // no ambiguous 0/O/1/I
});

test('getRoom is case-insensitive', () => {
  const room = rooms.newRoom();
  assert.equal(rooms.getRoom(room.code.toLowerCase()), room);
  assert.equal(rooms.getRoom('nope'), undefined);
});

test('addPlayer: first player is host, teams auto-balance A/B/A/B', () => {
  const room = rooms.newRoom();
  const [a, b, c, d] = ['Al', 'Bo', 'Cy', 'Di'].map((n) => rooms.addPlayer(room, n));
  assert.equal(room.hostId, a.id); // first is host
  assert.deepEqual(
    [a.team, b.team, c.team, d.team],
    ['A', 'B', 'A', 'B'], // balanced by count
  );
});

test('addPlayer: name defaulted and length-capped', () => {
  const room = rooms.newRoom();
  const blank = rooms.addPlayer(room, '');
  assert.equal(blank.name, 'Player');
  const long = rooms.addPlayer(room, 'x'.repeat(100));
  assert.equal(long.name.length, 40);
});

test('findPlayerBySecret: right secret ok, wrong secret rejected', () => {
  const room = rooms.newRoom();
  const p = rooms.addPlayer(room, 'Al');
  assert.equal(rooms.findPlayerBySecret(room, p.id, p.secret), p);
  assert.equal(rooms.findPlayerBySecret(room, p.id, 'wrong'), null);
  assert.equal(rooms.findPlayerBySecret(room, 'no-such-id', p.secret), null);
});

test('setTeam: self-move ok, host moves anyone, non-host cannot move others', () => {
  const room = rooms.newRoom();
  const host = rooms.addPlayer(room, 'Host');
  const other = rooms.addPlayer(room, 'Other');

  // self move
  assert.equal(rooms.setTeam(room, other.id, other.id, 'A').ok, true);
  assert.equal(other.team, 'A');
  // host moves other
  assert.equal(rooms.setTeam(room, host.id, other.id, 'B').ok, true);
  assert.equal(other.team, 'B');
  // non-host moving someone else -> rejected
  assert.equal(rooms.setTeam(room, other.id, host.id, 'A').ok, false);
  // invalid team / unknown target
  assert.equal(rooms.setTeam(room, host.id, other.id, 'C').ok, false);
  assert.equal(rooms.setTeam(room, host.id, 'ghost', 'A').ok, false);
});

test('transferHostIfNeeded: moves host off a disconnected host, no-op when connected', () => {
  const room = rooms.newRoom();
  const a = rooms.addPlayer(room, 'A');
  const b = rooms.addPlayer(room, 'B');
  assert.equal(room.hostId, a.id);

  rooms.transferHostIfNeeded(room); // a still connected -> no change
  assert.equal(room.hostId, a.id);

  a.connected = false;
  rooms.transferHostIfNeeded(room);
  assert.equal(room.hostId, b.id); // moved to the connected player

  b.connected = false;
  rooms.transferHostIfNeeded(room); // nobody connected -> keeps last
  assert.equal(room.hostId, b.id);
});

test('removePlayer: drops slot + submission, reassigns host if the host left', () => {
  const room = rooms.newRoom();
  const a = rooms.addPlayer(room, 'A');
  const b = rooms.addPlayer(room, 'B');
  room.submissions[a.id] = ['x'];

  rooms.removePlayer(room, a.id);
  assert.equal(room.players.has(a.id), false);
  assert.equal(room.submissions[a.id], undefined);
  assert.equal(room.hostId, b.id); // host reassigned

  rooms.removePlayer(room, b.id);
  assert.equal(room.players.size, 0);
  assert.equal(room.hostId, null); // nobody left
});

test('teamHasConnectedPlayer / connectedCount reflect connection state', () => {
  const room = rooms.newRoom();
  const a = rooms.addPlayer(room, 'A'); // team A
  const b = rooms.addPlayer(room, 'B'); // team B
  assert.equal(rooms.connectedCount(room), 2);
  assert.equal(rooms.teamHasConnectedPlayer(room, 'A'), true);
  a.connected = false;
  assert.equal(rooms.connectedCount(room), 1);
  assert.equal(rooms.teamHasConnectedPlayer(room, 'A'), false);
  assert.equal(rooms.teamHasConnectedPlayer(room, 'B'), true);
  void b;
});

test('destroyRoom evicts from the shared Map', () => {
  const room = rooms.newRoom();
  assert.equal(rooms.getRoom(room.code), room);
  rooms.destroyRoom(room.code);
  assert.equal(rooms.getRoom(room.code), undefined);
});

test('secrets are stored hashed, never in plaintext', () => {
  const room = rooms.newRoom();
  const player = rooms.addPlayer(room, 'Al');
  const stored = room.players.get(player.id);

  assert.ok(player.secret, 'caller gets the raw secret once');
  assert.ok(stored.secretHash, 'only the hash is kept');
  assert.notEqual(stored.secretHash, player.secret);
  // the whole point: a room file on disk must not contain the raw secret
  assert.equal(JSON.parse(JSON.stringify(stored)).secret, undefined);
  assert.equal(Object.keys(stored).includes('secret'), false);

  assert.ok(rooms.findPlayerBySecret(room, player.id, player.secret));
  assert.equal(rooms.findPlayerBySecret(room, player.id, 'wrong'), null);
  assert.equal(rooms.findPlayerBySecret(room, player.id, undefined), null);
  assert.equal(rooms.findPlayerBySecret(room, player.id, stored.secretHash), null); // hash isn't a password
});

test('getRoom tolerates any JSON type a client can send', () => {
  for (const bad of [{}, [], 42, null, undefined, true]) {
    assert.equal(rooms.getRoom(bad), undefined);
  }
});
