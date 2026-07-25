// Importable bot factory (see scripts/dev-bots.mjs for the CLI wrapper,
// scripts/bot.test.mjs for the integration test). A bot joins a room, auto-submits words, and
// auto-plays its turn (start -> guess/pass) so a game can run with fewer real
// devices than players.
import { io } from 'socket.io-client';

const WORDS = [
  'banana', 'thunder', 'pickle', 'gravity', 'lantern', 'compass', 'velvet',
  'marble', 'ocean', 'cactus', 'penguin', 'volcano', 'ribbon', 'engine', 'harbor',
];
const randomWord = () => `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${Math.floor(Math.random() * 1000)}`;
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
  let turnStartAttempted = false;
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
      const words = Array.from({ length: state.config.wordsPerPlayer }, randomWord);
      const res = await ack(socket, 'submit-words', { words });
      onLog(`[${name}] submitted ${words.length} words: ${res.ok}`);
      if (!res.ok) submitted = false;
    }

    if (state.round.drawerId !== me) {
      turnStartAttempted = false;
      return;
    }
    if (!state.round.paused && !state.round.turnEndsAt && !turnStartAttempted) {
      turnStartAttempted = true;
      if (startDelayMs) await new Promise((r) => setTimeout(r, startDelayMs));
      await ack(socket, 'start-turn');
      onLog(`[${name}] started their turn`);
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
