// Dev-only CLI: fills a room with fake players so you can test with fewer than
// 4 real devices. Bot behavior lives in server/bot.js (also covered by bot.test.mjs).
//
// Usage: npm run bots -- <ROOMCODE> [count]
import { createBot } from '../server/bot.js';

const [, , roomCodeArg, countArg] = process.argv;
const roomCode = (roomCodeArg || '').toUpperCase();
const count = Number(countArg) || 2;

if (!roomCode) {
  console.error('usage: npm run bots -- <ROOMCODE> [count]');
  process.exit(1);
}

const url = process.env.SERVER_URL || 'http://localhost:4321';
console.log(`adding ${count} bot(s) to room ${roomCode}...`);

const bots = Array.from({ length: count }, (_, i) =>
  createBot({ url, roomCode, name: `Bot${i + 1}`, onLog: (m) => console.log(m) }),
);

process.on('SIGINT', () => {
  bots.forEach((b) => b.socket.disconnect());
  process.exit(0);
});
