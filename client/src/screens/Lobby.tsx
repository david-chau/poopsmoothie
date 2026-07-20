import { useRef, useState, type KeyboardEvent } from 'react';
import { useGame } from '../GameContext';
import { emitAck } from '../socket';
import { copyText } from '../lib';
import { TEAM_LABELS, TEAM_CLASS, ROUND_LABELS, ROUND_ICONS, type Team } from '../types';

const SKIP_ROUNDS = ['ROUND1', 'ROUND2', 'ROUND3'] as const;
type SkipRound = (typeof SKIP_ROUNDS)[number];
import RulesDialog from '../components/RulesDialog';

export default function Lobby() {
  const { state: gameState, identity: me, isHost, leaveToLanding } = useGame();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const rulesRef = useRef<HTMLDialogElement>(null);
  // Local draft state, not bound to the server on every keystroke: a fully
  // server-controlled input fights the user mid-edit — backspace to empty
  // sends 0, the server (previously) silently ignored 0 and rebroadcast the
  // old value, snapping the field back before the next keystroke landed.
  // These only sync TO the server on blur.
  const [wordsInput, setWordsInput] = useState(() => String(gameState?.config.wordsPerPlayer ?? 5));
  const [turnInput, setTurnInput] = useState(() => String(gameState?.config.turnSeconds ?? 60));
  if (!gameState || !me) return null;
  // narrowed locals so closures below (TS can't narrow across nested functions) stay non-null
  const state = gameState;
  const identity = me;

  const teamA = state.players.filter((p) => p.team === 'A');
  const teamB = state.players.filter((p) => p.team === 'B');
  const connectedCount = state.players.filter((p) => p.connected).length;

  async function switchTeam(targetPlayerId: string, team: Team) {
    const res = await emitAck<{ ok: boolean; error?: string }>('set-team', { targetPlayerId, team });
    setError(res.ok ? null : (res.error ?? 'could not change team'));
  }

  async function updateConfig(
    patch: Partial<{ wordsPerPlayer: number; turnSeconds: number; allowSkip: Partial<Record<SkipRound, boolean>> }>,
  ) {
    const res = await emitAck<{ ok: boolean; error?: string }>('set-config', patch);
    setError(res.ok ? null : (res.error ?? 'could not update settings'));
    return res.ok;
  }

  async function toggleAllowSkip(round: SkipRound) {
    await updateConfig({ allowSkip: { [round]: !state.config.allowSkip[round] } });
  }

  async function commitWordsPerPlayer() {
    const n = Math.max(1, Math.min(20, Math.round(Number(wordsInput)) || state.config.wordsPerPlayer));
    setWordsInput(String(n));
    if (n !== state.config.wordsPerPlayer) await updateConfig({ wordsPerPlayer: n });
  }

  async function commitTurnSeconds() {
    const n = Math.max(10, Math.min(300, Math.round(Number(turnInput)) || state.config.turnSeconds));
    setTurnInput(String(n));
    if (n !== state.config.turnSeconds) await updateConfig({ turnSeconds: n });
  }

  function blurOnEnter(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') e.currentTarget.blur();
  }

  async function startGame() {
    const res = await emitAck<{ ok: boolean; error?: string }>('start-game');
    setError(res.ok ? null : (res.error ?? 'could not start'));
  }

  async function copyInviteLink() {
    // a link is easier to share/tap than reading out a 4-letter code
    const url = `${window.location.origin}/join/${state.code}`;
    const ok = await copyText(url);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  function TeamColumn({ team, players }: { team: Team; players: typeof teamA }) {
    return (
      <div className={`team-column ${TEAM_CLASS[team]}`}>
        <h3 className={TEAM_CLASS[team]}>Team {TEAM_LABELS[team]}</h3>
        <ul className="player-list">
          {players.map((p) => (
            <li key={p.id} className={p.connected ? '' : 'disconnected'}>
              <span className="dot" />
              <span className={TEAM_CLASS[team]}>{p.name}</span>
              {p.id === state.hostId && <span className="badge">host</span>}
              {(p.id === identity.playerId || isHost) && (
                <button className="link-btn" onClick={() => switchTeam(p.id, team === 'A' ? 'B' : 'A')}>
                  move
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="lobby-topbar">
        <button className="link-btn leave-link" onClick={leaveToLanding}>
          &larr; Leave room
        </button>
        <button className="link-btn" onClick={() => rulesRef.current?.showModal()}>
          📜 How to play
        </button>
      </div>
      <RulesDialog ref={rulesRef} />

      <div className="room-code-block">
        <div className="room-code-row">
          <h1 className="room-code">{state.code}</h1>
          <button className="copy-btn" onClick={copyInviteLink} aria-label="Copy invite link" title="Copy invite link">
            {copied ? '✅' : '📋'}
          </button>
        </div>
        <p className="subtitle">Share this code with your guests</p>
      </div>

      <div className="teams-grid">
        <TeamColumn team="A" players={teamA} />
        <TeamColumn team="B" players={teamB} />
      </div>

      {isHost && (
        <div className="card">
          <h2>Settings</h2>
          <label className="field">
            <span>Words per player</span>
            <input
              type="number"
              min={1}
              max={20}
              value={wordsInput}
              onChange={(e) => setWordsInput(e.target.value)}
              onBlur={commitWordsPerPlayer}
              onKeyDown={blurOnEnter}
            />
          </label>
          <label className="field">
            <span>Turn seconds</span>
            <input
              type="number"
              min={10}
              max={300}
              value={turnInput}
              onChange={(e) => setTurnInput(e.target.value)}
              onBlur={commitTurnSeconds}
              onKeyDown={blurOnEnter}
            />
          </label>
          <div className="field">
            <span>Allow pass</span>
            <div className="skip-toggle-group">
              {SKIP_ROUNDS.map((round) => (
                <label key={round} className="skip-toggle">
                  <input type="checkbox" checked={state.config.allowSkip[round]} onChange={() => toggleAllowSkip(round)} />
                  {ROUND_ICONS[round]} {ROUND_LABELS[round]}
                </label>
              ))}
            </div>
          </div>
          <button className="btn btn-primary" onClick={startGame} disabled={connectedCount < 4}>
            Start game {connectedCount < 4 && `(need ${4 - connectedCount} more)`}
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
