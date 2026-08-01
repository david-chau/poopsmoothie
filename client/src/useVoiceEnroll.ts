import { useCallback, useRef, useState } from 'react';
import { emitAck } from './socket';

export const DEFAULT_RECORD_SECONDS = 5;

/**
 * One-shot voiceprint recording (Phase 5): closes the gap dedup alone can't —
 * a phone in someone's pocket that never captures them at all. Reuses the
 * same downsampling worklet as the continuous open mic (useOpenMic.ts), just
 * for a fixed few seconds instead of an ongoing stream, sent as one buffer
 * rather than a live feed. Skipping this is fine — voice chat still works via
 * device-prior attribution and cross-device dedup (Phases 3-4); this only
 * sharpens it.
 *
 * `record()` resolves `true`/`false` rather than throwing, so a caller (the
 * mic toggle, enrolling on first use — see TurnChat) can chain straight into
 * starting the mic without a try/catch of its own.
 *
 * `recordSeconds` is overridable mainly so tests aren't stuck waiting out a
 * real 5s countdown with real timers (fake timers + getUserMedia's real
 * Promise chain don't interleave reliably).
 */
export function useVoiceEnroll(recordSeconds = DEFAULT_RECORD_SECONDS) {
  const [recording, setRecording] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(recordSeconds);
  const [error, setError] = useState<string | null>(null);
  const [justEnrolled, setJustEnrolled] = useState(false);
  const busyRef = useRef(false);

  const record = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setError(null);
    setJustEnrolled(false);
    let cleanup = () => {};
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule('/audio-worklet.js');
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'mic-capture-processor');
      const chunks: ArrayBuffer[] = [];
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => chunks.push(e.data);
      source.connect(node);
      cleanup = () => {
        source.disconnect();
        node.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
      };

      setRecording(true);
      setSecondsLeft(recordSeconds);
      // the countdown ticks once a second purely for display; the actual
      // stop condition is one timeout for the whole duration, so a shorter
      // (e.g. test-only) recordSeconds isn't held hostage to a 1s-per-tick floor
      await new Promise<void>((resolve) => {
        const tick = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
        setTimeout(() => {
          clearInterval(tick);
          resolve();
        }, recordSeconds * 1000);
      });
      cleanup();
      setRecording(false);

      const totalBytes = chunks.reduce((sum, c) => sum + c.byteLength, 0);
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }

      const res = await emitAck<{ ok: boolean; error?: string }>('enroll-voice', merged.buffer);
      if (res.ok) {
        setJustEnrolled(true);
        return true;
      }
      setError(res.error ?? 'could not save your voice sample');
      return false;
    } catch (err) {
      cleanup();
      setRecording(false);
      setError(err instanceof Error ? err.message : 'could not access the microphone');
      return false;
    } finally {
      busyRef.current = false;
    }
  }, [recordSeconds]);

  return { recording, secondsLeft, error, justEnrolled, record };
}
