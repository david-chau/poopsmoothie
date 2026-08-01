import fs from 'node:fs';
import path from 'node:path';

export const SAMPLE_RATE = 16000;

function floatEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** How much trailing silence ends an utterance. Straight latency: nothing is
 *  decoded until the VAD has heard this much quiet, so it's paid on every
 *  single line. 0.3s rather than the silero default 0.5s — but kept tunable,
 *  because this is the one knob here with a real tradeoff in both directions:
 *  too low and a mid-sentence breath splits one thought into two chat lines. */
const VAD_MIN_SILENCE = floatEnv('PS_VAD_MIN_SILENCE', 0.3);

/** Segments quieter than this never reach the decoder. The VAD only decides
 *  "is this speech", not "is this speech we have any hope of transcribing" —
 *  a phone across the room clears that bar and then produces confident
 *  nonsense ("When an alcoholism"). Gating on energy is what actually
 *  separates the two, and it's per-device because being far away is a
 *  property of the device, not the room (clients send their own via mic-on).
 *  0 disables the gate entirely, which is the pre-existing behaviour. */
export const DEFAULT_MIN_ENERGY = 0.012;

/** Below this, a "segment" is a cough, a chair, or a clipped "Uh" — never a
 *  sentence worth an audit-trail line, and never worth a decode. */
const MIN_SEGMENT_SEC = 0.35;

// One language, one recognizer, never mixed — a single bilingual model was
// tried first and dropped: trained on Mandarin/English code-switching speech,
// it's biased toward hearing Chinese even from a pure-English speaker (tested
// against real recordings; switching decodingMethod didn't help, the bias is
// in what the model learned, not the search strategy). Each entry here is its
// own single-language streaming zipformer, so output can't cross-contaminate.
export const LANGUAGES = ['en', 'zh'];

/**
 * How a language directory's model is built. Written by the Dockerfile into
 * each language dir as `model.json` (`{"kind": "..."}`), so swapping a model
 * is a Dockerfile-only change rather than a code one — which matters here,
 * because the right model depends on the host's CPU (see scripts/stt-bench.mjs).
 *
 * `offline` is the better default where the CPU allows it: this pipeline
 * VAD-segments *first* and only ever decodes a complete utterance, so nothing
 * needs a streaming model's incremental machinery — and offline models are
 * markedly more accurate on short utterances, which is most of what gets said
 * across a table ("Indiana Jones", not a paragraph).
 */
const RECOGNIZER_KINDS = {
  offline: (sherpa, langDir, numThreads) =>
    new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(langDir, 'encoder.onnx'),
          decoder: path.join(langDir, 'decoder.onnx'),
          joiner: path.join(langDir, 'joiner.onnx'),
        },
        tokens: path.join(langDir, 'tokens.txt'),
        numThreads,
        provider: 'cpu',
      },
    }),
  online: (sherpa, langDir, numThreads) =>
    new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(langDir, 'encoder.onnx'),
          decoder: path.join(langDir, 'decoder.onnx'),
          joiner: path.join(langDir, 'joiner.onnx'),
        },
        tokens: path.join(langDir, 'tokens.txt'),
        // no modelType: some of these releases predate the "zipformer2"
        // metadata schema — forcing that type crashes the native addon
        // outright (a fatal metadata assertion, not a catchable JS error).
        // Unset lets sherpa-onnx read the architecture off the encoder itself.
        numThreads,
        provider: 'cpu',
      },
      decodingMethod: 'greedy_search',
    }),
};

/** `model.json`'s kind, defaulting to online for a directory that predates
 *  the file. An unknown kind is a config error worth failing loudly on, not
 *  silently guessing about. */
function readKind(langDir) {
  const file = path.join(langDir, 'model.json');
  if (!fs.existsSync(file)) return 'online';
  const { kind = 'online' } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!RECOGNIZER_KINDS[kind]) {
    throw new Error(`${file}: unknown model kind "${kind}" (expected one of: ${Object.keys(RECOGNIZER_KINDS).join(', ')})`);
  }
  return kind;
}

/**
 * Loads the real sherpa-onnx-node addon + on-disk ONNX models. Isolated into
 * its own function — never a static import — so requiring stt.js can never
 * fail on a box without the native addon or the model files; only *calling*
 * this can, and the caller (index.js) treats that exactly like a missing TLS
 * cert (see tls.js): voice capture turns off, nothing else does.
 *
 * Directory layout expected in `modelDir` (see Dockerfile's `models` build
 * stage, which curls these from the k2-fsa/sherpa-onnx GitHub releases):
 *   en/{encoder,decoder,joiner,tokens.txt,model.json}
 *   zh/{encoder,decoder,joiner,tokens.txt,model.json}
 *   silero_vad.onnx          shared — language-agnostic
 *   speaker_embedding.onnx   shared — voice ID doesn't care what's said
 *
 * Each language directory is independently optional: a NAS that only fetched
 * `en/` still gets voice chat, just without the `zh` option. At least one
 * language must load or this throws (no ASR at all).
 */
export async function loadModels(modelDir, { numThreads = 1 } = {}) {
  // sherpa-onnx-node is CJS with a `module.exports = {...}` object; Node's ESM
  // interop only statically detects some of its keys as named exports
  // (cjs-module-lexer heuristics), so `.default` is the only reliable way to
  // get the whole thing — `(await import(...)).Vad` is undefined even though
  // the package genuinely exports it.
  const sherpa = (await import('sherpa-onnx-node')).default;
  const vadConfig = {
    sileroVad: {
      model: path.join(modelDir, 'silero_vad.onnx'),
      threshold: 0.5,
      minSilenceDuration: VAD_MIN_SILENCE,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 15,
      windowSize: 512,
    },
    sampleRate: SAMPLE_RATE,
    numThreads,
  };

  const recognizers = {};
  for (const lang of LANGUAGES) {
    const langDir = path.join(modelDir, lang);
    if (!fs.existsSync(langDir)) continue; // that language's models weren't fetched — fine, it just won't be offered
    const kind = readKind(langDir);
    recognizers[lang] = { kind, recognizer: RECOGNIZER_KINDS[kind](sherpa, langDir, numThreads) };
  }
  if (Object.keys(recognizers).length === 0) {
    throw new Error(`no ASR model directories found under ${modelDir} (expected one of: ${LANGUAGES.join(', ')})`);
  }

  const embeddingExtractor = new sherpa.SpeakerEmbeddingExtractor({
    model: path.join(modelDir, 'speaker_embedding.onnx'),
    numThreads,
    provider: 'cpu',
  });
  return { sherpa, recognizers, vadConfig, embeddingExtractor };
}

/** Which languages this model dir can actually offer. A directory check only
 *  — cheap enough to call from the main thread without loading anything. */
export function availableLanguages(modelDir) {
  return LANGUAGES.filter((lang) => fs.existsSync(path.join(modelDir, lang)));
}

/**
 * The VAD half of `loadModels`, and nothing else. When decoding runs in
 * worker threads (the default — see createWorkerPool) the main thread never
 * touches a recognizer, so loading 631MB of ASR weights here would be pure
 * waste: silero is 632KB and is all the segmenter needs. The recognizers and
 * the embedding extractor live in the workers instead.
 *
 * Throws for the same reason loadModels does — no language directories at all
 * means no voice chat — so the caller's existing "optional, never fatal"
 * try/catch keeps working unchanged.
 */
export async function loadVadOnly(modelDir, { numThreads = 1 } = {}) {
  const languages = availableLanguages(modelDir);
  if (languages.length === 0) {
    throw new Error(`no ASR model directories found under ${modelDir} (expected one of: ${LANGUAGES.join(', ')})`);
  }
  const sherpa = (await import('sherpa-onnx-node')).default; // see loadModels for why `.default`
  const vadModel = path.join(modelDir, 'silero_vad.onnx');
  if (!fs.existsSync(vadModel)) throw new Error(`missing ${vadModel}`);
  return {
    sherpa,
    languages,
    vadConfig: {
      sileroVad: {
        model: vadModel,
        threshold: 0.5,
        minSilenceDuration: VAD_MIN_SILENCE,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 15,
        windowSize: 512,
      },
      sampleRate: SAMPLE_RATE,
      numThreads,
    },
  };
}

function int16ToFloat32(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

/** Some models emit raw ALL-CAPS, unpunctuated text (a training-data artifact,
 *  not a setting); others already return properly cased, punctuated text.
 *  Only rewrite the shouty ones — lowercasing a model that got "The Tooth
 *  Fairy" right would actively make it worse. Detected rather than configured
 *  per model, so this keeps working when a model is swapped out.
 *  `.toLowerCase()` is a no-op on CJK, so CJK text falls through untouched. */
function toSentenceCase(text) {
  if (/[a-z]/.test(text)) return text; // already mixed-case — leave it alone
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * One VAD instance per audio stream (one per socket's mic) — cheap (a small
 * circular buffer), unlike the recognizer below which holds the loaded model
 * weights and is shared server-wide. Silence-gated on purpose: running the ASR
 * on every stream continuously is the CPU cost this whole design is trying to
 * avoid (see the plan's NAS guardrails) — the VAD's job is to say "there was
 * actually speech here" before anything expensive touches it.
 */
/** Audio kept before a segment's detected onset. The VAD marks speech from
 *  where it is *confident*, which reliably clips a quiet leading word — "The
 *  Tooth Fairy" came back as "Tooth fairy" until this was added. Tuning the
 *  VAD's own thresholds instead was tried and rejected: the only value that
 *  recovered the word (minSpeechDuration 0.05) is also the most eager to call
 *  a cough speech, and neighbouring values behaved erratically. */
const PREROLL_SEC = 0.3;
/** Enough history to cover the longest allowed utterance plus its pre-roll,
 *  since a segment is only handed back once it has *ended*. ~1MB per live
 *  mic at 16kHz float32. */
const HISTORY_SEC = 17;

export function createSegmenter(models) {
  const vad = new models.sherpa.Vad(models.vadConfig, 30);
  const maxHistory = Math.round(SAMPLE_RATE * HISTORY_SEC);
  let history = new Float32Array(0);
  let historyStart = 0; // absolute stream index of history[0]

  return {
    /** samples: Int16Array of raw 16kHz mono PCM. Returns zero or more
     *  completed speech segments (Float32Array), end-pointed by the VAD's own
     *  trailing-silence rule — usually [], occasionally one utterance. */
    pushSamples(samples) {
      const floats = int16ToFloat32(samples);
      vad.acceptWaveform(floats);

      // keep our own rolling copy: the VAD hands back only what it considered
      // speech, and we want the moments just before that too
      const merged = new Float32Array(history.length + floats.length);
      merged.set(history);
      merged.set(floats, history.length);
      if (merged.length > maxHistory) {
        const drop = merged.length - maxHistory;
        history = merged.subarray(drop);
        historyStart += drop;
      } else {
        history = merged;
      }

      const segments = [];
      while (!vad.isEmpty()) {
        const front = vad.front();
        segments.push(withPreroll(front));
        vad.pop();
      }
      return segments;
    },
    close() {
      vad.reset();
      history = new Float32Array(0);
    },
  };

  function withPreroll(front) {
    const preroll = Math.round(SAMPLE_RATE * PREROLL_SEC);
    const from = front.start - preroll - historyStart;
    const to = front.start + front.samples.length - historyStart;
    // history should always cover this, but never hand back a wrong slice if
    // it somehow doesn't — the VAD's own samples are the safe fallback
    if (!Number.isFinite(front.start) || from < 0 || to > history.length) return front.samples;
    return history.slice(from, to);
  }
}

/** Decodes one already-end-pointed segment in one shot. The VAD has already
 *  decided where the utterance starts and ends, so an offline model just gets
 *  handed the whole thing; an online (streaming) one is driven to completion
 *  manually rather than incrementally.
 *
 *  `language` picks which single-language recognizer decodes this segment
 *  (falls back to whichever is loaded if the requested one isn't — a stale
 *  room setting from before a model was removed shouldn't just go silent). */
export function decodeSegment(models, samples, language = LANGUAGES[0]) {
  const entry = models.recognizers[language] ?? Object.values(models.recognizers)[0];
  if (!entry) throw new Error('no ASR recognizer is loaded for any language');
  const { kind, recognizer } = entry;
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  if (kind === 'online') {
    // 400ms of trailing silence, fed as its own chunk — sherpa-onnx's own
    // reference usage does this for streaming models. Without it the tail of
    // a segment sits in an incomplete internal chunk and never makes it
    // through the feature extractor. Offline models take the clip whole and
    // need none of this.
    stream.acceptWaveform({ samples: new Float32Array(SAMPLE_RATE * 0.4), sampleRate: SAMPLE_RATE });
    stream.inputFinished();
    while (recognizer.isReady(stream)) recognizer.decode(stream);
  } else {
    recognizer.decode(stream);
  }
  return toSentenceCase(recognizer.getResult(stream).text.trim());
}

/** A voiceprint for one clip of speech (Float32Array, any length — a few
 *  seconds is plenty). Cosine-comparable against another clip's embedding
 *  via server/arbiter.js's cosineSimilarity/matchEnrolledSpeaker; never
 *  compared to raw audio directly. Used both for enrollment (a longer,
 *  deliberate sample) and per-utterance during live play (whatever the VAD
 *  handed back). */
export function computeEmbedding(models, samples) {
  const stream = models.embeddingExtractor.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  stream.inputFinished();
  return models.embeddingExtractor.compute(stream);
}

/** Enrollment arrives over the socket as raw Int16 PCM (same wire format as
 *  audio-frame), not pre-converted Float32 — this is the one conversion point
 *  events.js needs for that path. */
export function computeEmbeddingFromInt16(models, int16Samples) {
  return computeEmbedding(models, int16ToFloat32(int16Samples));
}

/**
 * Runs at most `maxConcurrent` decodes at once, server-wide — the NAS-CPU
 * guardrail. Work beyond that queues briefly; beyond `maxQueued` the OLDEST
 * queued segment is dropped rather than piling up unbounded, because a segment
 * decoded several seconds late is just wrong context by the time it would
 * land — chat degrades under load, the game never does.
 */
export class TranscriptionQueue {
  constructor(decodeFn, { maxConcurrent = 4, maxQueued = 8, onShed } = {}) {
    this.decodeFn = decodeFn;
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.onShed = onShed;
    this.active = 0;
    this.queue = [];
  }

  enqueue(job) {
    if (this.queue.length >= this.maxQueued) this.onShed?.(this.queue.shift());
    this.queue.push(job);
    this._pump();
  }

  _pump() {
    // `active` increments synchronously (before the decode's promise settles)
    // so the cap is observable/enforced the instant a job starts, not a
    // microtask later — the difference between actually capping concurrent
    // ASR calls and just hoping the timing works out.
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active++;
      let result;
      try {
        // second arg is the whole job (e.g. `language`) — existing callers
        // that only destructure `samples` as the first param are unaffected
        result = this.decodeFn(job.samples, job);
      } catch (err) {
        this.active--;
        job.reject(err);
        continue;
      }
      Promise.resolve(result)
        .then((text) => job.resolve(text))
        .catch((err) => job.reject(err))
        .finally(() => {
          this.active--;
          this._pump();
        });
    }
  }
}

function rms(float32Samples) {
  let sum = 0;
  for (let i = 0; i < float32Samples.length; i++) sum += float32Samples[i] * float32Samples[i];
  return float32Samples.length ? Math.sqrt(sum / float32Samples.length) : 0;
}

/** Ties one socket's segmenter to the shared queue and hands finished text
 *  back via `onFinal(text, {energy, t0, t1, embedding})`. Segments that decode
 *  to empty text (VAD false-positive on a non-speech noise) are swallowed
 *  here rather than becoming blank chat lines. `queue`'s decodeFn is expected
 *  to resolve `{text, embedding}` (see createEngine) — embedding may be null
 *  if the model doesn't support it. None of this metadata reaches a client;
 *  it's for server/arbiter.js's cross-device dedup and speaker matching.
 *
 *  `minEnergy` and `wantEmbedding` are both decided per session by the caller
 *  (events.js): the first from the device's own sensitivity setting, the
 *  second from whether anyone in the room actually enrolled a voiceprint. */
export function createMicSession({
  models,
  queue,
  language = LANGUAGES[0],
  minEnergy = DEFAULT_MIN_ENERGY,
  minSegmentSec = MIN_SEGMENT_SEC,
  wantEmbedding = true,
  onFinal,
  onWarn,
}) {
  const segmenter = createSegmenter(models);
  return {
    pushFrame(int16Samples) {
      let segments;
      try {
        segments = segmenter.pushSamples(int16Samples);
      } catch (err) {
        onWarn?.(err);
        return;
      }
      for (const samples of segments) {
        // captured now, when the segment completes — not when decode finishes
        // (which can lag by however long the shared queue takes under load),
        // so two devices' timings stay comparable regardless of server load
        const t1 = Date.now();
        const t0 = t1 - (samples.length / SAMPLE_RATE) * 1000;
        const energy = rms(samples);
        // Dropped *before* the queue, not after decoding: a segment we already
        // know we won't trust shouldn't spend a decode slot proving it. That
        // makes this a latency win for everyone else on the box, not just a
        // quality one for whoever's phone is across the room.
        if (energy < minEnergy) continue;
        if (samples.length / SAMPLE_RATE < minSegmentSec) continue;
        queue.enqueue({
          samples,
          language, // fixed for this session's lifetime — see createSession's caller in events.js
          wantEmbedding,
          resolve: (result) => {
            const text = typeof result === 'string' ? result : result?.text;
            const clean = typeof text === 'string' ? text.trim() : '';
            if (clean) onFinal(clean, { energy, t0, t1, embedding: result?.embedding ?? null });
          },
          reject: (err) => onWarn?.(err),
        });
      }
    },
    close() {
      segmenter.close();
    },
  };
}

/** The object index.js hands to registerSocketHandlers — bundles the loaded
 *  models with the shared concurrency-capped queue so every socket's session
 *  draws from one NAS-wide budget instead of one each. Embedding computation
 *  rides in the same queued job as ASR decode (same concurrency cap covers
 *  both) rather than as a second, separately-capped pipeline.
 *
 *  In-process (blocking) decode. This is the fallback path and what the tests
 *  and scripts/stt-bench.mjs use; the server normally runs `startEngine`,
 *  which puts decode in worker threads instead. */
export function createEngine(models, { maxConcurrent = 4, maxQueued = 8 } = {}) {
  const queue = new TranscriptionQueue(
    (samples, job) => ({
      text: decodeSegment(models, samples, job.language),
      embedding: job.wantEmbedding === false ? null : computeEmbedding(models, samples),
    }),
    {
      maxConcurrent,
      maxQueued,
      onShed: () => console.warn('voice: dropped a queued segment under load'),
    },
  );
  return {
    models,
    // which languages a room's voice-language setting can actually pick from
    languages: Object.keys(models.recognizers),
    createSession: (opts) => createMicSession({ models, queue, ...opts }),
    // enrollment is a rare, one-shot user action (not a continuous stream),
    // so it runs directly rather than through the shared queue
    computeEnrollment: (int16Samples) => computeEmbeddingFromInt16(models, int16Samples),
    close() {},
  };
}

/**
 * A pool of stt-worker.js threads. Each worker loads its own copy of the
 * models (~700MB), which is exactly why the default size is 1 rather than the
 * old maxConcurrent default of 4: one worker already frees the event loop
 * completely, and every extra one buys parallelism at ~700MB a head.
 *
 * Resolves only once every worker reports `ready`, so the engine never hands
 * out a decode slot backed by a thread that's still loading (or has already
 * failed) — a failure during startup rejects, and the caller falls back to
 * in-process decoding.
 */
export async function createWorkerPool(modelDir, { size = 1, numThreads = 1 } = {}) {
  const { Worker } = await import('node:worker_threads');
  const workerUrl = new URL('./stt-worker.js', import.meta.url);
  const workers = [];

  const spawn = () =>
    new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl, {
        workerData: { modelDir, numThreads },
        // Workers inherit the parent's execArgv by default, and Worker only
        // accepts a narrow allowlist of flags — so anything the parent happens
        // to be running with can make every worker fail to start, silently
        // dropping the whole pool back to in-process decoding. `node --test`
        // and `node --input-type=module -e` both do exactly that. This worker
        // needs no inherited flags: give it none rather than gambling on
        // whichever ones the parent came up with.
        execArgv: [],
      });
      const entry = { worker, inFlight: new Map(), busy: 0 };
      const onInit = (msg) => {
        if (msg.type === 'ready') {
          worker.off('message', onInit);
          worker.on('message', (m) => {
            const job = entry.inFlight.get(m.id);
            if (!job) return;
            entry.inFlight.delete(m.id);
            entry.busy--;
            if (m.ok) job.resolve({ text: m.text, embedding: m.embedding ?? null });
            else job.reject(new Error(m.error));
          });
          resolve(entry);
        } else if (msg.type === 'init-error') {
          reject(new Error(msg.error));
        }
      };
      worker.on('message', onInit);
      worker.on('error', reject);
      // A worker that dies mid-flight must not leave its callers hanging
      // forever — fail them explicitly, same reasoning as rejecting on error.
      worker.on('exit', (code) => {
        for (const job of entry.inFlight.values()) job.reject(new Error(`stt worker exited (${code})`));
        entry.inFlight.clear();
        entry.busy = 0;
        // `terminate()` itself exits with code 1, so only complain about an
        // exit we didn't ask for — otherwise every clean shutdown logs a
        // scary-looking warning that means nothing.
        if (code !== 0 && !entry.terminating) console.warn(`voice: stt worker exited with code ${code}`);
      });
    });

  for (let i = 0; i < size; i++) workers.push(await spawn());

  let nextId = 1;
  function send(payload) {
    // least-busy rather than round-robin: the queue caps in-flight work at the
    // pool size, so this reliably finds an idle worker instead of stacking two
    // jobs on one while another sits doing nothing
    const entry = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      entry.inFlight.set(id, { resolve, reject });
      entry.busy++;
      // the samples buffer is never read again on this side, so hand over
      // ownership rather than copying it across the thread boundary
      entry.worker.postMessage({ id, ...payload }, [payload.samples.buffer]);
    });
  }

  return {
    size: workers.length,
    decode: (samples, job) =>
      send({ type: 'decode', samples, language: job.language, wantEmbedding: job.wantEmbedding !== false }),
    computeEnrollment: (samples) => send({ type: 'enroll', samples }).then((r) => r.embedding),
    close: () =>
      Promise.all(
        workers.map((w) => {
          w.terminating = true;
          return w.worker.terminate();
        }),
      ),
  };
}

/**
 * What index.js actually calls: VAD on this thread, decode in workers, with a
 * transparent fallback to fully in-process decoding if the workers can't
 * start. Voice chat staying up (slower) beats voice chat vanishing, which is
 * the same "optional, never fatal" contract as a missing TLS cert.
 */
export async function startEngine(modelDir, { numThreads = 1, maxConcurrent = 1, maxQueued = 8 } = {}) {
  const vad = await loadVadOnly(modelDir, { numThreads });
  let pool;
  try {
    pool = await createWorkerPool(modelDir, { size: maxConcurrent, numThreads });
  } catch (err) {
    console.warn(`voice: worker threads unavailable, decoding in-process (${err.message})`);
    const models = await loadModels(modelDir, { numThreads });
    return createEngine(models, { maxConcurrent, maxQueued });
  }

  const queue = new TranscriptionQueue(pool.decode, {
    maxConcurrent,
    maxQueued,
    onShed: () => console.warn('voice: dropped a queued segment under load'),
  });
  return {
    models: vad,
    languages: vad.languages,
    workers: pool.size,
    createSession: (opts) => createMicSession({ models: vad, queue, ...opts }),
    computeEnrollment: (int16Samples) => pool.computeEnrollment(int16Samples),
    close: () => pool.close(),
  };
}
