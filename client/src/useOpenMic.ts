import { useCallback, useEffect, useRef, useState } from 'react';
import { socket, emitAck } from './socket';

const MIC_PREF_KEY = 'poopsmoothie-mic-on';
const SENSITIVITY_KEY = 'poopsmoothie-mic-sensitivity';

/** How loud a segment must be before the server bothers transcribing it, as
 *  an RMS floor. Per *device*, not per room: whether you're across the table
 *  is a property of your phone, not of the game. Higher = stricter = only
 *  clearly-nearby speech gets through. The server clamps to this same range
 *  and never trusts the value raw (see clampFloat in server/events.js). */
export const MIN_ENERGY_RANGE = { min: 0, max: 0.06, default: 0.012 };

/** Same try/catch shape as alert.ts's mute preference and TurnChat's filter —
 *  private mode or a disabled store just means the choice doesn't stick. */
function loadMicPref(): boolean {
  try {
    return localStorage.getItem(MIC_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMicPref(on: boolean) {
  try {
    localStorage.setItem(MIC_PREF_KEY, on ? '1' : '0');
  } catch {
    // in-memory only for this session; not worth surfacing
  }
}

function loadSensitivity(): number {
  try {
    const raw = localStorage.getItem(SENSITIVITY_KEY);
    // `Number(null)` is 0, not NaN — so an unset key would otherwise read as a
    // deliberate "gate disabled" rather than "never chosen", and every fresh
    // device would silently ship with no far-mic filtering at all
    if (raw === null) return MIN_ENERGY_RANGE.default;
    const n = Number(raw);
    // guard NaN *and* a stale value from outside the current range, rather
    // than trusting whatever happens to be in storage
    if (!Number.isFinite(n) || n < MIN_ENERGY_RANGE.min || n > MIN_ENERGY_RANGE.max) return MIN_ENERGY_RANGE.default;
    return n;
  } catch {
    return MIN_ENERGY_RANGE.default;
  }
}

function saveSensitivity(value: number) {
  try {
    localStorage.setItem(SENSITIVITY_KEY, String(value));
  } catch {
    // in-memory only for this session; not worth surfacing
  }
}

/** Shared sentinel rather than a fresh `() => {}` each time, so "is a capture
 *  actually running?" is an identity check instead of a guess. */
const NOOP = () => {};

function rmsOf(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i] / 32768) ** 2;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * Open-mic capture: getUserMedia -> AudioWorklet downsamples to 16kHz mono
 * Int16 -> ~120ms frames streamed to the server (server/stt.js does the
 * actual listening/transcribing). This is the always-listening design the
 * game calls for — no push-to-talk — so the on/off *preference* is
 * remembered per device and resumed automatically: re-clicking a mic toggle
 * at the start of every single turn is exactly the friction this was meant
 * to remove. Nothing here bypasses the browser's own permission model —
 * resuming still calls getUserMedia, which prompts again if the grant is
 * gone.
 */
export function useOpenMic() {
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState(0); // 0..1 RMS, drives the live meter
  const [error, setError] = useState<string | null>(null);
  const [sensitivity, setSensitivityState] = useState<number>(loadSensitivity);
  const stopRef = useRef<() => void>(NOOP);
  // read inside start() without making it a dependency — start is deliberately
  // stable (empty deps) so the mount-time auto-resume effect never re-fires
  const sensitivityRef = useRef(sensitivity);
  sensitivityRef.current = sensitivity;

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule('/audio-worklet.js');
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'mic-capture-processor');
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const samples = new Int16Array(e.data);
        setLevel(rmsOf(samples));
        // volatile: dropped outright if we're disconnected or the transport
        // is momentarily busy, rather than queued — a stale audio frame
        // arriving late is worthless context, same reasoning as the server's
        // TranscriptionQueue shedding stale work under load
        socket.volatile.emit('audio-frame', e.data);
      };
      source.connect(node);
      // deliberately no node.connect(ctx.destination) — capture-only, never
      // played back locally (that would just be a feedback-inducing echo)

      stopRef.current = () => {
        source.disconnect();
        node.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
      };
      setOn(true);
      saveMicPref(true);
      await emitAck('mic-on', { minEnergy: sensitivityRef.current });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not access the microphone');
      setOn(false);
      saveMicPref(false);
    }
  }, []);

  const stop = useCallback(() => {
    stopRef.current();
    stopRef.current = NOOP;
    setOn(false);
    setLevel(0);
    saveMicPref(false);
    emitAck('mic-off'); // fire-and-forget — a lost socket already cleans this up server-side
  }, []);

  /** The session's floor is fixed when it's created server-side, so a change
   *  while live has to re-send mic-on to take effect — otherwise the slider
   *  would silently do nothing until the next toggle. */
  const setSensitivity = useCallback((value: number) => {
    setSensitivityState(value);
    saveSensitivity(value);
    sensitivityRef.current = value;
    if (stopRef.current !== NOOP) emitAck('mic-on', { minEnergy: value });
  }, []);

  useEffect(() => {
    if (loadMicPref()) start();
    return () => stopRef.current();
    // start/stop are stable (empty deps); only ever auto-resume once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { on, level, error, start, stop, sensitivity, setSensitivity };
}
