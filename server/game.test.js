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

// --- host patch controls ----------------------------------------------------

test('revert-last-guess un-scores the slip and puts it back on top of the pile', () => {
  const { room, players } = setup();
  const drawer = players[0];
  game.startTurn(room, drawer.id, () => {});
  const slipId = room.round.currentSlipId;
  game.correctGuess(room, drawer.id, slipId, room.round.turnId);
  assert.equal(room.teamScores.A, 1);
  const remainingBefore = room.round.remaining.length;

  const result = game.revertLastGuess(room);
  assert.equal(result.ok, true);
  assert.equal(room.teamScores.A, 0);
  assert.equal(room.round.guessed.length, 0);
  assert.equal(room.pool[slipId].scoredBy.length, 0);
  assert.equal(room.round.remaining.length, remainingBefore + 1);
  assert.equal(room.round.remaining[0], slipId); // next one up
  stopTimer(room);
});

test('revert-last-guess debits the team that scored, not whoever is active now', () => {
  const { room, players } = setup();
  const drawer = players[0]; // team A
  game.startTurn(room, drawer.id, () => {});
  game.correctGuess(room, drawer.id, room.round.currentSlipId, room.round.turnId);
  game.forcePassTeam(room); // active team is now B
  assert.equal(room.activeTeam, 'B');

  game.revertLastGuess(room);
  assert.equal(room.teamScores.A, 0);
  assert.equal(room.teamScores.B, 0); // B never scored it, must not go negative
  stopTimer(room);
});

test('revert-last-guess refuses when nothing was scored this round', () => {
  const { room } = setup();
  const result = game.revertLastGuess(room);
  assert.equal(result.ok, false);
  stopTimer(room);
});

test('set-drawer hands the turn over, returns the in-hand slip, and switches team', () => {
  const { room, players } = setup();
  const drawer = players[0]; // team A
  game.startTurn(room, drawer.id, () => {});
  const inHand = room.round.currentSlipId;
  const oldTurnId = room.round.turnId;
  const target = players.find((p) => room.players.get(p.id).team === 'B');

  const result = game.setDrawer(room, target.id);
  assert.equal(result.ok, true);
  assert.equal(room.round.drawerId, target.id);
  assert.equal(room.activeTeam, 'B');
  assert.equal(room.round.currentSlipId, null);
  assert.equal(room.round.turnEndsAt, null);
  assert.notEqual(room.round.turnId, oldTurnId); // stale taps from the old drawer die
  assert.ok(room.round.remaining.includes(inHand));
  stopTimer(room);
});

test('set-drawer rejects unknown and offline players', () => {
  const { room, players } = setup();
  assert.equal(game.setDrawer(room, 'nobody').ok, false);
  room.players.get(players[1].id).connected = false;
  assert.equal(game.setDrawer(room, players[1].id).ok, false);
  stopTimer(room);
});

test('set-slip-scorer re-attributes a word and the team score follows', () => {
  const { room, players } = setup();
  const drawer = players[0]; // team A
  game.startTurn(room, drawer.id, () => {});
  const slipId = room.round.currentSlipId;
  game.correctGuess(room, drawer.id, slipId, room.round.turnId);
  assert.deepEqual(room.teamScores, { A: 1, B: 0 });

  // actually it was a team B player who got it
  const teamB = players.find((p) => room.players.get(p.id).team === 'B');
  assert.equal(game.setSlipScorer(room, slipId, 1, teamB.id).ok, true);
  assert.deepEqual(room.teamScores, { A: 0, B: 1 }); // moved, not double-counted
  assert.equal(room.pool[slipId].scoredBy.length, 1); // replaced, not appended

  // nobody got it after all
  assert.equal(game.setSlipScorer(room, slipId, 1, null).ok, true);
  assert.deepEqual(room.teamScores, { A: 0, B: 0 });
  assert.equal(room.pool[slipId].scoredBy.length, 0);
  stopTimer(room);
});

test('set-slip-scorer rejects bad slip, round, and player', () => {
  const { room, players } = setup();
  const slipId = Object.keys(room.pool)[0];
  assert.equal(game.setSlipScorer(room, 'nope', 1, players[0].id).ok, false);
  assert.equal(game.setSlipScorer(room, slipId, 0, players[0].id).ok, false);
  assert.equal(game.setSlipScorer(room, slipId, 4, players[0].id).ok, false);
  assert.equal(game.setSlipScorer(room, slipId, 1, 'ghost').ok, false);
  stopTimer(room);
});

test('re-attributing an earlier round also rewrites that round’s banked delta', () => {
  const { room, players } = setup(1); // 4 slips, one per player
  // burn through round 1 entirely so it gets banked into roundScores
  let guard = 0;
  while (room.phase === 'ROUND1' && guard++ < 50) {
    const drawerId = room.round.drawerId;
    if (!room.round.turnEndsAt) game.startTurn(room, drawerId, () => {});
    if (!room.round.currentSlipId) break;
    const res = game.correctGuess(room, drawerId, room.round.currentSlipId, room.round.turnId);
    game.endTurnIfRoundOver(room, res.roundEnded); // events.js does this for real callers
  }
  assert.equal(room.phase, 'ROUND2');
  assert.equal(room.roundScores.length, 1);
  const banked = { ...room.roundScores[0] };
  assert.equal(banked.A + banked.B, 4);

  // flip one round-1 word to the other team
  const slip = Object.values(room.pool).find((s) => s.scoredBy?.some((e) => e.round === 1));
  const hit = slip.scoredBy.find((e) => e.round === 1);
  const other = players.find((p) => room.players.get(p.id).team !== hit.team);
  game.setSlipScorer(room, slip.id, 1, other.id);

  assert.equal(room.roundScores[0].A + room.roundScores[0].B, 4); // still 4 slips
  assert.notDeepEqual(room.roundScores[0], banked); // but the split moved
  assert.deepEqual(room.teamScores, room.roundScores[0]); // only round 1 scored so far
  stopTimer(room);
});

test('host pause stops the clock and only the host can lift it', () => {
  const { room, players } = setup();
  const drawer = players[0];
  game.startTurn(room, drawer.id, () => {});

  assert.equal(game.hostPause(room).ok, true);
  assert.equal(room.round.paused, true);
  assert.equal(room.round.pauseReason, 'host-paused');
  assert.equal(room.round.turnEndsAt, null);
  assert.ok(room.round.remainingMsAtPause > 0); // banked, not discarded
  assert.equal(game.hostPause(room).ok, false); // already paused

  // a non-drawer non-host still can't resume
  assert.equal(game.resumeTurn(room, players[1].id, () => {}).ok, false);
  // the host can, even though they aren't the drawer
  assert.equal(game.resumeTurn(room, players[1].id, () => {}, { isHost: true }).ok, true);
  assert.equal(room.round.paused, false);
  stopTimer(room);
});

test('host cannot use the host-resume path to lift a disconnect pause', () => {
  const { room, players } = setup();
  const drawer = players[0];
  game.startTurn(room, drawer.id, () => {});
  game.pauseForDisconnectedDrawer(room);

  const result = game.resumeTurn(room, players[1].id, () => {}, { isHost: true });
  assert.equal(result.ok, false); // still the drawer's call
  stopTimer(room);
});

test('a hot-joiner is added to the rotation and eventually draws', () => {
  const { room } = setup();
  const late = rooms.addPlayer(room, 'Late');
  const before = [...room.turnOrder[late.team]];
  assert.ok(!before.includes(late.id), 'not in the snapshot taken at round start');

  game.addLatePlayer(room, late);
  assert.deepEqual(room.turnOrder[late.team], [...before, late.id]); // appended, order intact

  // skipDrawer keeps the same team, so rotating it enough times must reach them
  room.activeTeam = late.team;
  const seen = new Set();
  for (let i = 0; i < room.turnOrder[late.team].length + 1; i++) {
    game.skipDrawer(room);
    seen.add(room.round.drawerId);
  }
  assert.ok(seen.has(late.id), 'hot-joiner gets a turn');
  stopTimer(room);
});

test('addLatePlayer is idempotent and safe before the order exists', () => {
  const room = rooms.newRoom();
  const p = rooms.addPlayer(room, 'Early');
  game.addLatePlayer(room, p); // LOBBY: buildTurnOrder will pick them up anyway
  game.addLatePlayer(room, p);
  assert.equal(room.turnOrder[p.team].filter((id) => id === p.id).length, 1);
});

test('switching team mid-game keeps the player in the rotation', () => {
  const { room, players } = setup();
  const victim = players[0]; // team A, and the opening drawer
  assert.ok(room.turnOrder.A.includes(victim.id));

  rooms.setTeam(room, victim.id, victim.id, 'B');
  game.movePlayerInTurnOrder(room, room.players.get(victim.id));

  assert.equal(room.turnOrder.A.includes(victim.id), false, 'gone from the old team');
  assert.ok(room.turnOrder.B.includes(victim.id), 'present in the new one');
  assert.equal(room.activeTeam, 'B', 'they were drawing, so the turn follows them');

  // and they actually come up again when their new team rotates
  const seen = new Set();
  room.activeTeam = 'B';
  for (let i = 0; i < room.turnOrder.B.length + 1; i++) {
    game.skipDrawer(room);
    seen.add(room.round.drawerId);
  }
  assert.ok(seen.has(victim.id));
  stopTimer(room);
});

test('moving a player who is not drawing leaves the active team alone', () => {
  const { room, players } = setup();
  const bystander = players[1]; // team B, not the current drawer
  assert.equal(room.round.drawerId, players[0].id);

  rooms.setTeam(room, bystander.id, bystander.id, 'A');
  game.movePlayerInTurnOrder(room, room.players.get(bystander.id));

  assert.equal(room.activeTeam, 'A'); // unchanged from round start
  assert.equal(room.round.drawerId, players[0].id);
  assert.ok(room.turnOrder.A.includes(bystander.id));
  assert.equal(room.turnOrder.B.includes(bystander.id), false);
  stopTimer(room);
});

test('names are captured on the slip so a player who leaves is still credited', () => {
  const { room, players } = setup(1);
  const drawer = players[0];
  game.startTurn(room, drawer.id, () => {});
  const slipId = room.round.currentSlipId;
  game.correctGuess(room, drawer.id, slipId, room.round.turnId);

  const slip = room.pool[slipId];
  assert.ok(slip.authorName, 'author name recorded at pool build');
  assert.equal(slip.scoredBy[0].playerName, room.players.get(drawer.id).name);

  // they leave; the end-of-game recap must still name them
  const author = slip.authorId;
  const authorName = slip.authorName;
  rooms.removePlayer(room, author);
  rooms.removePlayer(room, drawer.id);
  assert.equal(room.pool[slipId].authorName, authorName);
  assert.equal(room.pool[slipId].scoredBy[0].playerName, 'Alice');
  stopTimer(room);
});

/** guess every slip in the current round, ending it */
function playOutRound(room) {
  let guard = 0;
  const startingPhase = room.phase;
  while (room.phase === startingPhase && guard++ < 100) {
    const drawerId = room.round.drawerId;
    if (!room.round.turnEndsAt) {
      const started = game.startTurn(room, drawerId, () => {});
      if (!started.ok) return started; // blocked (e.g. by the ready gate)
    }
    if (!room.round.currentSlipId) break;
    const res = game.correctGuess(room, drawerId, room.round.currentSlipId, room.round.turnId);
    game.endTurnIfRoundOver(room, res.roundEnded);
  }
  return { ok: true };
}

test('a finished round holds the next one shut until everyone is ready', () => {
  const { room, players } = setup(1);
  playOutRound(room);
  assert.equal(room.phase, 'ROUND2');
  assert.equal(room.round.awaitingReady, true, 'round 2 waits');

  // the drawer cannot sneak a turn in behind everyone else's recap
  const blocked = game.startTurn(room, room.round.drawerId, () => {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /ready/);

  for (const p of players.slice(0, 3)) {
    assert.equal(game.markReady(room, p.id).ok, true);
    assert.equal(room.round.awaitingReady, true, 'still waiting on the last player');
  }
  game.markReady(room, players[3].id);
  assert.equal(room.round.awaitingReady, false, 'last ready opens the round');
  assert.equal(game.startTurn(room, room.round.drawerId, () => {}).ok, true);
  stopTimer(room);
});

test('the host can open the round without waiting', () => {
  const { room } = setup(1);
  playOutRound(room);
  assert.equal(room.round.awaitingReady, true);

  assert.equal(game.startRoundNow(room).ok, true);
  assert.equal(room.round.awaitingReady, false);
  assert.equal(game.startRoundNow(room).ok, false); // nothing left to open
  stopTimer(room);
});

test('a player dropping out mid-recap does not hold the round shut forever', () => {
  const { room, players } = setup(1);
  playOutRound(room);
  assert.equal(room.round.awaitingReady, true);

  for (const p of players.slice(0, 3)) game.markReady(room, p.id);
  assert.equal(room.round.awaitingReady, true, 'still waiting on the fourth');

  // they close their tab instead of tapping ready
  room.players.get(players[3].id).connected = false;
  game.refreshReadyGate(room);
  assert.equal(room.round.awaitingReady, false, 'gate re-evaluates against who is actually here');
  stopTimer(room);
});

test('there is no ready gate into the final scores', () => {
  const { room, players } = setup(1);
  for (const phase of ['ROUND1', 'ROUND2']) {
    assert.equal(room.phase, phase);
    playOutRound(room);
    game.startRoundNow(room);
  }
  assert.equal(room.phase, 'ROUND3');
  playOutRound(room);
  assert.equal(room.phase, 'SCORES');
  assert.equal(room.round.awaitingReady, false, 'the scores screen is the recap');
  assert.equal(room.roundScores.length, 3);
  assert.ok(players.length);
  stopTimer(room);
});

test('play again reopens the lobby around the same people', () => {
  const { room, players } = setup(1);
  playOutRound(room);
  game.startRoundNow(room);
  playOutRound(room);
  game.startRoundNow(room);
  playOutRound(room);
  assert.equal(room.phase, 'SCORES');
  assert.ok(room.teamScores.A + room.teamScores.B > 0);

  game.resetForRematch(room);

  assert.equal(room.phase, 'LOBBY');
  assert.equal(room.players.size, players.length, 'everyone is still here');
  assert.equal(room.hostId, players[0].id, 'and still the host');
  assert.deepEqual(room.teamScores, { A: 0, B: 0 });
  assert.deepEqual(room.roundScores, []);
  assert.deepEqual(room.submissions, {});
  assert.deepEqual(room.pool, {});
  assert.equal(room.round.drawerId, null);
  assert.equal(room.round.awaitingReady, false);
  assert.equal(room.config.wordsPerPlayer, 1, 'settings are kept');

  // and it can actually be played again
  game.startWriting(room);
  for (const p of players) assert.equal(game.submitWords(room, p.id, ['again']).ok, true);
  game.beginRound1(room);
  assert.equal(room.phase, 'ROUND1');
  assert.equal(room.round.remaining.length, players.length);
  stopTimer(room);
});
