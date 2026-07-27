import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterUtterances, SettleBuffer, cosineSimilarity, matchEnrolledSpeaker } from './arbiter.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Defaults for a plausible utterance; override just what a test cares about. */
function utt(over) {
  return { playerId: 'p1', text: 'whale', energy: 0.5, t0: 1000, t1: 1500, ...over };
}

test('no utterances in, nothing out', () => {
  assert.deepEqual(clusterUtterances([]), []);
});

test('a single utterance passes through untouched, with nobody merged into it', () => {
  const [result] = clusterUtterances([utt({ playerId: 'p1' })]);
  assert.equal(result.playerId, 'p1');
  assert.equal(result.text, 'whale');
  assert.deepEqual(result.mergedFrom, []);
});

test('two mics hearing the same shout collapse into one message, attributed to the louder capture', () => {
  const results = clusterUtterances([
    utt({ playerId: 'quiet-phone', energy: 0.3, t0: 1000, t1: 1400 }),
    utt({ playerId: 'loud-phone', energy: 0.9, t0: 1050, t1: 1450 }),
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].playerId, 'loud-phone');
  assert.deepEqual(results[0].mergedFrom, ['quiet-phone']);
});

test('overlapping but genuinely different speech is not merged', () => {
  const results = clusterUtterances([
    utt({ playerId: 'a', text: 'is it a whale', t0: 1000, t1: 1500 }),
    utt({ playerId: 'b', text: 'pass the salt', t0: 1050, t1: 1550 }),
  ]);
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((r) => r.playerId).sort(),
    ['a', 'b'],
  );
});

test('the same word said again much later is a new message, not a duplicate of the first', () => {
  // a real scenario in this game: "banana" guessed in one turn, "banana" said
  // again as a fresh guess in a later turn — time apart, must not collapse
  const results = clusterUtterances([
    utt({ playerId: 'a', text: 'banana', t0: 1000, t1: 1400 }),
    utt({ playerId: 'a', text: 'banana', t0: 60_000, t1: 60_400 }),
  ]);
  assert.equal(results.length, 2);
});

test('clustering is transitive: A overlaps B, B overlaps C, so all three collapse to one', () => {
  const results = clusterUtterances([
    // shares {is,it,a,big,whale} with b (4/6 = 0.67) but not enough with c alone (2/7 = 0.29)
    utt({ playerId: 'a', text: 'is it a big whale', energy: 0.4, t0: 1000, t1: 1600 }),
    // bridges both: 4/6 = 0.67 with a, and 3/6 = 0.5 with c
    utt({ playerId: 'b', text: 'is it a whale maybe', energy: 0.9, t0: 1300, t1: 1900 }),
    utt({ playerId: 'c', text: 'a whale maybe indeed', energy: 0.2, t0: 1700, t1: 2200 }),
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].playerId, 'b'); // highest energy
  assert.deepEqual(results[0].mergedFrom.sort(), ['a', 'c']);
});

test('tiebreak cascade: energy, then confidence, then longer text, then earliest arrival', () => {
  // equal energy -> confidence decides
  let [byConfidence] = clusterUtterances([
    utt({ playerId: 'a', energy: 0.5, confidence: 0.6, t0: 1000, t1: 1400 }),
    utt({ playerId: 'b', energy: 0.5, confidence: 0.9, t0: 1000, t1: 1400 }),
  ]);
  assert.equal(byConfidence.playerId, 'b');

  // equal energy and confidence -> longer transcript decides (similar enough
  // to cluster in the first place: 4/5 token overlap, just one extra word)
  let [byLength] = clusterUtterances([
    utt({ playerId: 'a', energy: 0.5, text: 'is it a whale', t0: 1000, t1: 1400 }),
    utt({ playerId: 'b', energy: 0.5, text: 'is it a whale maybe', t0: 1000, t1: 1400 }),
  ]);
  assert.equal(byLength.playerId, 'b');

  // everything equal -> earliest t0 wins, deterministically
  let [byArrival] = clusterUtterances([
    utt({ playerId: 'a', energy: 0.5, text: 'whale', t0: 1010, t1: 1400 }),
    utt({ playerId: 'b', energy: 0.5, text: 'whale', t0: 1000, t1: 1400 }),
  ]);
  assert.equal(byArrival.playerId, 'b');
});

test('output is chronological regardless of input order', () => {
  const results = clusterUtterances([
    utt({ playerId: 'late', text: 'second thing', t0: 5000, t1: 5400 }),
    utt({ playerId: 'early', text: 'first thing', t0: 1000, t1: 1400 }),
  ]);
  assert.deepEqual(
    results.map((r) => r.playerId),
    ['early', 'late'],
  );
});

test('punctuation and case differences between two captures of the same word still merge', () => {
  const results = clusterUtterances([
    utt({ playerId: 'a', text: 'Whale!', t0: 1000, t1: 1400 }),
    utt({ playerId: 'b', text: 'whale', t0: 1020, t1: 1420 }),
  ]);
  assert.equal(results.length, 1);
});

test('CJK text without whitespace still compares token-by-character, not as one opaque string', () => {
  const results = clusterUtterances([
    utt({ playerId: 'a', text: '那是鲸鱼', t0: 1000, t1: 1400 }), // "that's a whale"
    utt({ playerId: 'b', text: '是鲸鱼', t0: 1020, t1: 1420 }), // missing the first character
  ]);
  assert.equal(results.length, 1);
});

test('a similarity threshold can be tightened or loosened by the caller', () => {
  const inputs = [
    utt({ playerId: 'a', text: 'is it a whale', t0: 1000, t1: 1500 }),
    utt({ playerId: 'b', text: 'is it a fish', t0: 1050, t1: 1550 }), // 3 of 4 tokens shared
  ];
  const loose = clusterUtterances(inputs, { similarityThreshold: 0.3 });
  const strict = clusterUtterances(inputs, { similarityThreshold: 0.9 });
  assert.equal(loose.length, 1);
  assert.equal(strict.length, 2);
});

// --- SettleBuffer: the real-time batching wrapper around the pure logic ----

test('SettleBuffer batches quick submissions into one flush after the window', async () => {
  const flushed = [];
  const buf = new SettleBuffer((r) => flushed.push(r), { windowMs: 20 });
  buf.submit(utt({ playerId: 'a', energy: 0.9, t0: 0, t1: 400 }));
  buf.submit(utt({ playerId: 'b', energy: 0.1, t0: 10, t1: 410 }));
  assert.equal(flushed.length, 0); // nothing yet — still inside the window

  await wait(40);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].playerId, 'a');
});

test('SettleBuffer.flushNow emits immediately without waiting out the window', () => {
  const flushed = [];
  const buf = new SettleBuffer((r) => flushed.push(r), { windowMs: 10_000 });
  buf.submit(utt({ playerId: 'a' }));
  buf.flushNow();
  assert.equal(flushed.length, 1);
});

test('flushNow on an empty buffer is a harmless no-op', () => {
  const flushed = [];
  const buf = new SettleBuffer((r) => flushed.push(r));
  assert.doesNotThrow(() => buf.flushNow());
  assert.equal(flushed.length, 0);
});

test('a new submission after a flush starts a fresh window rather than being stuck', async () => {
  const flushed = [];
  const buf = new SettleBuffer((r) => flushed.push(r), { windowMs: 15 });
  buf.submit(utt({ playerId: 'first', t0: 0, t1: 400 }));
  await wait(30);
  assert.equal(flushed.length, 1);

  buf.submit(utt({ playerId: 'second', t0: 1000, t1: 1400 }));
  await wait(30);
  assert.equal(flushed.length, 2);
  assert.equal(flushed[1].playerId, 'second');
});

// --- cosineSimilarity / matchEnrolledSpeaker: pure vector math, synthetic
// vectors throughout — no model, no audio, no native addon needed -----------

test('cosineSimilarity: identical vectors score 1, opposite vectors score -1', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 2, 3], [-1, -2, -3]), -1);
});

test('cosineSimilarity: orthogonal vectors score 0', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity: scale-invariant — only direction matters', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [2, 4, 6]), 1); // same direction, 2x magnitude
});

test('cosineSimilarity: a zero vector never divides by zero into NaN', () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
});

test('matchEnrolledSpeaker: no embedding or no enrollment means no match', () => {
  assert.equal(matchEnrolledSpeaker(null, new Map([['david', [1, 0, 0]]])), null);
  assert.equal(matchEnrolledSpeaker([1, 0, 0], null), null);
  assert.equal(matchEnrolledSpeaker([1, 0, 0], new Map()), null);
});

test('matchEnrolledSpeaker: a confident match returns that player', () => {
  const enrolled = new Map([
    ['david', [1, 0, 0]],
    ['jill', [0, 1, 0]],
  ]);
  assert.equal(matchEnrolledSpeaker([0.9, 0.1, 0], enrolled), 'david');
});

test('matchEnrolledSpeaker: picks the BEST match among several, not just the first', () => {
  const enrolled = new Map([
    ['alice', [1, 0, 0]],
    ['bob', [0.9, 0.1, 0]], // closer to the query than alice
    ['carol', [0, 0, 1]],
  ]);
  assert.equal(matchEnrolledSpeaker([0.85, 0.15, 0], enrolled), 'bob');
});

test('matchEnrolledSpeaker: below threshold is treated as unenrolled, not a forced guess', () => {
  const enrolled = new Map([['david', [1, 0, 0]]]);
  const barelySimilar = [0.4, 0.9, 0]; // some overlap, but not really David
  assert.equal(matchEnrolledSpeaker(barelySimilar, enrolled, 0.9), null);
  assert.equal(matchEnrolledSpeaker(barelySimilar, enrolled, 0.1), 'david'); // a looser caller-supplied threshold accepts it
});
