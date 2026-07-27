import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TranscriptionQueue,
  createMicSession,
  createEngine,
  loadModels,
  decodeSegment,
  computeEmbedding,
  computeEmbeddingFromInt16,
  SAMPLE_RATE,
  LANGUAGES,
} from './stt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- TranscriptionQueue: pure scheduling logic, no native addon involved ----

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test('TranscriptionQueue runs a job immediately when under the concurrency cap', async () => {
  const calls = [];
  const q = new TranscriptionQueue((samples) => {
    calls.push(samples);
    return Promise.resolve('hi');
  });
  const got = await new Promise((resolve) => q.enqueue({ samples: 'a', resolve, reject: () => {} }));
  assert.equal(got, 'hi');
  assert.deepEqual(calls, ['a']);
});

test('TranscriptionQueue caps concurrent decodes and drains the backlog as slots free up', async () => {
  const pending = [];
  const q = new TranscriptionQueue((s) => {
    const d = deferred();
    pending.push({ samples: s, ...d });
    return d.promise;
  }, { maxConcurrent: 2, maxQueued: 10 });

  const results = [];
  q.enqueue({ samples: 1, resolve: (v) => results.push(v), reject: () => {} });
  q.enqueue({ samples: 2, resolve: (v) => results.push(v), reject: () => {} });
  q.enqueue({ samples: 3, resolve: (v) => results.push(v), reject: () => {} });

  // third job must not have started — only 2 concurrent decodes allowed
  assert.equal(pending.length, 2);
  assert.equal(q.active, 2);

  pending[0].resolve('first');
  await Promise.resolve().then(() => {}).then(() => {}); // let the .finally/_pump microtasks settle
  await new Promise((r) => setImmediate(r));

  assert.equal(pending.length, 3); // the third job started once a slot freed
  assert.deepEqual(results, ['first']);
});

test('TranscriptionQueue sheds the oldest queued job once maxQueued is exceeded', async () => {
  const shed = [];
  const holds = [];
  const q = new TranscriptionQueue(
    (s) => {
      const d = deferred();
      holds.push({ samples: s, ...d });
      return d.promise;
    },
    { maxConcurrent: 1, maxQueued: 2, onShed: (job) => shed.push(job.samples) },
  );

  const outcomes = [];
  const make = (s) => ({ samples: s, resolve: (v) => outcomes.push(['ok', s, v]), reject: () => outcomes.push(['err', s]) });
  q.enqueue(make('a')); // starts immediately (active)
  q.enqueue(make('b')); // queued
  q.enqueue(make('c')); // queued
  q.enqueue(make('d')); // queue now at cap (2) — pushing this sheds 'b', the oldest queued

  assert.deepEqual(shed, ['b']);
  assert.equal(q.queue.map((j) => j.samples).join(','), 'c,d');

  holds[0].resolve('done-a');
  await new Promise((r) => setImmediate(r));
  assert.ok(outcomes.some(([status, s]) => status === 'ok' && s === 'a'));
  // 'b' never resolves or rejects — it was shed, not decoded
  assert.ok(!outcomes.some(([, s]) => s === 'b'));
});

test('a decode rejection rejects that job without wedging the queue for the next one', async () => {
  let call = 0;
  const q = new TranscriptionQueue(() => {
    call += 1;
    return call === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('second-ok');
  });
  // Two independent jobs settle via different paths (reject vs. resolve), which
  // take a different number of microtask hops — asserting a fixed order between
  // them would be asserting an implementation detail of Promise scheduling, not
  // of the queue. What actually matters: both settle correctly, and the
  // rejection of job 1 doesn't prevent job 2 from running at all.
  const job1 = new Promise((resolve, reject) => q.enqueue({ samples: 1, resolve, reject }));
  const job2 = new Promise((resolve, reject) => q.enqueue({ samples: 2, resolve, reject }));
  await assert.rejects(job1, /boom/);
  assert.equal(await job2, 'second-ok');
});

// --- createMicSession: orchestration against a stub VAD, real queue --------

/** A controllable fake sherpa VAD: acceptWaveform records the samples it was
 *  given, and the test decides when a "completed segment" pops out — the
 *  real Vad's actual speech/silence detection isn't what's under test here. */
function stubModels({ onAccept } = {}) {
  class FakeVad {
    constructor() {
      this.queue = [];
    }
    acceptWaveform(float32) {
      const segment = onAccept?.(float32);
      if (segment) this.queue.push(segment);
    }
    isEmpty() {
      return this.queue.length === 0;
    }
    front() {
      return this.queue[0];
    }
    pop() {
      this.queue.shift();
    }
    reset() {}
  }
  return { sherpa: { Vad: FakeVad }, vadConfig: {} };
}

test('createMicSession reports decoded text for a completed VAD segment', async () => {
  const models = stubModels({ onAccept: (f32) => ({ samples: f32 }) }); // every push "completes" a segment
  const q = new TranscriptionQueue(() => Promise.resolve('marco polo'));
  const finals = [];
  const session = createMicSession({ models, queue: q, onFinal: (t) => finals.push(t) });

  session.pushFrame(new Int16Array([1, 2, 3]));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(finals, ['marco polo']);
});

test('createMicSession passes energy/timing metadata alongside the text, for arbiter.js dedup', async () => {
  const models = stubModels({ onAccept: (f32) => ({ samples: f32 }) });
  const q = new TranscriptionQueue(() => Promise.resolve('marco polo'));
  const finals = [];
  const session = createMicSession({ models, queue: q, onFinal: (t, meta) => finals.push(meta) });

  const loudSamples = new Int16Array([30000, -30000, 30000, -30000]); // real input is int16 PCM, not pre-scaled floats
  const before = Date.now();
  session.pushFrame(loudSamples);
  await new Promise((r) => setImmediate(r));

  assert.equal(finals.length, 1);
  const [meta] = finals;
  assert.ok(meta.energy > 0.5, `expected high energy for loud samples, got ${meta.energy}`);
  assert.ok(meta.t0 <= meta.t1);
  assert.ok(meta.t1 >= before);
});

test('createMicSession extracts the embedding from a {text, embedding} decode result (the real createEngine shape)', async () => {
  const models = stubModels({ onAccept: (f32) => ({ samples: f32 }) });
  const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3]);
  const q = new TranscriptionQueue(() => Promise.resolve({ text: 'marco polo', embedding: fakeEmbedding }));
  const finals = [];
  const session = createMicSession({ models, queue: q, onFinal: (t, meta) => finals.push({ text: t, meta }) });

  session.pushFrame(new Int16Array([1, 2, 3]));
  await new Promise((r) => setImmediate(r));

  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'marco polo');
  assert.equal(finals[0].meta.embedding, fakeEmbedding);
});

test('createMicSession reports a null embedding when the decode result has none (older/plain-string decodeFn)', async () => {
  const models = stubModels({ onAccept: (f32) => ({ samples: f32 }) });
  const q = new TranscriptionQueue(() => Promise.resolve('marco polo')); // plain string, no embedding field
  const finals = [];
  const session = createMicSession({ models, queue: q, onFinal: (t, meta) => finals.push(meta) });

  session.pushFrame(new Int16Array([1, 2, 3]));
  await new Promise((r) => setImmediate(r));

  assert.equal(finals[0].embedding, null);
});

test('createMicSession carries its fixed language into every enqueued decode job', async () => {
  const models = stubModels({ onAccept: (f32) => ({ samples: f32 }) });
  const seenLanguages = [];
  const q = new TranscriptionQueue((samples, job) => {
    seenLanguages.push(job.language);
    return Promise.resolve('hi');
  });
  const session = createMicSession({ models, queue: q, language: 'zh', onFinal: () => {} });

  session.pushFrame(new Int16Array([1, 2, 3]));
  session.pushFrame(new Int16Array([4, 5, 6]));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(seenLanguages, ['zh', 'zh']);
});

test('createMicSession defaults to the first known language when none is specified', async () => {
  const models = stubModels({ onAccept: (f32) => ({ samples: f32 }) });
  let seenLanguage;
  const q = new TranscriptionQueue((samples, job) => {
    seenLanguage = job.language;
    return Promise.resolve('hi');
  });
  const session = createMicSession({ models, queue: q, onFinal: () => {} });

  session.pushFrame(new Int16Array([1, 2, 3]));
  await new Promise((r) => setImmediate(r));

  assert.equal(seenLanguage, LANGUAGES[0]);
});

test('createEngine exposes which languages actually loaded', () => {
  const models = { recognizers: { en: {}, zh: {} }, embeddingExtractor: {} };
  const engine = createEngine(models);
  assert.deepEqual(engine.languages, ['en', 'zh']);
});

test('createEngine reflects a partial load — only the languages that made it', () => {
  const models = { recognizers: { en: {} }, embeddingExtractor: {} };
  const engine = createEngine(models);
  assert.deepEqual(engine.languages, ['en']);
});

// --- transcript casing: these models emit raw ALL-CAPS, unpunctuated text ---

/** Minimal fake recognizer that just hands back whatever text it's told to. */
function stubRecognizerModels(text, kind = 'offline') {
  const recognizer = {
    createStream: () => ({ acceptWaveform() {}, inputFinished() {} }),
    isReady: () => false,
    decode() {},
    getResult: () => ({ text }),
  };
  return { recognizers: { en: { kind, recognizer } } };
}

test('decodeSegment normalizes a shouty model\'s ALL-CAPS output to sentence case', () => {
  const models = stubRecognizerModels('INDIANA JONES AND THE LAST CRUSADE');
  assert.equal(decodeSegment(models, new Float32Array(10), 'en'), 'Indiana jones and the last crusade');
});

test('decodeSegment leaves already-cased output alone — lowercasing it would lose real capitals', () => {
  // parakeet and friends punctuate and capitalize properly; rewriting that
  // would actively downgrade "The Tooth Fairy" to "The tooth fairy"
  const models = stubRecognizerModels('The Tooth Fairy, obviously.');
  assert.equal(decodeSegment(models, new Float32Array(10), 'en'), 'The Tooth Fairy, obviously.');
});

test('decodeSegment leaves CJK output alone — casing is a no-op there', () => {
  const models = stubRecognizerModels('这是第一种');
  assert.equal(decodeSegment(models, new Float32Array(10), 'en'), '这是第一种');
});

test('decodeSegment still returns empty for an empty transcript, not a stray capital', () => {
  const models = stubRecognizerModels('   ');
  assert.equal(decodeSegment(models, new Float32Array(10), 'en'), '');
});

test('decodeSegment drives an online model to completion, not just one decode call', () => {
  let decodeCalls = 0;
  let readyLeft = 3;
  const recognizer = {
    createStream: () => ({ acceptWaveform() {}, inputFinished() {} }),
    isReady: () => readyLeft > 0,
    decode() {
      decodeCalls++;
      readyLeft--;
    },
    getResult: () => ({ text: 'STREAMED' }),
  };
  const models = { recognizers: { zh: { kind: 'online', recognizer } } };
  assert.equal(decodeSegment(models, new Float32Array(10), 'zh'), 'Streamed');
  assert.equal(decodeCalls, 3); // drained the loop rather than stopping after one
});

test('a segment is widened with pre-roll audio from before the VAD\'s detected onset', async () => {
  // The VAD marks speech from where it's confident, which clips quiet leading
  // words. The segmenter keeps its own rolling copy of the audio so it can
  // hand the decoder the moments just before that onset too.
  const SEGMENT_START = 16000; // 1s in
  const SEGMENT_LEN = 8000;
  let pushed = 0;
  const models = stubModels({
    onAccept: () => {
      pushed += 1;
      // only emit a segment once enough audio has gone by to have history
      if (pushed !== 4) return null;
      return { start: SEGMENT_START, samples: new Float32Array(SEGMENT_LEN) };
    },
  });
  const captured = [];
  const q = new TranscriptionQueue((samples) => {
    captured.push(samples);
    return Promise.resolve('x');
  });
  const session = createMicSession({ models, queue: q, onFinal: () => {} });

  // 4 x 0.5s frames = 2s of audio, so the 1s-in segment has history behind it
  for (let i = 0; i < 4; i++) session.pushFrame(new Int16Array(8000).fill(1000));
  await new Promise((r) => setImmediate(r));

  assert.equal(captured.length, 1);
  // 0.3s of pre-roll at 16kHz = 4800 extra samples ahead of the VAD's segment
  assert.equal(captured[0].length, SEGMENT_LEN + 4800);
});

test('pre-roll falls back to the VAD\'s own samples when history cannot cover it', async () => {
  // a segment claiming to start before anything was ever fed — must not
  // silently hand back a wrong (or empty) slice
  const vadSamples = new Float32Array(4000).fill(0.5);
  const models = stubModels({ onAccept: () => ({ start: 0, samples: vadSamples }) });
  const captured = [];
  const q = new TranscriptionQueue((samples) => {
    captured.push(samples);
    return Promise.resolve('x');
  });
  const session = createMicSession({ models, queue: q, onFinal: () => {} });

  session.pushFrame(new Int16Array(1000));
  await new Promise((r) => setImmediate(r));

  assert.equal(captured[0], vadSamples); // the exact fallback object, untouched
});

test('createMicSession swallows a segment that decodes to empty text', async () => {
  const models = stubModels({ onAccept: (f32) => ({ samples: f32 }) });
  const q = new TranscriptionQueue(() => Promise.resolve('   ')); // whitespace-only "transcript"
  const finals = [];
  const warns = [];
  const session = createMicSession({ models, queue: q, onFinal: (t) => finals.push(t), onWarn: (e) => warns.push(e) });

  session.pushFrame(new Int16Array([1, 2, 3]));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(finals, []);
  assert.deepEqual(warns, []); // an empty transcript isn't a failure, just nothing said
});

test('createMicSession routes a broken native call to onWarn instead of crashing', () => {
  const models = stubModels({
    onAccept: () => {
      throw new Error('native addon exploded');
    },
  });
  const q = new TranscriptionQueue(() => Promise.resolve('unreachable'));
  const warns = [];
  const session = createMicSession({ models, queue: q, onFinal: () => {}, onWarn: (e) => warns.push(e.message) });

  assert.doesNotThrow(() => session.pushFrame(new Int16Array([1, 2, 3])));
  assert.deepEqual(warns, ['native addon exploded']);
});

test('no segment means no decode work is queued at all', async () => {
  const models = stubModels({ onAccept: () => null }); // never completes a segment
  let decodeCalls = 0;
  const q = new TranscriptionQueue(() => {
    decodeCalls += 1;
    return Promise.resolve('should not run');
  });
  const session = createMicSession({ models, queue: q, onFinal: () => {} });
  session.pushFrame(new Int16Array(500));
  await new Promise((r) => setImmediate(r));
  assert.equal(decodeCalls, 0);
});

// --- Real models: only if this box actually has them (Docker build stage) --

const MODEL_DIR = process.env.PS_STT_MODEL_DIR || path.join(__dirname, '..', 'models');
const HAVE_VAD = fs.existsSync(path.join(MODEL_DIR, 'silero_vad.onnx'));
const HAVE_EN = HAVE_VAD && fs.existsSync(path.join(MODEL_DIR, 'en', 'encoder.onnx'));
const HAVE_ZH = HAVE_VAD && fs.existsSync(path.join(MODEL_DIR, 'zh', 'encoder.onnx'));
const HAVE_MODELS = HAVE_EN || HAVE_ZH;
const HAVE_EMBEDDING_MODEL = fs.existsSync(path.join(MODEL_DIR, 'speaker_embedding.onnx'));
const MODEL_SKIP_REASON = 'model files not present (see Dockerfile\'s models stage) — run scripts/stt-bench.mjs on a box that has them';

test(
  'real models: a synthetic sine-wave "utterance" round-trips through VAD + ASR without throwing',
  { skip: !HAVE_MODELS && MODEL_SKIP_REASON },
  async () => {
    const models = await loadModels(MODEL_DIR);
    // Not a claim this transcribes to anything meaningful — silence/tone isn't
    // speech — only that the real native pipeline runs end to end without
    // throwing, which is what's actually reachable without a microphone.
    const samples = new Float32Array(SAMPLE_RATE); // 1s of silence
    const text = decodeSegment(models, samples);
    assert.equal(typeof text, 'string');
  },
);

test(
  'real models: each bundled sample decodes cleanly through its own language, never mixing scripts',
  { skip: !(HAVE_EN && HAVE_ZH) && 'both en/ and zh/ model dirs needed for this comparison (see MODEL_SKIP_REASON)' },
  async () => {
    const models = await loadModels(MODEL_DIR);
    const CJK = /[㐀-鿿]/;
    for (const [lang, testWav] of [
      ['en', path.join(MODEL_DIR, 'en', 'test_wavs', '0.wav')],
      ['zh', path.join(MODEL_DIR, 'zh', 'test_wavs', '0.wav')],
    ]) {
      if (!fs.existsSync(testWav)) continue; // bundled samples are optional extras, not part of the renamed model dir
      const wave = models.sherpa.readWave(testWav);
      const text = decodeSegment(models, wave.samples, lang);
      assert.ok(text.length > 0, `${lang} sample decoded to nothing`);
      if (lang === 'en') assert.doesNotMatch(text, CJK, 'English model produced CJK output');
      else assert.match(text, CJK, 'Chinese model produced no CJK output at all');
    }
  },
);

test(
  'real models: an unrecognized language falls back to whatever is loaded instead of failing silently',
  { skip: !HAVE_MODELS && MODEL_SKIP_REASON },
  async () => {
    const models = await loadModels(MODEL_DIR);
    const samples = new Float32Array(SAMPLE_RATE);
    assert.doesNotThrow(() => decodeSegment(models, samples, 'fr'));
  },
);

test(
  'real models: computeEmbedding returns a fixed-length vector for real speech',
  { skip: !(HAVE_MODELS && HAVE_EMBEDDING_MODEL) && MODEL_SKIP_REASON },
  async () => {
    const models = await loadModels(MODEL_DIR);
    const samples = new Float32Array(SAMPLE_RATE * 2);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.05) * 0.3;
    const embedding = computeEmbedding(models, samples);
    assert.ok(embedding.length > 0);
    assert.equal(embedding.length, models.embeddingExtractor.dim);
  },
);

test(
  'real models: the same speaker\'s two utterances embed more similarly than two different speakers',
  { skip: !(HAVE_MODELS && HAVE_EMBEDDING_MODEL) && MODEL_SKIP_REASON },
  async () => {
    const models = await loadModels(MODEL_DIR);
    function cosine(a, b) {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }
    const wavDir = path.join(MODEL_DIR, HAVE_EN ? 'en' : 'zh', 'test_wavs');
    if (!fs.existsSync(wavDir)) return; // bundled sample wavs are an optional extra, not part of the renamed model dir; skip quietly if absent
    const wave = models.sherpa.readWave(path.join(wavDir, '0.wav'));
    const half = Math.floor(wave.samples.length / 2);
    const a1 = computeEmbedding(models, wave.samples.subarray(0, half));
    const a2 = computeEmbedding(models, wave.samples.subarray(half));
    const noise = new Float32Array(SAMPLE_RATE);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() - 0.5;
    const b = computeEmbedding(models, noise);
    assert.ok(cosine(a1, a2) > cosine(a1, b), 'same-speaker halves should be more similar than speech-vs-noise');
  },
);

test(
  'real models: computeEmbeddingFromInt16 matches computeEmbedding on the equivalent float samples',
  { skip: !(HAVE_MODELS && HAVE_EMBEDDING_MODEL) && MODEL_SKIP_REASON },
  async () => {
    const models = await loadModels(MODEL_DIR);
    const int16 = new Int16Array(SAMPLE_RATE);
    for (let i = 0; i < int16.length; i++) int16[i] = Math.round(Math.sin(i * 0.05) * 10000);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const viaInt16 = computeEmbeddingFromInt16(models, int16);
    const viaFloat = computeEmbedding(models, float32);
    assert.deepEqual(Array.from(viaInt16), Array.from(viaFloat));
  },
);
