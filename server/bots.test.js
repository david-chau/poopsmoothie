import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bots-unit-'));
const rooms = await import('./rooms.js');
const bots = await import('./bots.js');

// Bots are socket.io clients running inside the server process. A restart kills
// them, but the room comes back from disk with the bot *players* still in it —
// permanently disconnected, unable to draw, and impossible to hand a turn to.
test('bots left over from a previous run are cleared, humans are not', () => {
  const room = rooms.newRoom();
  const human = rooms.addPlayer(room, 'David');
  const bot1 = rooms.addPlayer(room, 'Bot 1');
  const bot2 = rooms.addPlayer(room, 'Bot 2');
  bot1.isBot = true;
  bot2.isBot = true;
  // what a reload looks like: nothing is connected yet
  for (const p of room.players.values()) p.connected = false;

  assert.equal(bots.dropOrphanedBots(room), 2);
  assert.deepEqual([...room.players.values()].map((p) => p.name), ['David']);
  assert.equal(room.hostId, human.id, 'the human keeps the room');
});

test('clearing them is a no-op for a room that never had any', () => {
  const room = rooms.newRoom();
  rooms.addPlayer(room, 'David');
  assert.equal(bots.dropOrphanedBots(room), 0);
  assert.equal(room.players.size, 1);
});

test('a room that was only bots is left empty, for boot to delete', () => {
  const room = rooms.newRoom();
  const bot = rooms.addPlayer(room, 'Bot 1');
  bot.isBot = true;
  assert.equal(bots.dropOrphanedBots(room), 1);
  assert.equal(room.players.size, 0);
});
