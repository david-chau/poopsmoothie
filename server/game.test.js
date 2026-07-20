import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rooms from './rooms.js';
import * as game from './game.js';

function setup(wordsPerPlayer = 2) {
  const room = rooms.newRoom();
  const players = ['Alice', 'Bob', 'Carol', 'Dave'].map((name) => rooms.addPlayer(room, name));
  room.config.wordsPerPlayer = wordsPerPlayer;
  room.config.turnSeconds = 1000; // long enough it never fires during the test
  game.startWriting(room);
  for (const p of players) {
    const words = Array.from({ length: wordsPerPlayer }, (_, i) => `${p.name}-word${i}`);
    const result = game.submitWords(room, p.id, words);
    assert.equal(result.ok, true);
  }
  assert.equal(game.allConnectedSubmitted(room), true);
  game.beginRound1(room);
  return { room, players };
}

function stopTimer(room) {
  clearTimeout(room.round.timeoutHandle); // avoid keeping the test process alive
}

test('pool built from all submissions, round starts with a drawer', () => {
  const { room, players } = setup();
  assert.equal(Object.keys(room.pool).length, 8); // 4 players x 2 words
  assert.equal(room.round.remaining.length, 8);
  assert.equal(room.phase, 'ROUND1');
  assert.equal(room.round.drawerId, players[0].id); // team A's first player
  stopTimer(room);
});

test('correct-guess scores the active team and draws the next slip', () => {
  const { room, players } = setup();
  const drawer = players[0];
  const startResult = game.startTurn(room, drawer.id, () => {});
  assert.equal(startResult.ok, true);
  const slipId = room.round.currentSlipId;
  const turnId = room.round.turnId;

  const result = game.correctGuess(room, drawer.id, slipId, turnId);
  assert.equal(result.ok, true);
  assert.equal(room.teamScores.A, 1);
  assert.equal(room.round.guessed.length, 1);
  assert.notEqual(room.round.currentSlipId, slipId); // moved on to the next slip
  stopTimer(room);
});

test('stale slipId/turnId are rejected (gap #9 — no double-tap / lag exploits)', () => {
  const { room, players } = setup();
  const drawer = players[0];
  game.startTurn(room, drawer.id, () => {});
  const slipId = room.round.currentSlipId;
  const turnId = room.round.turnId;

  const wrongTurn = game.correctGuess(room, drawer.id, slipId, 'not-the-real-turn');
  assert.equal(wrongTurn.ok, false);
  const wrongSlip = game.correctGuess(room, drawer.id, 'not-the-real-slip', turnId);
  assert.equal(wrongSlip.ok, false);
  assert.equal(room.teamScores.A, 0); // neither bad call scored
  stopTimer(room);
});

test('pass-turn sends the slip to the bottom of the stack', () => {
  const { room, players } = setup();
  const drawer = players[0];
  game.startTurn(room, drawer.id, () => {});
  const passedSlipId = room.round.currentSlipId;
  const turnId = room.round.turnId;

  game.passTurn(room, drawer.id, passedSlipId, turnId);
  assert.equal(room.round.remaining.at(-1), passedSlipId);
  assert.notEqual(room.round.currentSlipId, passedSlipId);
  stopTimer(room);
});

test('timeout returns the in-hand slip to the pool and advances the drawer (gap #6)', () => {
  const { room, players } = setup();
  const drawer = players[0];
  game.startTurn(room, drawer.id, () => {});
  const inHandSlipId = room.round.currentSlipId;
  const remainingBefore = room.round.remaining.length;

  game.timeoutTurn(room);

  assert.ok(room.round.remaining.includes(inHandSlipId));
  assert.equal(room.round.remaining.length, remainingBefore + 1);
  assert.equal(room.round.currentSlipId, null);
  assert.equal(room.round.turnEndsAt, null);
  assert.equal(room.activeTeam, 'B'); // turn passed to the other team
  assert.equal(room.round.drawerId, players[1].id); // team B's first player
  stopTimer(room);
});

test('slips reappear every round and scores accumulate across rounds (core rule)', () => {
  const { room, players } = setup();
  const drawer = players[0];

  // Guess every slip in round 1.
  game.startTurn(room, drawer.id, () => {});
  let guesses = 0;
  while (room.round.currentSlipId) {
    const result = game.correctGuess(room, drawer.id, room.round.currentSlipId, room.round.turnId);
    assert.equal(result.ok, true);
    guesses += 1;
    if (result.roundEnded) {
      game.endTurnIfRoundOver(room, true);
      break;
    }
  }

  assert.equal(guesses, 8); // all 8 slips guessed
  assert.equal(room.phase, 'ROUND2');
  assert.equal(room.round.remaining.length, 8); // gap #15: same pool reused, not shrunk
  assert.equal(room.round.guessed.length, 0); // guessed resets each round
  assert.equal(room.teamScores.A, 8); // running total, not reset
  assert.deepEqual(room.roundScores[0], { A: 8, B: 0 }); // per-round delta recorded
  // team A finished round 1 (drew the last slip), so round 2 must open with team B
  assert.equal(room.activeTeam, 'B');
  assert.equal(room.round.drawerId, players[1].id); // team B's first player
  stopTimer(room);
});

test('round 1 still opens with team A (toggle only applies at round boundaries after the first)', () => {
  const { room, players } = setup();
  assert.equal(room.phase, 'ROUND1');
  assert.equal(room.activeTeam, 'A');
  assert.equal(room.round.drawerId, players[0].id);
});
