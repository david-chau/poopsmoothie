import { useEffect, useRef, useState } from 'react';
import { useGame } from '../GameContext';
import { emitAck, onVoiceAvailable, voiceHttpsUrl } from '../socket';
import { useOpenMic } from '../useOpenMic';
import { useVoiceEnroll } from '../useVoiceEnroll';
import VoiceEnroll from './VoiceEnroll';
import { TEAM_CLASS, type ChatMessage } from '../types';

type Filter = 'all' | 'team' | 'drawer';

const FILTER_KEY = 'poopsmoothie-chat-filter';

/** Same try/catch shape as alert.ts's mute preference — private mode or a
 *  disabled store just means the choice doesn't stick, never a crash. */
function loadFilter(): Filter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === 'team' || v === 'drawer' ? v : 'all';
  } catch {
    return 'all';
  }
}

function saveFilter(f: Filter) {
  try {
    localStorage.setItem(FILTER_KEY, f);
  } catch {
    // in-memory only for this session; not worth surfacing
  }
}

/**
 * The audit trail: an on-the-record transcript of the current round, so "I
 * said Titanic before the buzzer" has an answer.
 *
 * Scoped to the live round only — server/rooms.js clears `round.chat` at the
 * start of every round, same lifetime as `guessedThisRound`. Everything here
 * was already said out loud in the room (or typed to everyone), so there's
 * nothing to protect; the filters exist because the *other* team's chatter is
 * noise, not because it's secret.
 *
 * The mic toggle only appears once the server confirms voice capture is
 * actually available (models loaded — see server/stt.js) and this browser
 * supports getUserMedia; otherwise this is exactly the Phase 1 text-only
 * component. A `via: 'voice'` message (🎤 marker) may have been captured by
 * this device's own mic or relayed by the server from someone else's.
 *
 * The toggle also *is* the enrollment flow the first time: a voiceprint has
 * to exist before there's anything to match against, so tapping it when
 * unenrolled records the sample first and only then starts listening,
 * instead of a separate "Record a sample" control sitting next to an "on"
 * button that's really a second step of the same action.
 */
export default function TurnChat() {
  const { state, identity, isDrawer } = useGame();
  const [filter, setFilter] = useState<Filter>(loadFilter);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const mic = useOpenMic();
  const enroll = useVoiceEnroll();
  // recomputed per render rather than hoisted to module scope, so it reflects
  // this browser right now rather than whatever navigator looked like the
  // instant this module first loaded
  const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const micVisible = micSupported && voiceAvailable;
  // The server has voice, this browser can't use it here — which on a LAN is
  // almost always "you're on the http URL". Say so, with the URL that works,
  // rather than leaving a feature-shaped hole.
  const httpsUrl = voiceAvailable && !micSupported ? voiceHttpsUrl() : null;

  useEffect(() => onVoiceAvailable(setVoiceAvailable), []);
  const listRef = useRef<HTMLUListElement>(null);
  // whether we were scrolled near the bottom *before* this render's messages
  // landed — read in an effect below, so a message arriving while someone has
  // scrolled up to reread something doesn't yank them back down
  const wasNearBottom = useRef(true);

  const messages = state?.round.chat ?? [];
  const me = state?.players.find((p) => p.id === identity?.playerId);
  const myTeam = me?.team;
  const voiceEnrolled = !!me?.voiceEnrolled || enroll.justEnrolled;

  async function handleMicClick() {
    if (mic.on) {
      mic.stop();
      return;
    }
    if (!voiceEnrolled && !(await enroll.record())) return;
    mic.start();
  }

  const visible = messages.filter((m) => {
    if (filter === 'drawer') return m.wasDrawer;
    if (filter === 'team') return m.team === myTeam;
    return true;
  });

  useEffect(() => {
    const el = listRef.current;
    if (el && wasNearBottom.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    wasNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  function changeFilter(f: Filter) {
    setFilter(f);
    saveFilter(f);
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    const res = await emitAck<{ ok: boolean; error?: string }>('chat-send', { text });
    setBusy(false);
    if (res.ok) setDraft('');
    else setError(res.error ?? 'could not send');
  }

  if (!state) return null;

  return (
    <div className="card turn-chat">
      <div className="turn-chat-head">
        <h3>Chat</h3>
        {micVisible && (
          <button
            className={`btn turn-chat-mic${mic.on ? ' turn-chat-mic-on' : ''}`}
            onClick={handleMicClick}
            disabled={enroll.recording}
            aria-pressed={mic.on}
            title={
              mic.on
                ? 'Mic is listening — tap to stop'
                : voiceEnrolled
                  ? 'Tap to let the table hear you'
                  : 'Tap to record a 5s voice sample, then start listening'
            }
          >
            {enroll.recording
              ? `Recording… ${enroll.secondsLeft}s`
              : mic.on
                ? '🎤 On'
                : voiceEnrolled
                  ? '🎤 Off'
                  : '🎙️ Record 5s sample'}
            {mic.on && (
              <span className="turn-chat-mic-level" style={{ opacity: Math.min(1, 0.25 + mic.level * 6) }} />
            )}
          </button>
        )}
        <div className="turn-chat-filters" role="group" aria-label="Filter chat">
          {(['all', 'team', 'drawer'] as Filter[]).map((f) => (
            <button
              key={f}
              className={`turn-chat-filter${filter === f ? ' turn-chat-filter-active' : ''}`}
              onClick={() => changeFilter(f)}
              aria-pressed={filter === f}
            >
              {f === 'all' ? 'All' : f === 'team' ? 'My team' : 'Drawer'}
            </button>
          ))}
        </div>
      </div>

      {micVisible && <VoiceEnroll enrolled={voiceEnrolled} />}

      {httpsUrl && (
        <p className="turn-chat-https-hint">
          🎤 Voice chat needs a secure connection —{' '}
          <a href={httpsUrl}>open this room over https</a> (your browser will warn once about the
          self-signed certificate; that's expected on a home server). Typing works either way.
        </p>
      )}

      <ul className="turn-chat-log" ref={listRef} onScroll={handleScroll}>
        {visible.length === 0 && <li className="turn-chat-empty">Nothing here yet.</li>}
        {visible.map((m) => (
          <ChatRow key={m.id} message={m} />
        ))}
      </ul>

      <div className="turn-chat-compose">
        <input
          className="turn-chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          placeholder={isDrawer ? 'Say something (careful, no giving it away!)' : 'Say something…'}
          maxLength={200}
        />
        <button className="btn turn-chat-send" disabled={!draft.trim() || busy} onClick={send}>
          Send
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {mic.error && <p className="error">Mic: {mic.error}</p>}
      {enroll.error && <p className="error">Voice ID: {enroll.error}</p>}
    </div>
  );
}

/** Clock time, not "3s ago" — the whole point of this log is settling "who
 *  said what, when", and a relative label needs re-rendering to stay true. */
function clockTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ChatRow({ message }: { message: ChatMessage }) {
  return (
    <li className="turn-chat-row">
      <span className="turn-chat-time">{clockTime(message.at)}</span>
      <span className={`turn-chat-name ${TEAM_CLASS[message.team]}`}>{message.name}</span>
      {message.wasDrawer && (
        <span className="badge turn-chat-badge" title="Was drawing when they said this">
          drawer
        </span>
      )}
      {message.via === 'voice' && (
        <span className="turn-chat-voice" title="Captured from voice">
          🎤
        </span>
      )}
      <span className="turn-chat-text">{message.text}</span>
    </li>
  );
}
