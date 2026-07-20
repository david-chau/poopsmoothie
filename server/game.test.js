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

test('pass is disabled by default in round 3 (Password) but on for rounds 1-2', () => {
  const { room, players } = setup();
  const drawer = players[0];
  assert.deepEqual(room.config.allowSkip, { ROUND1: true, ROUND2: true, ROUND3: false });

  game.startTurn(room, drawer.id, () => {});
  const slipId = room.round.currentSlipId;
  const turnId = room.round.turnId;
  const remainingBefore = room.round.remaining.length;

  room.phase = 'ROUND3'; // simulate being in round 3 without playing through 1-2
  const result = game.passTurn(room, drawer.id, slipId, turnId);
  assert.equal(result.ok, false);
  assert.equal(room.round.remaining.length, remainingBefore); // untouched, current slip still in hand
  assert.equal(room.round.currentSlipId, slipId);

  room.phase = 'ROUND1';
  const okResult = game.passTurn(room, drawer.id, slipId, turnId);
  assert.equal(okResult.ok, true);
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

test('drawer disconnecting during awaiting-start pauses the turn (no silent stall)', () => {
  const { room, players } = setup();
  const drawer = players[0];
  // turn assigned but not started yet: turnEndsAt is null
  assert.equal(room.round.turnEndsAt, null);
  assert.equal(room.round.drawerId, drawer.id);

  drawer.connected = false;
  game.pauseForDisconnectedDrawer(room);

  assert.equal(room.round.paused, true);
  assert.equal(room.round.pauseReason, 'drawer-disconnected');
  // and the drawer can resume into a full fresh turn once back
  drawer.connected = true;
  const res = game.resumeTurn(room, drawer.id, () => {});
  assert.equal(res.ok, true);
  assert.ok(room.round.turnEndsAt > Date.now());
  assert.ok(room.round.currentSlipId); // a slip was drawn
  stopTimer(room);
});

test('a fully-offline round recovers when a player reconnects (recoverStrandedTurn)', () => {
  const { room, players } = setup();
  // everyone drops -> next turn transition strands the round
  for (const p of players) p.connected = false;
  game.timeoutTurn(room); // triggers advanceToNextDrawer with no one connected
  assert.equal(room.round.paused, true);
  assert.equal(room.round.pauseReason, 'no-connected-players');
  assert.equal(room.round.drawerId, null);

  // nobody back yet -> no recovery
  assert.equal(game.recoverStrandedTurn(room), false);

  // someone reconnects -> recovery reassigns a drawer
  players[1].connected = true;
  const recovered = game.recoverStrandedTurn(room);
  assert.equal(recovered, true);
  assert.equal(room.round.paused, false);
  assert.equal(room.round.drawerId, players[1].id);
  stopTimer(room);
});

test('recoverStrandedTurn leaves a normal drawer-disconnected pause alone', () => {
  const { room, players } = setup();
  const drawer = players[0];
  game.startTurn(room, drawer.id, () => {});
  drawer.connected = false;
  game.pauseForDisconnectedDrawer(room); // reason: drawer-disconnected, not stranded

  // a different player reconnecting must NOT hijack the turn from the real drawer
  players[1].connected = true;
  assert.equal(game.recoverStrandedTurn(room), false);
  assert.equal(room.round.drawerId, drawer.id);
  assert.equal(room.round.paused, true);
  stopTimer(room);
});

// --- word submission validation ---

test('submitWords rejects wrong count, empties, and over-long words', () => {
  const room = rooms.newRoom();
  const p = rooms.addPlayer(room, 'Al');
  room.config.wordsPerPlayer = 2;
  game.startWriting(room);

  assert.equal(game.submitWords(room, p.id, ['only-one']).ok, false); // wrong count
  assert.equal(game.submitWords(room, p.id, ['a', '   ']).ok, false); // blank after trim
  assert.equal(game.submitWords(room, p.id, ['a', 'x'.repeat(81)]).ok, false); // too long
  assert.equal(game.submitWords(room, p.id, ['fine', ' trimmed ']).ok, true);
  assert.deepEqual(room.submissions[p.id], ['fine', 'trimmed']); // trimmed, stored
});

test('submitWords is idempotent per player (resubmit replaces)', () => {
  const room = rooms.newRoom();
  const p = rooms.addPlayer(room, 'Al');
  room.config.wordsPerPlayer = 2;
  game.startWriting(room);
  game.submitWords(room, p.id, ['a', 'b']);
  game.submitWords(room, p.id, ['c', 'd']);
  assert.deepEqual(room.submissions[p.id], ['c', 'd']);
});

test('allConnectedSubmitted ignores disconnected players', () => {
  const room = rooms.newRoom();
  const [a, b] = ['A', 'B'].map((n) => rooms.addPlayer(room, n));
  room.config.wordsPerPlayer = 1;
  game.startWriting(room);
  game.submitWords(room, a.id, ['x']);
  assert.equal(game.allConnectedSubmitted(room), false); // B still owes
  b.connected = false;
  assert.equal(game.allConnectedSubmitted(room), true); // B no longer counted
});

test('buildPool creates one slip per submitted word with author attribution', () => {
  const { room, players } = setup(); // 4 players x 2 words = 8
  assert.equal(Object.keys(room.pool).length, 8);
  const authors = new Set(Object.values(room.pool).map((s) => s.authorId));
  assert.equal(authors.size, 4); // every player authored some
  for (const p of players) {
    assert.equal(Object.values(room.pool).filter((s) => s.authorId === p.id).length, 2);
  }
  stopTimer(room);
});

// --- turn transitions: skip / force-pass / resume / end ---

test('skipDrawer keeps the same team, rotates to the next drawer', () => {
  const { room, players } = setup(); // team A: players[0],[2]  team B: players[1],[3]
  const drawer = players[0];
  game.startTurn(room, drawer.id, () => {});
  const inHand = room.round.currentSlipId;

  game.skipDrawer(room);
  assert.equal(room.activeTeam, 'A'); // same team
  assert.equal(room.round.drawerId, players[2].id); // next A player
  assert.ok(room.round.remaining.includes(inHand)); // slip returned to pool
  assert.equal(room.round.turnEndsAt, null); // awaiting start
  stopTimer(room);
});

test('forcePassTeam hands the turn to the other team', () => {
  const { room, players } = setup();
  const drawer = players[0];
  game.startTurn(room, drawer.id, () => {});
  const inHand = room.round.currentSlipId;

  game.forcePassTeam(room);
  assert.equal(room.activeTeam, 'B'); // other team
  assert.equal(room.round.drawerId, players[1].id);
  assert.ok(room.round.remaining.includes(inHand));
  stopTimer(room);
});

test('resumeTurn banks the remaining time from a mid-turn pause', () => {
  const { room, players } = setup();
  const drawer = players[0];
  room.config.turnSeconds = 60;
  game.startTurn(room, drawer.id, () => {});
  // simulate 40s elapsed by backdating turnEndsAt to 20s from now
  room.round.turnEndsAt = Date.now() + 20_000;
  drawer.connected = false;
  game.pauseForDisconnectedDrawer(room);
  assert.ok(room.round.remainingMsAtPause <= 20_000 && room.round.remainingMsAtPause > 18_000);

  drawer.connected = true;
  game.resumeTurn(room, drawer.id, () => {});
  const secondsLeft = (room.round.turnEndsAt - Date.now()) / 1000;
  assert.ok(secondsLeft <= 20 && secondsLeft > 18); // resumed with ~20s, not a full 60
  stopTimer(room);
});

test('resumeTurn is drawer-only and requires a paused turn', () => {
  const { room, players } = setup();
  const drawer = players[0];
  game.startTurn(room, drawer.id, () => {});
  assert.equal(game.resumeTurn(room, drawer.id, () => {}).ok, false); // not paused
  drawer.connected = false;
  game.pauseForDisconnectedDrawer(room);
  assert.equal(game.resumeTurn(room, players[1].id, () => {}).ok, false); // not the drawer
  assert.equal(game.resumeTurn(room, drawer.id, () => {}).ok, true);
  stopTimer(room);
});

test('endGameNow jumps straight to SCORES', () => {
  const { room, players } = setup();
  game.startTurn(room, players[0].id, () => {});
  game.endGameNow(room);
  assert.equal(room.phase, 'SCORES');
  assert.equal(room.round.timeoutHandle, null); // timer cleared
});
