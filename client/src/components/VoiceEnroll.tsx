import { useVoiceEnroll, DEFAULT_RECORD_SECONDS } from '../useVoiceEnroll';

/**
 * Re-record affordance for a player who already has a voiceprint. First-time
 * enrollment happens from the mic toggle itself (TurnChat merges "record a
 * sample" and "start listening" into one control, since the sample has to
 * exist before there's anything to match against) — this component only
 * renders once `enrolled`, so it's never a second, competing "record a
 * sample" button sitting next to that toggle.
 */
export default function VoiceEnroll({
  enrolled,
  recordSeconds = DEFAULT_RECORD_SECONDS,
}: {
  enrolled: boolean;
  recordSeconds?: number;
}) {
  const { recording, secondsLeft, error, justEnrolled, record } = useVoiceEnroll(recordSeconds);
  const done = enrolled || justEnrolled;
  if (!done) return null;

  return (
    <div className="voice-enroll">
      <span className="voice-enroll-status">🎙️ Voice ID ready</span>
      <button className="btn voice-enroll-btn" onClick={record} disabled={recording}>
        {recording ? `Recording… ${secondsLeft}s` : 'Re-record'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
