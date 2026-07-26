import { useEffect, useRef, useState } from 'react';
import { useGame } from '../GameContext';
import { socket, emitAck } from '../socket';
import { ROUND_LABELS, BOT_NAME_PREFIX, type Phase } from '../types';
import { primeAudio } from '../alert';
import RulesDialog from '../components/RulesDialog';

/** Shown as the name placeholder and as the tooltip on anything a missing
 *  name blocks — the disabled buttons alone didn't say why. */
const NEEDS_NAME = 'Please enter your name';

/** "In lobby" / "Writing words" / "Round 2 · Charades" */
function lobbyStatus(phase: Phase): string {
  if (phase === 'LOBBY') return 'In lobby';
  if (phase === 'WRITING') return 'Writing words';
  const n = ['ROUND1', 'ROUND2', 'ROUND3'].indexOf(phase) + 1;
  return `Round ${n} · ${ROUND_LABELS[phase]}`;
}

interface Lobby {
  code: string;
  playerCount: number;
  hostName: string | null;
  phase: Phase;
}

/** Supports sharing a room as a link (`/join/ABCD`) instead of just the bare
 * code — the server's catch-all route already serves the SPA for any path,
 * so this is purely a client-side prefill. */
function joinCodeFromUrl(): string {
  const match = window.location.pathname.match(/^\/join\/([A-Za-z0-9]{4})$/);
  return match ? match[1].toUpperCase() : '';
}

export default function Landing() {
  const { createRoom, joinRoom } = useGame();
  const [name, setName] = useState(() => localStorage.getItem('poopsmoothie-name') ?? '');
  const [roomCode, setRoomCode] = useState(() => joinCodeFromUrl());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
  const rulesRef = useRef<HTMLDialogElement>(null);

  // clean the URL back to "/" once we've read it — nothing else in this
  // single-page app cares about the path, and leaving it would just re-parse
  // stale state on every reload
  useEffect(() => {
    if (window.location.pathname !== '/') window.history.replaceState(null, '', '/');
  }, []);

  // ask once for the current list, then let the server push updates as rooms
  // open and fill up
  useEffect(() => {
    let live = true;
    // A broadcast can beat the initial reply (someone opens a room in the split
    // second we're asking). The reply is a snapshot from *before* that, so once
    // a push has landed it must not overwrite it.
    let pushed = false;
    emitAck<{ ok: boolean; lobbies?: Lobby[] }>('list-lobbies').then((res) => {
      if (live && !pushed) setLobbies(res.lobbies ?? []);
    });
    const onLobbies = (next: Lobby[]) => {
      pushed = true;
      setLobbies(next);
    };
    socket.on('lobbies', onLobbies);
    return () => {
      live = false;
      socket.off('lobbies', onLobbies);
    };
  }, []);

  function rememberName(value: string) {
    setName(value);
    localStorage.setItem('poopsmoothie-name', value);
  }

  const code = roomCode.trim().toUpperCase();
  const named = !!name.trim();
  const ready = !busy && named;

  /** Tapping a room joins straight in — the server drops you on whichever team
   *  is short (Team Blue on a tie), so there's nothing to pick on the way in. */
  async function go(joinCode = '') {
    // everyone hears the turn-end alert, not just the drawer, and browsers only
    // unlock audio after a real gesture — this tap is the one every player makes
    primeAudio();
    if (!named) return setError('enter your name first');
    // the server refuses this too — checked here so it fails as you tap rather
    // than after a round trip
    if (name.trim().toLowerCase().startsWith(BOT_NAME_PREFIX.trim().toLowerCase())) {
      return setError('Invalid name — that prefix is reserved for bots');
    }
    setBusy(true);
    setError(null);
    // createRoom's reply is narrower than joinRoom's; widen so the reclaim
    // fields below are reachable without casting
    type Outcome = { ok: boolean; error?: string; canReclaim?: boolean; name?: string };
    let res: Outcome = joinCode ? await joinRoom(joinCode, name.trim()) : await createRoom(name.trim());

    // The name is already in this room but nobody is on it — almost always the
    // same person on a new device or after a reload. Confirm rather than
    // silently assuming someone else's identity, team and score.
    if (!res.ok && res.canReclaim && joinCode) {
      const confirmed = window.confirm(`"${res.name}" is already in this room but offline. Join back as them?`);
      if (confirmed) res = await joinRoom(joinCode, name.trim(), { reclaim: true });
      else {
        setBusy(false);
        return setError('Pick a different name to join as someone new.');
      }
    }

    setBusy(false);
    if (!res.ok) setError(res.error ?? (joinCode ? 'could not join room' : 'could not create room'));
  }

  return (
    <div className="screen screen-center">
      <div className="landing">
        <header className="landing-head">
          <h1 className="title">💩🥤 Poopsmoothie</h1>
          <p className="subtitle">Write nouns. Split into teams. Guess like crazy.</p>
        </header>

        <div className="card landing-card">
          <label className="field">
            <span>Your name</span>
            <input
              value={name}
              onChange={(e) => rememberName(e.target.value)}
              placeholder={NEEDS_NAME}
              maxLength={40}
              autoComplete="off"
            />
          </label>

          <div className="lobby-panel-head">
            <h2>Open rooms</h2>
            <span className="lobby-count">{lobbies.length} open</span>
          </div>

          {lobbies.length === 0 ? (
            <p className="lobby-empty">No rooms yet — start one below.</p>
          ) : (
            <>
              {/* the title sits on each <li>, not the button: browsers don't show
                  tooltips for disabled form controls, so it'd never appear */}
              <ul className="lobby-list">
                {lobbies.map((lobby) => (
                  <li key={lobby.code} title={named ? undefined : NEEDS_NAME}>
                    <button className="lobby-row" disabled={!ready} onClick={() => go(lobby.code)}>
                      <span className="lobby-row-top">
                        <span className="lobby-code">{lobby.code}</span>
                        {lobby.phase !== 'LOBBY' && <span className="lobby-live">live</span>}
                      </span>
                      <span className="lobby-meta">
                        {lobby.hostName ? `${lobby.hostName}'s room · ` : ''}
                        {lobbyStatus(lobby.phase)} · {lobby.playerCount}{' '}
                        {lobby.playerCount === 1 ? 'player' : 'players'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <small className="field-hint">
                Tap a room to jump in — you&rsquo;ll land on whichever team is short. Rooms marked{' '}
                <em>live</em> are already playing and allow hot join.
              </small>
            </>
          )}

          <span title={named ? undefined : NEEDS_NAME}>
            <button className="btn btn-primary" disabled={!ready} onClick={() => go()}>
              ➕ Start a new game
            </button>
          </span>

          {/* secondary path: everyone on this wifi sees the list above, so a
              code is only needed for a shared /join/ link (which prefills and
              auto-opens this) or a room that hasn't shown up yet */}
          <details className="code-details" open={!!roomCode}>
            <summary>Join with a room code</summary>
            <div className="code-row">
              <input
                className="room-code-input"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase().slice(0, 4))}
                placeholder="ABCD"
                maxLength={4}
                autoCapitalize="characters"
                autoComplete="off"
                aria-label="Room code"
              />
              <span title={named ? undefined : NEEDS_NAME}>
                <button className="btn" disabled={!ready || code.length !== 4} onClick={() => go(code)}>
                  Join
                </button>
              </span>
            </div>
          </details>

          {error && <p className="error landing-error">{error}</p>}
        </div>

        <button className="link-btn landing-rules" onClick={() => rulesRef.current?.showModal()}>
          📜 How to play
        </button>
        <RulesDialog ref={rulesRef} />
      </div>
    </div>
  );
}
