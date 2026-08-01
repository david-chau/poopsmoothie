import { useEffect, useRef, useState } from 'react';
import { useGame } from '../GameContext';
import { emitAck, onVoiceAvailable, voiceHttpsUrl } from '../socket';
import { useOpenMic, MIN_ENERGY_RANGE } from '../useOpenMic';
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

  /** Corrects a line you sent — mainly for a voice mishear ("Too" landing as
   *  "True."). Server re-checks it's actually your own message; the update
   *  arrives back over the socket (GameContext's chat-message-updated), same
   *  as any other player would see it, rather than trusted optimistically. */
  async function editMessage(id: string, text: string) {
    const res = await emitAck<{ ok: boolean; error?: string }>('chat-edit', { id, text });
    return res;
  }

  async function deleteMessage(id: string) {
    return emitAck<{ ok: boolean; error?: string }>('chat-delete', { id });
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
          </button>
        )}
        {/* level + threshold live next to the toggle they belong to, rather
            than in a block of their own — as a boxed row with its own caption
            they cost more vertical space than the chat log they sat above */}
        {micVisible && mic.on && <MicMeter level={mic.level} sensitivity={mic.sensitivity} onChange={mic.setSensitivity} />}
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
          <ChatRow
            key={m.id}
            message={m}
            isMine={m.playerId === identity?.playerId}
            onEdit={editMessage}
            onDelete={deleteMessage}
          />
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

/** The meter's full-scale RMS. Normal speech at arm's length sits around
 *  0.05-0.15, so showing the full 0..1 range would squash every real reading
 *  into the leftmost sliver and make the threshold impossible to judge. */
const METER_FULL_SCALE = 0.25;

const pct = (v: number) => `${Math.min(100, Math.max(0, (v / METER_FULL_SCALE) * 100))}%`;

/**
 * Live input level with the cutoff drawn on top of it. The number that
 * matters isn't the level or the threshold alone, it's whether one clears the
 * other — so they share one bar rather than sitting in separate widgets: talk
 * normally, and if the fill doesn't pass the marker, the server is discarding
 * you. Bar segments past the marker are tinted to make "this counts" obvious
 * without needing the legend.
 */
function MicMeter({
  level,
  sensitivity,
  onChange,
}: {
  level: number;
  sensitivity: number;
  onChange: (v: number) => void;
}) {
  const passing = level >= sensitivity;
  return (
    <div className="mic-meter" title="Live input level. Your speech should push the bar past the line — drag the slider right to ignore more distant/quiet sound.">
      <div className="mic-meter-bar" role="presentation">
        <div className={`mic-meter-fill${passing ? ' mic-meter-fill-passing' : ''}`} style={{ width: pct(level) }} />
        <div className="mic-meter-threshold" style={{ left: pct(sensitivity) }} />
      </div>
      <input
        className="mic-meter-slider"
        type="range"
        min={MIN_ENERGY_RANGE.min}
        max={MIN_ENERGY_RANGE.max}
        step={0.002}
        value={sensitivity}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Mic sensitivity"
      />
    </div>
  );
}

/** Clock time, not "3s ago" — the whole point of this log is settling "who
 *  said what, when", and a relative label needs re-rendering to stay true. */
function clockTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ChatRow({
  message,
  isMine,
  onEdit,
  onDelete,
}: {
  message: ChatMessage;
  isMine: boolean;
  onEdit: (id: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = draft.trim();
    if (!trimmed) return setError('message can\'t be empty — delete it instead');
    if (trimmed === message.text) return setEditing(false); // nothing actually changed
    setBusy(true);
    setError(null);
    const res = await onEdit(message.id, trimmed);
    setBusy(false);
    if (res.ok) setEditing(false);
    else setError(res.error ?? 'could not save');
  }

  async function del() {
    setBusy(true);
    const res = await onDelete(message.id);
    setBusy(false);
    // a failure here (round already moved on, connection dropped) leaves the
    // row as-is rather than silently vanishing something that didn't delete
    if (!res.ok) setError(res.error ?? 'could not delete');
  }

  if (editing) {
    return (
      <li className="turn-chat-row turn-chat-row-editing">
        <input
          className="turn-chat-edit-input"
          value={draft}
          autoFocus
          maxLength={200}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <button className="turn-chat-row-action" disabled={busy} onClick={save} aria-label="Save correction" title="Save">
          ✓
        </button>
        <button
          className="turn-chat-row-action"
          disabled={busy}
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          aria-label="Cancel edit"
          title="Cancel"
        >
          ✕
        </button>
        {error && <span className="error turn-chat-row-error">{error}</span>}
      </li>
    );
  }

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
      {message.edited && (
        <span className="turn-chat-edited" title="Corrected by whoever sent it">
          (edited)
        </span>
      )}
      {isMine && (
        <span className="turn-chat-row-actions">
          <button
            className="turn-chat-row-action"
            disabled={busy}
            onClick={() => {
              setDraft(message.text);
              setError(null);
              setEditing(true);
            }}
            aria-label="Edit your message"
            title="Edit — e.g. fix a voice mishear"
          >
            ✏️
          </button>
          <button className="turn-chat-row-action" disabled={busy} onClick={del} aria-label="Delete your message" title="Delete">
            🗑️
          </button>
        </span>
      )}
      {error && <span className="error turn-chat-row-error">{error}</span>}
    </li>
  );
}
