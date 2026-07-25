// End-to-end test against the REAL Docker image — builds it, runs a full game
// through bots, and verifies crash recovery survives an actual container
// restart. Slow + needs Docker, so it's NOT part of `npm test`; run it with:
//
//   npm run test:e2e
//
// It uses its own image tag, container name, host port, and a throwaway data
// dir, so it never collides with a running dev container or your real ./data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { io } from 'socket.io-client';
import { createBot } from '../server/bot.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'poopsmoothie:e2e';
const NAME = 'poopsmoothie-e2e';
const PORT = 4399; // deliberately not 4321, so a running dev/compose stack is untouched
const URL = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-e2e-data-'));

function docker(args, opts = {}) {
  // stdio:'inherit' (used for the build so it streams) makes execFileSync
  // return null — only stringify when output was actually piped back.
  const out = execFileSync('docker', args, { stdio: 'pipe', ...opts });
  return out ? out.toString().trim() : '';
}
function dockerAvailable() {
  try {
    docker(['--version']);
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = dockerAvailable();

const ack = (c, e, p) => new Promise((r) => c.emit(e, p ?? {}, r));
const connect = () =>
  new Promise((res) => {
    const c = io(URL, { reconnection: false, forceNew: true });
    c.once('connect', () => res(c));
  });
function until(get, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const s = get();
      if (s && pred(s)) return resolve(s);
      if (Date.now() - t0 > ms) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 40);
    };
    tick();
  });
}
async function waitHttp(ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${URL}/`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > ms) throw new Error('container did not become healthy');
    await new Promise((r) => setTimeout(r, 300));
  }
}

before(
  () => {
    if (!HAVE_DOCKER) return;
    try {
      docker(['rm', '-f', NAME]); // clear any stale container from a previous run
    } catch {
      /* none */
    }
    docker(['build', '-t', IMAGE, REPO], { stdio: 'inherit' });
    docker(['run', '-d', '--name', NAME, '-p', `${PORT}:4321`, '-v', `${DATA_DIR}:/data`, IMAGE]);
  },
  { timeout: 300000 },
);

after(() => {
  if (HAVE_DOCKER) {
    try {
      docker(['rm', '-f', NAME]);
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('serves the SPA (including the /join/<code> deep link route)', { skip: !HAVE_DOCKER && 'docker not available' }, async () => {
  await waitHttp();
  const root = await fetch(`${URL}/`);
  assert.equal(root.status, 200);
  const join = await fetch(`${URL}/join/ABCD`);
  assert.equal(join.status, 200);
  assert.ok((await join.text()).includes('<div id="root">'), 'join route serves the SPA shell');
});

test('full game: 4 players, bots auto-submit and auto-play, scoring works', { skip: !HAVE_DOCKER && 'docker not available' }, async () => {
  await waitHttp();
  const host = await connect();
  let state = null;
  host.on('state', (s) => (state = s));
  const create = await ack(host, 'create-room', { name: 'Host' });
  assert.equal(create.ok, true);

  const bots = [1, 2, 3].map((i) =>
    createBot({ url: URL, roomCode: create.roomCode, name: `Bot${i}`, startDelayMs: 0, guessDelayMs: 0, correctProbability: 1 }),
  );
  try {
    await until(() => state, (s) => s.players.length === 4);
    await ack(host, 'set-config', { wordsPerPlayer: 1 });
    await ack(host, 'start-game');
    await ack(host, 'submit-words', { words: ['host-word'] });
    await until(() => state, (s) => s.phase === 'ROUND1'); // proves bots auto-submitted

    const before = state.teamScores.B;
    await ack(host, 'force-pass-team'); // hand the turn to a bot team
    await until(() => state, (s) => s.teamScores.B > before); // bot auto-played + scored
    assert.ok(state.teamScores.B > before);
  } finally {
    bots.forEach((b) => b.socket.disconnect());
    host.disconnect();
  }
});

test('crash recovery: a real container restart reloads the game paused, drawer resumes', { skip: !HAVE_DOCKER && 'docker not available', timeout: 60000 }, async () => {
  await waitHttp();

  // set up a game paused mid-turn with the host as the drawer
  const host = await connect();
  let state = null;
  host.on('state', (s) => (state = s));
  const create = await ack(host, 'create-room', { name: 'Host' });
  const bots = [1, 2, 3].map((i) =>
    createBot({ url: URL, roomCode: create.roomCode, name: `Bot${i}`, startDelayMs: 9e9, guessDelayMs: 9e9 }),
  );
  await until(() => state, (s) => s.players.length === 4);
  await ack(host, 'set-config', { wordsPerPlayer: 1, turnSeconds: 120 });
  await ack(host, 'start-game');
  await ack(host, 'submit-words', { words: ['host-word'] });
  await until(() => state, (s) => s.phase === 'ROUND1');
  let guard = 0;
  while (state.round.drawerId !== create.playerId && guard++ < 4) {
    await ack(host, 'force-pass-team');
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(state.round.drawerId, create.playerId, 'host is the drawer');
  await ack(host, 'start-turn');
  await until(() => state, (s) => !!s.round.turnEndsAt); // turn is live
  bots.forEach((b) => b.socket.disconnect());
  host.disconnect();

  // pull the rug — real container restart
  docker(['restart', NAME]);
  await waitHttp();

  // reconnect as the drawer and verify recovery
  const back = await connect();
  let recovered = null;
  back.on('state', (s) => (recovered = s));
  let slip = null;
  back.on('slip-revealed', (p) => (slip = p));
  const rj = await ack(back, 'rejoin', { roomCode: create.roomCode, playerId: create.playerId, secret: create.secret });
  assert.equal(rj.ok, true, 'rejoin after restart works');
  await until(() => recovered, (s) => s.phase === 'ROUND1');

  assert.equal(recovered.round.paused, true, 'reloaded paused');
  assert.equal(recovered.round.pauseReason, 'server-restarted');
  assert.equal(recovered.round.turnEndsAt, null, 'stale timer discarded');
  assert.ok(slip?.slip?.text, 'drawer got their word back');

  const res = await ack(back, 'resume-turn');
  assert.equal(res.ok, true);
  await until(() => recovered, (s) => !s.round.paused && s.round.turnEndsAt > Date.now());
  back.disconnect();
});
