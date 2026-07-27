// Validates voice capture on THIS box before game night: loads the real
// models and measures how fast decode actually runs, both alone and under the
// same concurrency cap production uses. Doesn't need a microphone or a real
// recording — see server/stt.js for why VAD isn't the bottleneck worth
// benchmarking (negligible CPU; it's ASR decode that's uncertain on the NAS).
//
// Usage:
//   node scripts/stt-bench.mjs [modelDir] [--seconds N] [--concurrent N]
//   PS_STT_MODEL_DIR=/path/to/models node scripts/stt-bench.mjs
import { loadModels, decodeSegment, TranscriptionQueue, SAMPLE_RATE } from '../server/stt.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]) || fallback;
};
const modelDir = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || process.env.PS_STT_MODEL_DIR || './models';
const clipSeconds = flag('seconds', 5);
const concurrent = flag('concurrent', Number(process.env.PS_STT_MAX_CONCURRENT) || 4);

console.log(`loading models from ${modelDir}...`);
const loadStart = Date.now();
let models;
try {
  models = await loadModels(modelDir, { numThreads: Number(process.env.PS_STT_THREADS) || 1 });
} catch (err) {
  console.error(`\ncould not load models: ${err.message}`);
  console.error('(this is exactly what a missing/misconfigured model dir looks like in production —');
  console.error(' voice capture would silently disable itself; here it just fails the bench instead)');
  process.exit(1);
}
console.log(`loaded in ${Date.now() - loadStart}ms\n`);

// Synthetic audio, not a real recording: this measures decode *throughput*
// (how many seconds of audio-shaped input the model can process per second of
// wall time), which is what the NAS-CPU guardrails in the plan actually care
// about — it says nothing about transcription accuracy, which real speech
// through the live app already exercises (see the manual verification steps
// in the plan).
function syntheticClip(seconds) {
  const n = Math.round(SAMPLE_RATE * seconds);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.sin(i * 0.05) * 0.3 + (Math.random() - 0.5) * 0.05;
  return samples;
}

function verdict(rtf) {
  return rtf < 1 ? 'faster than realtime — comfortable' : 'SLOWER than realtime — this box will lag under load';
}

console.log(`--- single-stream decode: ${clipSeconds}s clip ---`);
const singleStart = Date.now();
decodeSegment(models, syntheticClip(clipSeconds));
const singleMs = Date.now() - singleStart;
const singleRtf = singleMs / 1000 / clipSeconds;
console.log(`elapsed: ${singleMs}ms  ->  RTF ${singleRtf.toFixed(3)}x (${verdict(singleRtf)})`);

console.log(`\n--- concurrent decode: ${concurrent} simultaneous streams, capped at ${concurrent} ---`);
const queue = new TranscriptionQueue((samples) => decodeSegment(models, samples), {
  maxConcurrent: concurrent,
  maxQueued: concurrent,
});
const clips = Array.from({ length: concurrent }, () => syntheticClip(clipSeconds));
const concurrentStart = Date.now();
await Promise.all(clips.map((samples) => new Promise((resolve, reject) => queue.enqueue({ samples, resolve, reject }))));
const concurrentMs = Date.now() - concurrentStart;
const concurrentRtf = concurrentMs / 1000 / clipSeconds;
console.log(`elapsed: ${concurrentMs}ms for ${concurrent} streams  ->  effective RTF/stream ${concurrentRtf.toFixed(3)}x (${verdict(concurrentRtf)})`);

console.log('\nLower RTF is better. If the concurrent number is far worse than the single-stream');
console.log(`one, set PS_STT_MAX_CONCURRENT lower than ${concurrent} for this box.`);
