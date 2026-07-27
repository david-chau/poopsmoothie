import fs from 'node:fs';
import path from 'node:path';

export const SAMPLE_RATE = 16000;

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
      minSilenceDuration: 0.5,
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
 *  it's for server/arbiter.js's cross-device dedup and speaker matching. */
export function createMicSession({ models, queue, language = LANGUAGES[0], onFinal, onWarn }) {
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
        queue.enqueue({
          samples,
          language, // fixed for this session's lifetime — see createSession's caller in events.js
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
 *  both) rather than as a second, separately-capped pipeline. */
export function createEngine(models, { maxConcurrent = 4, maxQueued = 8 } = {}) {
  const queue = new TranscriptionQueue(
    (samples, job) => ({ text: decodeSegment(models, samples, job.language), embedding: computeEmbedding(models, samples) }),
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
  };
}
