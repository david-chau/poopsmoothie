/**
 * Worker-thread half of the speech pipeline: owns the ASR recognizers and the
 * speaker-embedding model, and does nothing but decode what the main thread
 * sends it.
 *
 * Why this exists: sherpa-onnx-node's decode is a *synchronous* native call.
 * Run on the main thread it blocks Node's event loop outright — the turn
 * timer's broadcasts, correct/pass acks and every other room on the box all
 * wait behind one person's sentence. It also meant `PS_STT_MAX_CONCURRENT`
 * was a fiction: four "concurrent" decodes were really four serial ones
 * sharing one thread (the NAS bench measured 0.551x single-stream against
 * 2.175x for four, i.e. no parallelism at all).
 *
 * The VAD deliberately stays on the main thread — it costs 0.647ms per 250ms
 * frame (0.26% of a core per live mic, measured), so shipping every audio
 * frame across a thread boundary would cost more than it saves. Only the
 * expensive, bursty part moves here.
 *
 * Protocol (see createWorkerPool in stt.js for the other end):
 *   main -> worker  {id, type: 'decode', samples, language, wantEmbedding}
 *                   {id, type: 'enroll', samples}   // Int16Array
 *   worker -> main  {type: 'ready'} | {type: 'init-error', error}
 *                   {id, ok: true, text, embedding} | {id, ok: false, error}
 */
import { parentPort, workerData } from 'node:worker_threads';
import { loadModels, decodeSegment, computeEmbedding, computeEmbeddingFromInt16 } from './stt.js';

const { modelDir, numThreads } = workerData;

let models = null;
try {
  models = await loadModels(modelDir, { numThreads });
  parentPort.postMessage({ type: 'ready' });
} catch (err) {
  // The pool treats this as "workers are unavailable" and falls back to
  // in-process decoding, so a worker that can't load models degrades voice
  // chat's performance rather than breaking it.
  parentPort.postMessage({ type: 'init-error', error: err.message });
}

parentPort.on('message', (msg) => {
  if (!models) return; // init failed; the pool has already given up on us
  const { id, type } = msg;
  try {
    if (type === 'enroll') {
      const embedding = computeEmbeddingFromInt16(models, msg.samples);
      parentPort.postMessage({ id, ok: true, embedding });
      return;
    }
    const text = decodeSegment(models, msg.samples, msg.language);
    // Only computed when someone in the room has actually enrolled a
    // voiceprint — otherwise there is nothing to match against and this is
    // pure latency on every single utterance.
    const embedding = msg.wantEmbedding ? computeEmbedding(models, msg.samples) : null;
    parentPort.postMessage({ id, ok: true, text, embedding });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
