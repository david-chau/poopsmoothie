// Importable bot factory (see scripts/dev-bots.mjs for the CLI wrapper,
// scripts/bot.test.mjs for the integration test). A bot joins a room, auto-submits words, and
// auto-plays its turn (start -> guess/pass) so a game can run with fewer real
// devices than players.
import { io } from 'socket.io-client';

// Fallback pool only. Bots normally pull from server/suggestions.js via the
// same `suggest-words` event the 🎲 buttons use, so their words are real
// phrases and are de-duplicated against the rest of the room.
const WORDS = [
  'banana', 'thunder', 'pickle', 'gravity', 'lantern', 'compass', 'velvet',
  'marble', 'ocean', 'cactus', 'penguin', 'volcano', 'ribbon', 'engine', 'harbor',
];
/** Last resort only — see botWords(). The numeric suffix exists purely to keep
 *  these unique when the real suggestion pool has run dry. */
const fallbackWord = () => `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${Math.floor(Math.random() * 1000)}`;

/** Ask the server for real suggestions, exactly as a human tapping 🎲 does.
 *  Same code path, so bots get playable words *and* the server's de-duplication
 *  against everything already submitted in the room — two bots can't both write
 *  "Hedgehog". Padded from the fallback list only if the pool is exhausted, so
 *  a submit always has the exact count the room expects. */
async function botWords(ack, socket, count) {
  const res = await ack(socket, 'suggest-words', { count });
  const words = Array.isArray(res?.words) ? res.words.slice(0, count) : [];
  while (words.length < count) words.push(fallbackWord());
  return words;
}
const ack = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload ?? {}, resolve));
const noop = () => {};

/**
 * @param {object} opts
 * @param {string} opts.url          server URL
 * @param {string} opts.roomCode     room to join
 * @param {string} opts.name         display name
 * @param {(msg: string) => void} [opts.onLog]  log sink (default: silent)
 * @param {number} [opts.startDelayMs] delay before tapping "start turn"
 * @param {number} [opts.guessDelayMs] delay before answering each slip
 * @param {number} [opts.correctProbability] chance of "correct" vs "pass" (0..1)
 * @param {string} [opts.botToken] one-time token from bots.js, so the server can
 *        flag this join as a bot at the moment it lands (CLI bots don't get one)
 * @returns {{ socket: import('socket.io-client').Socket, getId: () => string|null }}
 */
export function createBot({
  url,
  roomCode,
  name,
  botToken,
  onLog = noop,
  startDelayMs = 500,
  guessDelayMs = 900,
  correctProbability = 0.85,
}) {
  const socket = io(url, { forceNew: true });
  let me = null;
  let submitted = false;
  let turnStartAttempted = null; // turnId we last tried to start
  let lastState = null;

  socket.on('connect', async () => {
    if (me) return; // reconnect: keep existing identity, don't re-join
    const res = await ack(socket, 'join-room', { roomCode, name, botToken });
    if (!res.ok) return onLog(`[${name}] join failed: ${res.error}`);
    me = res.playerId;
    onLog(`[${name}] joined`);
  });

  socket.on('state', async (state) => {
    lastState = state;
    if (!me) return;

    if (state.phase === 'WRITING' && !submitted && !state.submittedPlayerIds.includes(me)) {
      submitted = true;
      const words = await botWords(ack, socket, state.config.wordsPerPlayer);
      const res = await ack(socket, 'submit-words', { words });
      onLog(`[${name}] submitted ${words.length} words: ${res.ok}`);
      if (!res.ok) submitted = false;
    }

    // rounds 2 and 3 open behind a ready gate; a bot that never readies would
    // hold the whole table there until the host force-started every round
    if (state.round.awaitingReady) {
      if (!state.round.readyPlayerIds?.includes(me)) await ack(socket, 'player-ready');
      // Nothing else while the gate is shut. Falling through used to be fatal:
      // an already-ready bot that was also the next drawer would call
      // start-turn, get refused by the gate, and mark the attempt as done —
      // then never retry once the round actually opened.
      return;
    }

    if (state.round.drawerId !== me) {
      turnStartAttempted = null;
      return;
    }
    // keyed on turnId rather than a sticky boolean, so a refused attempt can
    // never wedge the bot for the rest of the game
    if (!state.round.paused && !state.round.turnEndsAt && turnStartAttempted !== state.round.turnId) {
      turnStartAttempted = state.round.turnId;
      if (startDelayMs) await new Promise((r) => setTimeout(r, startDelayMs));
      const res = await ack(socket, 'start-turn');
      if (!res.ok) turnStartAttempted = null; // let the next state event try again
      onLog(`[${name}] started their turn: ${res.ok}`);
    }
  });

  socket.on('slip-revealed', async ({ slip, turnId }) => {
    if (guessDelayMs) await new Promise((r) => setTimeout(r, guessDelayMs));
    // only pass when the current round actually allows it — otherwise the pass
    // is rejected server-side and the bot would stall holding the same slip
    const passAllowed = lastState?.config?.allowSkip?.[lastState.phase] !== false;
    const wantPass = passAllowed && Math.random() > correctProbability;
    const event = wantPass ? 'pass-turn' : 'correct-guess';
    await ack(socket, event, { slipId: slip.id, turnId });
    onLog(`[${name}] ${wantPass ? 'passed' : 'guessed'}: "${slip.text}"`);
  });

  return { socket, getId: () => me };
}
