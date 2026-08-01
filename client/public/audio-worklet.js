// Runs in the audio-rendering thread, loaded via audioContext.audioWorklet.addModule()
// — a plain script, not a bundled module, so it must have no imports/exports
// beyond registerProcessor. Lives in public/ (served as-is) rather than src/
// for exactly that reason: Vite must never try to transform this file.
//
// Downsamples the mic's native sample rate (whatever the device gives us,
// commonly 48000Hz) to the 16kHz mono Int16 PCM the server's VAD/ASR models
// expect, buffers ~120ms, and posts each buffer back to the main thread.
// Shorter than it sounds like it needs to be on purpose: whatever's left in
// this buffer when someone stops talking has to wait for the *next* full
// frame before the server's VAD even sees the silence that ends the segment
// — that tail wait is pure added latency, and it was the visible majority of
// the "why does this take so long to show up" delay at 500ms. Kept in step
// with AUDIO_FRAME_BURST in server/events.js: halving this doubles the frame
// rate, and the server's rate limiter has to be raised to match or normal
// speech gets throttled mid-sentence.
const TARGET_RATE = 16000;
const FRAME_MS = 120;

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in the AudioWorkletGlobalScope — the
    // AudioContext's native rate, not TARGET_RATE
    this.ratio = sampleRate / TARGET_RATE;
    this.frameSize = Math.round(TARGET_RATE * (FRAME_MS / 1000));
    this.buffer = new Int16Array(this.frameSize);
    this.writeIndex = 0;
    this.srcPos = 0; // fractional read position, carried across render calls
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true; // mic momentarily silent/muted — keep the node alive

    // linear-interpolation resample: cheap enough for a ~128-sample render
    // quantum every ~2.7ms, and plenty accurate for speech ASR (which itself
    // only expects 16kHz, not high fidelity)
    let pos = this.srcPos;
    while (pos < input.length) {
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = pos - i0;
      const sample = input[i0] + (input[i1] - input[i0]) * frac;
      this.buffer[this.writeIndex++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));
      if (this.writeIndex >= this.frameSize) {
        const copy = this.buffer.buffer.slice(0); // detach a copy — the original keeps filling below
        this.port.postMessage(copy, [copy]);
        this.writeIndex = 0;
      }
      pos += this.ratio;
    }
    this.srcPos = pos - input.length;
    return true;
  }
}

registerProcessor('mic-capture-processor', MicCaptureProcessor);
