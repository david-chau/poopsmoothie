import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

// isolate persistence to its own temp dir, same reasoning as events.test.js
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-events-voice-'));
// the real cross-device dedup buffer holds a voice message for ~0.8s before
// posting it (server/arbiter.js's SettleBuffer) — shrunk here so these tests
// don't spend most of a second waiting per assertion; production keeps the real default
process.env.PS_VOICE_SETTLE_MS = '20';
const { registerSocketHandlers } = await import('./events.js');

/** A stub engine with the same shape as stt.js's real createEngine() output,
 *  so events.js is exercised exactly as index.js would drive it — without a
 *  native addon or model files. Each session hands back whatever text this
 *  test queues up for it, decoupling "does the wiring work" from "does the
 *  ASR work" (the latter is stt.test.js's job). */
function stubEngine() {
  const sessions = [];
  return {
    sessions,
    createSession({ language, onFinal, onWarn }) {
      const session = { closed: false, framesReceived: [], language, onFinal, onWarn };
      session.pushFrame = (int16) => session.framesReceived.push(int16);
      session.close = () => {
        session.closed = true;
      };
      sessions.push(session);
      return session;
    },
    // overridden per-test where enrollment content actually matters; this
    // default is enough for tests that only care that the wiring runs
    computeEnrollment: (int16) => Float32Array.from(int16, (v) => v / 32768),
  };
}

let httpServer;
let io;
let url;
let engine;
const clients = [];

before(async () => {
  httpServer = createServer();
  io = new Server(httpServer);
  engine = stubEngine();
  io.on('connection', (socket) => registerSocketHandlers(io, socket, engine));
  await new Promise((r) => httpServer.listen(0, r));
  url = `http://localhost:${httpServer.address().port}`;
});

after(() => {
  clients.forEach((c) => c.disconnect());
  io.close();
  httpServer.close();
});

function connect() {
  return new Promise((resolve) => {
    const c = ioClient(url, { reconnection: false, forceNew: true });
    c.on('are-you-there', (cb) => cb?.());
    clients.push(c);
    c.once('connect', () => resolve(c));
  });
}
const ack = (c, event, payload) => new Promise((r) => c.emit(event, payload ?? {}, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function chatLogOf(socket) {
  const log = [];
  socket.on('chat-message', (m) => log.push(m));
  return log;
}

function latestStateOf(socket) {
  let state = null;
  socket.on('state', (s) => (state = s));
  return () => state;
}

async function fullRoomToRound1() {
  const socks = await Promise.all([connect(), connect(), connect(), connect()]);
  const create = await ack(socks[0], 'create-room', { name: 'Host' });
  for (let i = 1; i < 4; i++) await ack(socks[i], 'join-room', { roomCode: create.roomCode, name: `P${i}` });
  // chatEnabled defaults off (opt-in per room) — every test in this file is
  // specifically about chat/voice, so turn it on once here rather than per-test
  await ack(socks[0], 'set-config', { wordsPerPlayer: 1, turnSeconds: 60, chatEnabled: true });
  await ack(socks[0], 'start-game');
  for (let i = 0; i < 4; i++) await ack(socks[i], 'submit-words', { words: [`w${i}`] });
  await wait(120);
  return { socks, roomCode: create.roomCode };
}

test('mic-on is rejected outside a live round', async () => {
  const c = await connect();
  await ack(c, 'create-room', { name: 'Solo' });
  await ack(c, 'set-config', { chatEnabled: true }); // isolate the round-phase gate from the chatEnabled one
  const res = await ack(c, 'mic-on');
  assert.equal(res.ok, false);
  assert.match(res.error, /no round in progress/);
});

test('mic-on succeeds mid-round and a decoded segment is broadcast as a voice chat message', async () => {
  const { socks } = await fullRoomToRound1();
  const log = chatLogOf(socks[1]); // any socket in the room hears it, not just the speaker's own

  const on = await ack(socks[0], 'mic-on');
  assert.equal(on.ok, true);
  assert.equal(engine.sessions.length, 1);

  // simulate the ASR pipeline finishing a segment for this socket — real
  // sessions always pass timing/energy metadata too (see stt.js), which the
  // room's dedup buffer needs even when there's nobody to dedup against
  const now = Date.now();
  engine.sessions[0].onFinal('sounds like a whale', { energy: 0.4, t0: now - 500, t1: now });
  await wait(60); // settle window (shrunk to 20ms for this file) plus flush

  assert.equal(log.length, 1);
  assert.equal(log[0].via, 'voice');
  assert.equal(log[0].text, 'sounds like a whale');
  assert.equal(log[0].name, 'Host');
  assert.equal(typeof log[0].id, 'string');
});

test('mic-on uses the room\'s configured voice language, defaulting to English', async () => {
  const { socks } = await fullRoomToRound1(); // never explicitly set voiceLanguage
  await ack(socks[0], 'mic-on');
  assert.equal(engine.sessions.at(-1).language, 'en');
});

test('switching the room to Chinese changes the language new mic sessions start with', async () => {
  const { socks } = await fullRoomToRound1();
  assert.equal((await ack(socks[0], 'set-config', { voiceLanguage: 'zh' })).ok, true);

  await ack(socks[0], 'mic-on');
  assert.equal(engine.sessions.at(-1).language, 'zh');
});

test('an unknown voice language is rejected by set-config', async () => {
  const { socks } = await fullRoomToRound1();
  const res = await ack(socks[0], 'set-config', { voiceLanguage: 'fr' });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown voice language/);
});

test('two players\' mics catching the same shout collapse into one message, not two', async () => {
  const { socks } = await fullRoomToRound1();
  const log = chatLogOf(socks[2]);

  const before = engine.sessions.length; // engine.sessions accumulates across every test in this file
  await ack(socks[0], 'mic-on'); // Host's phone
  await ack(socks[1], 'mic-on'); // P1's phone, standing right next to them
  const [hostSession, p1Session] = engine.sessions.slice(before);

  const now = Date.now();
  // both phones heard the same "is it a whale", P1's phone picked it up louder
  hostSession.onFinal('is it a whale', { energy: 0.3, t0: now - 400, t1: now });
  p1Session.onFinal('is it a whale', { energy: 0.8, t0: now - 380, t1: now + 20 });
  await wait(60);

  assert.equal(log.length, 1);
  assert.equal(log[0].text, 'is it a whale');
  assert.equal(log[0].name, 'P1'); // the louder capture, not whoever's session fired first
});

test('mic-off closes the native session so no further audio is processed', async () => {
  const { socks } = await fullRoomToRound1();
  await ack(socks[0], 'mic-on');
  const session = engine.sessions.at(-1);
  assert.equal(session.closed, false);

  const off = await ack(socks[0], 'mic-off');
  assert.equal(off.ok, true);
  assert.equal(session.closed, true);
});

test('a segment that finishes decoding after the round has ended is not posted', async () => {
  const { socks } = await fullRoomToRound1();
  await ack(socks[0], 'mic-on');
  const session = engine.sessions.at(-1);
  const log = chatLogOf(socks[0]);

  await ack(socks[0], 'end-game'); // host escape hatch straight to SCORES
  session.onFinal('too late, nobody is drawing anymore');
  await wait(30);

  assert.equal(log.length, 0);
});

test('disconnecting while the mic is on closes the session instead of leaking it', async () => {
  const { socks } = await fullRoomToRound1();
  await ack(socks[0], 'mic-on');
  const session = engine.sessions.at(-1);
  socks[0].disconnect();
  await wait(50);
  assert.equal(session.closed, true);
});

test('audio-frame is ignored for a socket that never turned its mic on', async () => {
  const { socks } = await fullRoomToRound1();
  const before = engine.sessions.length;
  socks[1].emit('audio-frame', new ArrayBuffer(16));
  await wait(30);
  assert.equal(engine.sessions.length, before); // no session was created just from a stray frame
});

test('a real audio-frame reaches the session as an Int16Array of the right length', async () => {
  const { socks } = await fullRoomToRound1();
  await ack(socks[0], 'mic-on');
  const session = engine.sessions.at(-1);

  const samples = new Int16Array([1, -2, 3, -4, 32767, -32768]);
  socks[0].emit('audio-frame', samples.buffer);
  await wait(30);

  assert.equal(session.framesReceived.length, 1);
  assert.deepEqual(Array.from(session.framesReceived[0]), Array.from(samples));
});

test('an oversized audio-frame is dropped rather than handed to the session', async () => {
  const { socks } = await fullRoomToRound1();
  await ack(socks[0], 'mic-on');
  const session = engine.sessions.at(-1);

  socks[0].emit('audio-frame', new ArrayBuffer(64 * 1024 + 2)); // one Int16 sample past the cap
  await wait(30);

  assert.equal(session.framesReceived.length, 0);
});

test('an odd-length audio-frame (not whole Int16 samples) is dropped', async () => {
  const { socks } = await fullRoomToRound1();
  await ack(socks[0], 'mic-on');
  const session = engine.sessions.at(-1);

  socks[0].emit('audio-frame', new ArrayBuffer(5));
  await wait(30);

  assert.equal(session.framesReceived.length, 0);
});

test('audio-frame is rate-limited per socket', async () => {
  const { socks } = await fullRoomToRound1();
  await ack(socks[0], 'mic-on');
  const session = engine.sessions.at(-1);

  // well past the burst cap (20 per 2s), and far faster than the real ~4/s
  // capture cadence — a legitimate client never gets anywhere near this
  const BURST = 50;
  const frame = new Int16Array(8).buffer;
  for (let i = 0; i < BURST; i++) socks[0].emit('audio-frame', frame);
  await wait(30);

  assert.ok(session.framesReceived.length < BURST, 'excess frames should have been dropped, not all accepted');
  assert.ok(session.framesReceived.length > 0, 'the burst cap should still allow some frames through');
});

// --- enroll-voice: one-shot voiceprint recording, and its readback ----------

test('enroll-voice works even before a round starts, and shows up as voiceEnrolled in state', async () => {
  const c = await connect();
  const getState = latestStateOf(c);
  await ack(c, 'create-room', { name: 'Solo' });
  await ack(c, 'set-config', { chatEnabled: true });
  await wait(30);
  assert.equal(getState().players[0].voiceEnrolled, false);

  const sample = new Int16Array(8000).buffer; // ~0.5s of "recording"
  const res = await ack(c, 'enroll-voice', sample);
  assert.equal(res.ok, true);
  await wait(30);

  assert.equal(getState().players[0].voiceEnrolled, true);
});

test('enroll-voice is rejected when voice capture is unavailable on this server', async () => {
  // a second, engine-less server — mirrors how index.js behaves with no model files
  const bareServer = createServer();
  const bareIo = new Server(bareServer);
  bareIo.on('connection', (socket) => registerSocketHandlers(bareIo, socket, null));
  await new Promise((r) => bareServer.listen(0, r));
  const bareUrl = `http://localhost:${bareServer.address().port}`;
  const c = ioClient(bareUrl, { reconnection: false, forceNew: true });
  await new Promise((r) => c.once('connect', r));

  await ack(c, 'create-room', { name: 'Solo' });
  await ack(c, 'set-config', { chatEnabled: true }); // isolate the "no engine" gate from the chatEnabled one
  const res = await ack(c, 'enroll-voice', new Int16Array(100).buffer);
  assert.equal(res.ok, false);
  assert.match(res.error, /not available/);

  c.disconnect();
  bareIo.close();
  bareServer.close();
});

test('an oversized enrollment recording is rejected', async () => {
  const c = await connect();
  await ack(c, 'create-room', { name: 'Solo' });
  await ack(c, 'set-config', { chatEnabled: true });
  const res = await ack(c, 'enroll-voice', new ArrayBuffer(320 * 1024 + 2));
  assert.equal(res.ok, false);
  assert.match(res.error, /invalid/);
});

test('a failure inside computeEnrollment is caught, not crashed, and reported to the caller', async () => {
  const c = await connect();
  await ack(c, 'create-room', { name: 'Solo' });
  await ack(c, 'set-config', { chatEnabled: true });
  const originalCompute = engine.computeEnrollment;
  engine.computeEnrollment = () => {
    throw new Error('embedding model exploded');
  };
  const res = await ack(c, 'enroll-voice', new Int16Array(100).buffer);
  assert.equal(res.ok, false);
  assert.match(res.error, /could not process/);
  engine.computeEnrollment = originalCompute;
});

// --- embedding override: the actual "David on Jill's phone" scenario -------

test('a confident voice match overrides device-prior attribution', async () => {
  const { socks } = await fullRoomToRound1();
  const log = chatLogOf(socks[2]);

  // "David" (P1) enrolls his voice ahead of time
  const david = socks[1]; // P1
  engine.computeEnrollment = () => new Float32Array([1, 0, 0]);
  await ack(david, 'enroll-voice', new Int16Array(100).buffer);

  // ...but it's HOST's phone (socks[0]) that actually captures the audio —
  // David's phone was in his pocket. The embedding says otherwise.
  await ack(socks[0], 'mic-on');
  const session = engine.sessions.at(-1);
  const now = Date.now();
  session.onFinal('is it a whale', { energy: 0.5, t0: now - 400, t1: now, embedding: [0.95, 0.05, 0] });
  await wait(60);

  assert.equal(log.length, 1);
  assert.equal(log[0].name, 'P1'); // attributed to David (P1), not Host whose phone captured it
});

test('an unmatched embedding falls back to whoever\'s device actually captured it', async () => {
  const { socks } = await fullRoomToRound1();
  const log = chatLogOf(socks[2]);

  engine.computeEnrollment = () => new Float32Array([1, 0, 0]);
  await ack(socks[1], 'enroll-voice', new Int16Array(100).buffer); // P1 enrolled

  await ack(socks[0], 'mic-on'); // Host's phone captures someone else entirely
  const session = engine.sessions.at(-1);
  const now = Date.now();
  session.onFinal('pass the salt', { energy: 0.5, t0: now - 400, t1: now, embedding: [0, 1, 0] }); // nothing like P1's print
  await wait(60);

  assert.equal(log.length, 1);
  assert.equal(log[0].name, 'Host'); // no confident match — device-prior wins, as it does with nobody enrolled
});

// --- chatEnabled: the whole feature is a per-room opt-in --------------------

test('chat-send is rejected once the host turns chat off, even mid-round', async () => {
  const { socks } = await fullRoomToRound1(); // chatEnabled: true by default in this helper
  assert.equal((await ack(socks[0], 'set-config', { chatEnabled: false })).ok, true);

  const res = await ack(socks[1], 'chat-send', { text: 'hello?' });
  assert.equal(res.ok, false);
  assert.match(res.error, /turned off/);
});

test('mic-on is rejected once chat is turned off', async () => {
  const { socks } = await fullRoomToRound1();
  await ack(socks[0], 'set-config', { chatEnabled: false });

  const res = await ack(socks[0], 'mic-on');
  assert.equal(res.ok, false);
  assert.match(res.error, /turned off/);
});

test('a lingering mic session stops producing messages the moment chat is turned off', async () => {
  const { socks } = await fullRoomToRound1();
  const log = chatLogOf(socks[1]);

  await ack(socks[0], 'mic-on'); // starts while chat is still on
  const session = engine.sessions.at(-1);
  await ack(socks[0], 'set-config', { chatEnabled: false }); // host flips it off mid-stream

  const now = Date.now();
  session.onFinal('anyone still listening', { energy: 0.5, t0: now - 400, t1: now });
  await wait(60);

  assert.equal(log.length, 0); // onFinal's own chatEnabled re-check swallows it
});

test('audio-frame is dropped once chat is off, even for a socket whose session never closed', async () => {
  const { socks } = await fullRoomToRound1();
  await ack(socks[0], 'mic-on');
  const session = engine.sessions.at(-1);
  await ack(socks[0], 'set-config', { chatEnabled: false });

  socks[0].emit('audio-frame', new Int16Array(8).buffer);
  await wait(30);

  assert.equal(session.framesReceived.length, 0);
});

test('a voice message already settling is dropped if chat gets turned off before it flushes', async () => {
  const { socks } = await fullRoomToRound1();
  const log = chatLogOf(socks[1]);

  await ack(socks[0], 'mic-on');
  const session = engine.sessions.at(-1);
  const now = Date.now();
  session.onFinal('about to get cut off', { energy: 0.5, t0: now - 400, t1: now });
  // the settle window is 20ms in this file (PS_VOICE_SETTLE_MS) — turn chat
  // off in the same tick, before it has a chance to flush
  await ack(socks[0], 'set-config', { chatEnabled: false });
  await wait(60);

  assert.equal(log.length, 0); // deliverVoiceMessage's own chatEnabled re-check catches it
});

test('enroll-voice is rejected once chat is off', async () => {
  const { socks } = await fullRoomToRound1();
  await ack(socks[0], 'set-config', { chatEnabled: false });

  const res = await ack(socks[0], 'enroll-voice', new Int16Array(100).buffer);
  assert.equal(res.ok, false);
  assert.match(res.error, /turned off/);
});

test('chatEnabled defaults off and can be toggled anytime, unlike the locked settings', async () => {
  const host = await connect();
  const getState = latestStateOf(host);
  await ack(host, 'create-room', { name: 'Host' });
  await wait(30);
  assert.equal(getState().config.chatEnabled, false);

  // mid-round, not just in the lobby — same door-not-a-lock behavior as hotJoin
  const { socks } = await fullRoomToRound1();
  assert.equal((await ack(socks[0], 'set-config', { chatEnabled: false })).ok, true);
  await wait(30);
  assert.equal((await ack(socks[0], 'chat-send', { text: 'nope' })).ok, false);
});
