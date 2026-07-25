import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rooms from './rooms.js';
import { SUGGESTIONS, suggestWords } from './suggestions.js';

test('suggestion pool has no duplicates of its own', () => {
  const seen = new Set(SUGGESTIONS.map((w) => w.toLowerCase()));
  assert.equal(seen.size, SUGGESTIONS.length);
});

test('returns the requested count, all distinct', () => {
  const room = rooms.newRoom();
  const picked = suggestWords(room, 5);
  assert.equal(picked.length, 5);
  assert.equal(new Set(picked).size, 5);
});

test('never suggests something already submitted in the room', () => {
  const room = rooms.newRoom();
  const taken = SUGGESTIONS.slice(0, 3);
  room.submissions = { p1: taken };

  // repeat: a single draw could dodge the collision by luck
  for (let i = 0; i < 30; i++) {
    for (const word of suggestWords(room, 5)) assert.ok(!taken.includes(word));
  }
});

test('excludes the caller’s own unsaved boxes, case- and space-insensitively', () => {
  const room = rooms.newRoom();
  const mine = `  ${SUGGESTIONS[0].toUpperCase()}  `;
  for (let i = 0; i < 30; i++) {
    for (const word of suggestWords(room, 5, [mine, '', '   '])) {
      assert.notEqual(word.toLowerCase(), SUGGESTIONS[0].toLowerCase());
    }
  }
});

test('returns what it can rather than throwing when the pool is exhausted', () => {
  const room = rooms.newRoom();
  room.submissions = { p1: SUGGESTIONS.slice(0, SUGGESTIONS.length - 2) };
  const picked = suggestWords(room, 5);
  assert.equal(picked.length, 2);
});
