import { randomUUID } from 'node:crypto';
import { teamHasConnectedPlayer } from './rooms.js';

export const ROUND_PHASES = ['ROUND1', 'ROUND2', 'ROUND3'];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Word submission (gap #H) ---------------------------------------------

export function submitWords(room, playerId, words) {
  const n = room.config.wordsPerPlayer;
  if (!Array.isArray(words) || words.length !== n) {
    return { ok: false, error: `submit exactly ${n} words` };
  }
  const cleaned = words.map((w) => String(w ?? '').trim()).filter(Boolean);
  if (cleaned.length !== n) return { ok: false, error: 'words cannot be empty' };
  if (cleaned.some((w) => w.length > 80)) return { ok: false, error: 'word too long' };
  room.submissions[playerId] = cleaned; // resubmit replaces (idempotent)
  return { ok: true };
}

export function allConnectedSubmitted(room) {
  const n = room.config.wordsPerPlayer;
  return [...room.players.values()]
    .filter((p) => p.connected)
    .every((p) => (room.submissions[p.id] || []).length === n);
}

// --- Pool + round lifecycle -------------------------------------------------

function buildPool(room) {
  room.pool = {};
  for (const [playerId, words] of Object.entries(room.submissions)) {
    for (const text of words) {
      const id = randomUUID();
      room.pool[id] = { id, text, authorId: playerId };
    }
  }
}

/** Snapshot each team's current roster into a fixed round-robin order.
 *  Rebuilt only once, at the WRITING -> ROUND1 transition, then the
 *  pointer (not the list) persists across rounds (gap #12). */
function buildTurnOrder(room) {
  room.turnOrder = { A: [], B: [] };
  for (const p of room.players.values()) room.turnOrder[p.team].push(p.id);
  room.turnPointer = { A: 0, B: 0 };
}

export function startWriting(room) {
  room.phase = 'WRITING';
  room.submissions = {};
}

/** WRITING -> ROUND1, or host force-start with whoever has submitted. */
export function beginRound1(room) {
  buildPool(room);
  buildTurnOrder(room);
  room.phase = 'ROUND1';
  startRound(room);
}

/** toggleTeam:false for round 1 (starts with the default activeTeam, 'A').
 *  toggleTeam:true when a previous round just finished — the round boundary
 *  should alternate teams same as any normal turn-end would (whoever just
 *  finished the round drew last, so the OTHER team opens the next one). */
function startRound(room, { toggleTeam = false } = {}) {
  room.round.remaining = shuffle(Object.keys(room.pool));
  room.round.guessed = [];
  room.roundStartScores = { ...room.teamScores };
  advanceToNextDrawer(room, { toggleTeam });
}

/** Find the next connected drawer for `team`, rotating that team's pointer.
 *  Returns null if the team has no connected players (gap #S). */
function nextDrawerForTeam(room, team) {
  const list = room.turnOrder[team];
  if (list.length === 0 || !teamHasConnectedPlayer(room, team)) return null;
  for (let tries = 0; tries < list.length; tries++) {
    const idx = room.turnPointer[team] % list.length;
    room.turnPointer[team] = idx + 1;
    const candidateId = list[idx];
    const player = [...room.players.values()].find((p) => p.id === candidateId);
    if (player && player.connected && player.team === team) return candidateId;
  }
  return null;
}

/** Set up an awaiting-start turn for the next drawer. Toggles active team
 *  unless `toggleTeam:false` (round start continues from wherever rotation left off). */
function advanceToNextDrawer(room, { toggleTeam = true } = {}) {
  clearTimer(room);
  if (toggleTeam) room.activeTeam = room.activeTeam === 'A' ? 'B' : 'A';

  let drawerId = nextDrawerForTeam(room, room.activeTeam);
  // gap #S: whole team empty -> try the other team once, else pause the game entirely.
  if (!drawerId) {
    const otherTeam = room.activeTeam === 'A' ? 'B' : 'A';
    drawerId = nextDrawerForTeam(room, otherTeam);
    if (drawerId) room.activeTeam = otherTeam;
  }

  room.round.currentSlipId = null;
  room.round.turnId = randomUUID();
  room.round.turnEndsAt = null;
  room.round.remainingMsAtPause = null;

  if (!drawerId) {
    room.round.drawerId = null;
    room.round.paused = true;
    room.round.pauseReason = 'no-connected-players';
    return;
  }
  room.round.drawerId = drawerId;
  room.round.paused = false;
  room.round.pauseReason = null;
}

function clearTimer(room) {
  if (room.round.timeoutHandle) {
    clearTimeout(room.round.timeoutHandle);
    room.round.timeoutHandle = null;
  }
}

function drawNextSlip(room) {
  const id = room.round.remaining.shift();
  room.round.currentSlipId = id ?? null;
  return id;
}

/** drawer taps "ready" -> draw first slip of the turn, start the timer. */
export function startTurn(room, playerId, onTimeout) {
  if (room.round.drawerId !== playerId) return { ok: false, error: 'not your turn' };
  if (room.round.turnEndsAt) return { ok: false, error: 'turn already running' };
  if (room.round.remaining.length === 0) return { ok: false, error: 'no slips left' };
  drawNextSlip(room);
  armTimer(room, room.config.turnSeconds * 1000, onTimeout);
  return { ok: true };
}

function armTimer(room, durationMs, onTimeout) {
  const now = Date.now();
  room.round.turnEndsAt = now + durationMs;
  room.round.paused = false;
  room.round.pauseReason = null;
  clearTimer(room);
  room.round.timeoutHandle = setTimeout(() => onTimeout(room), durationMs);
}

/** gap #6: unguessed in-hand slip goes back in the bag on timeout. */
export function timeoutTurn(room) {
  clearTimer(room);
  if (room.round.currentSlipId) {
    room.round.remaining.push(room.round.currentSlipId);
    room.round.currentSlipId = null;
  }
  room.round.turnEndsAt = null;
  endTurnAndAdvance(room);
}

export function correctGuess(room, playerId, slipId, turnId) {
  const check = validateAction(room, playerId, slipId, turnId);
  if (!check.ok) return check;
  room.round.guessed.push(room.round.currentSlipId);
  room.teamScores[room.activeTeam] += 1;
  // per-slip attribution for the end-of-game recap ("scored by"); a slip
  // reused across rounds can be guessed by a different team each round.
  const slip = room.pool[room.round.currentSlipId];
  slip.scoredBy ??= [];
  slip.scoredBy.push({ round: ROUND_PHASES.indexOf(room.phase) + 1, team: room.activeTeam, playerId });
  return afterSlipResolved(room);
}

export function passTurn(room, playerId, slipId, turnId) {
  const check = validateAction(room, playerId, slipId, turnId);
  if (!check.ok) return check;
  if (room.config.allowSkip?.[room.phase] === false) return { ok: false, error: 'pass is disabled this round' };
  room.round.remaining.push(room.round.currentSlipId); // bottom of the stack
  return afterSlipResolved(room);
}

function validateAction(room, playerId, slipId, turnId) {
  if (room.round.drawerId !== playerId) return { ok: false, error: 'not your turn' };
  if (room.round.turnId !== turnId) return { ok: false, error: 'stale turn' }; // gap #9
  if (room.round.currentSlipId !== slipId) return { ok: false, error: 'stale slip' };
  return { ok: true };
}

function afterSlipResolved(room) {
  room.round.currentSlipId = null;
  if (room.round.remaining.length === 0) {
    clearTimer(room);
    room.round.turnEndsAt = null;
    return { ok: true, roundEnded: true };
  }
  drawNextSlip(room);
  return { ok: true };
}

/** Called after a turn ends (timeout) to pick the next drawer or close the round. */
function endTurnAndAdvance(room) {
  if (room.round.remaining.length === 0) {
    finishRound(room);
    return;
  }
  advanceToNextDrawer(room, { toggleTeam: true });
}

function finishRound(room) {
  clearTimer(room);
  const delta = {
    A: room.teamScores.A - room.roundStartScores.A,
    B: room.teamScores.B - room.roundStartScores.B,
  };
  room.roundScores.push(delta);
  // gap #F: leftover time is discarded, deliberately (documented deviation).
  const idx = ROUND_PHASES.indexOf(room.phase);
  if (idx === ROUND_PHASES.length - 1) {
    room.phase = 'SCORES'; // also functions as END: pool + authors now safe to reveal
    room.round.drawerId = null;
    room.round.currentSlipId = null;
    room.round.turnId = null;
    room.round.turnEndsAt = null;
  } else {
    room.phase = ROUND_PHASES[idx + 1];
    startRound(room, { toggleTeam: true });
  }
}

/** Called by the caller (events.js) once it has resolved a turn-ending action
 *  (correct-guess/pass-turn that emptied `remaining`), or directly for timeout. */
export function endTurnIfRoundOver(room, roundEnded) {
  if (roundEnded) endTurnAndAdvance(room);
}

// --- Disconnect / pause / resume / skip (gaps #2, #3, #5, #C, #V) ----------

export function pauseForDisconnectedDrawer(room) {
  clearTimer(room);
  // mid-turn: bank the time left. awaiting-start (no turnEndsAt yet): leave
  // remainingMsAtPause null so resume gives a full turn. Either way mark it
  // paused so the UI shows a "waiting for X" banner instead of silently
  // stalling on a drawer who's never going to tap start.
  room.round.remainingMsAtPause = room.round.turnEndsAt ? room.round.turnEndsAt - Date.now() : null;
  room.round.turnEndsAt = null;
  room.round.paused = true;
  room.round.pauseReason = 'drawer-disconnected';
}

/** When a round pause was 'no-connected-players' (a turn transition landed
 *  while both teams were fully offline) and someone has since reconnected,
 *  reassign a drawer so the game isn't stuck forever. Only touches that
 *  specific stranded state — a normal 'drawer-disconnected' pause still waits
 *  for that drawer or a host skip. Safe re: the in-hand slip: the
 *  no-connected-players state is only ever reached from advanceToNextDrawer,
 *  at which point there is no slip in hand. Returns true if it recovered. */
export function recoverStrandedTurn(room) {
  if (!ROUND_PHASES.includes(room.phase)) return false;
  if (room.round.pauseReason !== 'no-connected-players') return false;
  advanceToNextDrawer(room, { toggleTeam: false });
  return !room.round.paused;
}

/** gap #2: on boot, never trust a persisted turnEndsAt — force a pause and
 *  let the drawer explicitly resume once everyone's back. */
export function pauseForBootRecovery(room) {
  if (!ROUND_PHASES.includes(room.phase)) return;
  clearTimer(room);
  if (room.round.turnEndsAt) {
    room.round.remainingMsAtPause = Math.max(1000, room.round.turnEndsAt - Date.now());
  } else if (!room.round.remainingMsAtPause) {
    room.round.remainingMsAtPause = room.config.turnSeconds * 1000;
  }
  room.round.turnEndsAt = null;
  room.round.paused = true;
  room.round.pauseReason = 'server-restarted';
}

export function resumeTurn(room, playerId, onTimeout) {
  if (room.round.drawerId !== playerId) return { ok: false, error: 'only the drawer can resume' };
  if (!room.round.paused) return { ok: false, error: 'not paused' };
  const ms = room.round.remainingMsAtPause || room.config.turnSeconds * 1000;
  // no slip in hand after boot/disconnect pause with none drawn yet -> draw one
  if (!room.round.currentSlipId && room.round.remaining.length > 0) drawNextSlip(room);
  armTimer(room, ms, onTimeout);
  return { ok: true };
}

/** gap #5/#V: host (or fallback any connected player) skips a stuck/AFK drawer. */
export function skipDrawer(room) {
  clearTimer(room);
  if (room.round.currentSlipId) {
    room.round.remaining.push(room.round.currentSlipId);
    room.round.currentSlipId = null;
  }
  room.round.turnEndsAt = null;
  room.round.remainingMsAtPause = null;
  advanceToNextDrawer(room, { toggleTeam: false }); // same team gets another drawer
}

/** Host escape hatch for a team that's stuck/unreachable (technical issues,
 * everyone on that side dropped, etc.) — ends the turn outright and hands it
 * to the other team, same as a timeout would, but immediate and host-triggered. */
export function forcePassTeam(room) {
  clearTimer(room);
  if (room.round.currentSlipId) {
    room.round.remaining.push(room.round.currentSlipId);
    room.round.currentSlipId = null;
  }
  room.round.turnEndsAt = null;
  room.round.remainingMsAtPause = null;
  advanceToNextDrawer(room, { toggleTeam: true }); // other team gets the next drawer
}

export function endGameNow(room) {
  clearTimer(room);
  room.phase = 'SCORES';
}
