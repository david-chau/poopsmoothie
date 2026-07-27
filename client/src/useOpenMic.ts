import { useCallback, useEffect, useRef, useState } from 'react';
import { socket, emitAck } from './socket';

const MIC_PREF_KEY = 'poopsmoothie-mic-on';

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

function rmsOf(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i] / 32768) ** 2;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * Open-mic capture: getUserMedia -> AudioWorklet downsamples to 16kHz mono
 * Int16 -> ~250ms frames streamed to the server (server/stt.js does the
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
  const [level, setLevel] = useState(0); // 0..1 RMS, for a "you're speaking" indicator
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<() => void>(() => {});

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
      await emitAck('mic-on');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not access the microphone');
      setOn(false);
      saveMicPref(false);
    }
  }, []);

  const stop = useCallback(() => {
    stopRef.current();
    stopRef.current = () => {};
    setOn(false);
    setLevel(0);
    saveMicPref(false);
    emitAck('mic-off'); // fire-and-forget — a lost socket already cleans this up server-side
  }, []);

  useEffect(() => {
    if (loadMicPref()) start();
    return () => stopRef.current();
    // start/stop are stable (empty deps); only ever auto-resume once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { on, level, error, start, stop };
}
