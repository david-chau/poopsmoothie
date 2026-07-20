// Dev-only: fills a room with fake players so you can test with fewer than
// 4 real devices. Bots auto-submit words and auto-play their turn (random
// correct/pass) so the game keeps moving without a human on that device.
//
// Usage: npm run bots -- <ROOMCODE> [count]
import { io } from 'socket.io-client';

const [, , roomCodeArg, countArg] = process.argv;
const roomCode = (roomCodeArg || '').toUpperCase();
const count = Number(countArg) || 2;

if (!roomCode) {
  console.error('usage: npm run bots -- <ROOMCODE> [count]');
  process.exit(1);
}

const URL = process.env.SERVER_URL || 'http://localhost:4321';
const ack = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload ?? {}, resolve));

const WORDS = [
  'banana', 'thunder', 'pickle', 'gravity', 'lantern', 'compass', 'velvet',
  'marble', 'ocean', 'cactus', 'penguin', 'volcano', 'ribbon', 'engine', 'harbor',
];
const randomWord = () => `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${Math.floor(Math.random() * 1000)}`;

function makeBot(name) {
  const socket = io(URL);
  let me = null;
  let submitted = false;
  let turnStartAttempted = false;

  socket.on('connect', async () => {
    if (me) return;
    const res = await ack(socket, 'join-room', { roomCode, name });
    if (!res.ok) return console.error(`[${name}] join failed: ${res.error}`);
    me = res.playerId;
    console.log(`[${name}] joined`);
  });

  socket.on('state', async (state) => {
    if (!me) return;

    if (state.phase === 'WRITING' && !submitted && !state.submittedPlayerIds.includes(me)) {
      submitted = true;
      const words = Array.from({ length: state.config.wordsPerPlayer }, randomWord);
      const res = await ack(socket, 'submit-words', { words });
      console.log(`[${name}] submitted ${words.length} words: ${res.ok}`);
      if (!res.ok) submitted = false;
    }

    if (state.round.drawerId !== me) {
      turnStartAttempted = false;
      return;
    }
    if (!state.round.paused && !state.round.turnEndsAt && !turnStartAttempted) {
      turnStartAttempted = true;
      await new Promise((r) => setTimeout(r, 500));
      await ack(socket, 'start-turn');
      console.log(`[${name}] started their turn`);
    }
  });

  socket.on('slip-revealed', async ({ slip, turnId }) => {
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
    const correct = Math.random() < 0.85;
    await ack(socket, correct ? 'correct-guess' : 'pass-turn', { slipId: slip.id, turnId });
    console.log(`[${name}] ${correct ? 'guessed' : 'passed'}: "${slip.text}"`);
  });

  return socket;
}

console.log(`adding ${count} bot(s) to room ${roomCode}...`);
const bots = Array.from({ length: count }, (_, i) => makeBot(`Bot${i + 1}`));

process.on('SIGINT', () => {
  bots.forEach((s) => s.disconnect());
  process.exit(0);
});
