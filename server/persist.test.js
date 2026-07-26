import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// persist.js reads DATA_DIR and mkdirs at import time — must be set first, so
// these run against a throwaway temp dir instead of the real ./data.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-persist-'));
process.env.DATA_DIR = TMP;
const ROOMS_DIR = path.join(TMP, 'rooms');

const persist = await import('./persist.js');
const rooms = await import('./rooms.js');

function fileFor(code) {
  return path.join(ROOMS_DIR, `${code}.json`);
}

test('saveRoom writes atomically-renamed JSON with players as an array, no timer handle', () => {
  const room = rooms.newRoom();
  rooms.addPlayer(room, 'Al');
  room.round.timeoutHandle = setTimeout(() => {}, 10_000); // must not be serialized
  persist.saveRoom(room);
  clearTimeout(room.round.timeoutHandle);

  assert.equal(fs.existsSync(fileFor(room.code)), true);
  assert.equal(fs.existsSync(`${fileFor(room.code)}.tmp`), false); // temp renamed away
  const raw = JSON.parse(fs.readFileSync(fileFor(room.code), 'utf8'));
  assert.ok(Array.isArray(raw.players)); // Map serialized to array
  assert.equal(raw.players.length, 1);
  assert.equal(raw.round.timeoutHandle, undefined);
  assert.ok(raw.lastActivity > 0);
});

test('loadAllRooms round-trips a room: players back as a Map, connections reset', () => {
  const room = rooms.newRoom();
  const p = rooms.addPlayer(room, 'Al');
  p.connected = true;
  p.socketId = 'live-socket';
  persist.saveRoom(room);
  rooms.destroyRoom(room.code); // wipe from memory so load repopulates

  const loaded = persist.loadAllRooms();
  const back = rooms.getRoom(room.code);
  assert.ok(back, 'room reloaded into the Map');
  assert.ok(loaded.some((r) => r.code === room.code));
  const backPlayer = back.players.get(p.id);
  assert.equal(backPlayer.name, 'Al');
  assert.equal(backPlayer.connected, false); // reset on load — nobody's actually connected post-restart
  assert.equal(backPlayer.socketId, null);
});

test('loadAllRooms purges room files idle > 24h and does not load them', () => {
  const stale = rooms.newRoom();
  rooms.addPlayer(stale, 'Old');
  persist.saveRoom(stale);
  // backdate lastActivity to 25h ago
  const raw = JSON.parse(fs.readFileSync(fileFor(stale.code), 'utf8'));
  raw.lastActivity = Date.now() - 25 * 60 * 60 * 1000;
  fs.writeFileSync(fileFor(stale.code), JSON.stringify(raw));
  rooms.destroyRoom(stale.code);

  const loaded = persist.loadAllRooms();
  assert.equal(fs.existsSync(fileFor(stale.code)), false); // file deleted
  assert.equal(
    loaded.some((r) => r.code === stale.code),
    false, // not loaded
  );
});

test('loadAllRooms skips a corrupt file without throwing', () => {
  fs.writeFileSync(path.join(ROOMS_DIR, 'BAD1.json'), '{ not valid json');
  assert.doesNotThrow(() => persist.loadAllRooms());
});

test('deleteRoom removes the file (and tolerates a missing one)', () => {
  const room = rooms.newRoom();
  persist.saveRoom(room);
  assert.equal(fs.existsSync(fileFor(room.code)), true);
  persist.deleteRoom(room.code);
  assert.equal(fs.existsSync(fileFor(room.code)), false);
  assert.doesNotThrow(() => persist.deleteRoom(room.code)); // already gone
});

test('a legacy room file with a plaintext secret is migrated on load', () => {
  const legacy = {
    code: 'OLD1',
    lastActivity: Date.now(),
    hostId: 'p1',
    phase: 'LOBBY',
    players: [{ id: 'p1', secret: 'plaintext-secret', name: 'Al', team: 'A', connected: true }],
    round: {},
  };
  fs.writeFileSync(fileFor('OLD1'), JSON.stringify(legacy));

  const loaded = persist.loadAllRooms().find((r) => r.code === 'OLD1');
  const player = loaded.players.get('p1');
  assert.equal(player.secret, undefined, 'plaintext dropped');
  assert.equal(player.secretHash, rooms.hashSecret('plaintext-secret'), 'converted, not invalidated');
  // and the old credential still works, so nobody is logged out by the upgrade
  assert.ok(rooms.findPlayerBySecret(loaded, 'p1', 'plaintext-secret'));
});
