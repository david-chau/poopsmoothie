import { useRef, useState } from 'react';
import { useGame } from '../GameContext';
import { emitAck } from '../socket';
import { TEAM_LABELS, TEAM_CLASS, ROUND_LABELS } from '../types';

const ROUND_KEYS = ['ROUND1', 'ROUND2', 'ROUND3'] as const;

interface AckResult {
  ok: boolean;
  error?: string;
  text?: string | null;
}

/** Host-only escape hatches, tucked behind one button so nothing here gets
 *  fat-fingered mid-turn. Native <dialog> for the backdrop, Esc-to-close and
 *  focus trap (same trick as RulesDialog), pinned to the bottom as a sheet:
 *  header stays put, only the body scrolls. */
export default function AdminDrawer() {
  const { state } = useGame();
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [handTo, setHandTo] = useState('');
  const [kickTarget, setKickTarget] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);

  if (!state) return null;
  const { round } = state;
  const hostPaused = round.paused && round.pauseReason === 'host-paused';
  const guessedSlips = state.guessedSlips ?? [];

  async function run(event: string, payload?: unknown, okNote?: string) {
    const res = await emitAck<AckResult>(event, payload);
    setError(res.ok ? null : (res.error ?? 'action failed'));
    if (!res.ok) return setNote(null);
    setNote(res.text ? `${okNote ?? 'Done'} — “${res.text}”` : (okNote ?? 'Done'));
  }

  function open() {
    setError(null);
    setNote(null);
    setConfirmEnd(false);
    ref.current?.showModal();
  }

  async function kick() {
    const name = state!.players.find((p) => p.id === kickTarget)?.name ?? 'this player';
    if (!window.confirm(`Remove ${name} from the room?`)) return;
    await run('kick-player', { playerId: kickTarget }, `Removed ${name}`);
    setKickTarget('');
  }

  // kills the room for everyone, so it takes two taps rather than a confirm()
  async function endRoom() {
    if (!confirmEnd) return setConfirmEnd(true);
    await emitAck('end-room');
    ref.current?.close?.(); // the room-closed broadcast sends us to the landing
  }

  return (
    <>
      <button className="link-btn skip-link" onClick={open}>
        ⚙️ Admin controls
      </button>

      <dialog ref={ref} className="admin-drawer">
        <div className="admin-drawer-head">
          <h2>Admin controls</h2>
          <form method="dialog">
            <button className="link-btn" aria-label="Close admin controls">
              Close
            </button>
          </form>
        </div>

        <div className="admin-drawer-body">
          <h3>This turn</h3>
          <div className="admin-grid">
            <button className="btn" onClick={() => run('skip-drawer', undefined, 'Skipped to the next drawer')}>
              Skip stuck drawer
            </button>
            <button className="btn" onClick={() => run('force-pass-team', undefined, 'Turn handed to the other team')}>
              Force pass to other team
            </button>
          </div>
          {hostPaused ? (
            <button className="btn btn-primary admin-wide" onClick={() => run('resume-turn', undefined, 'Game resumed')}>
              ▶️ Resume game
            </button>
          ) : (
            <button className="btn admin-wide" onClick={() => run('host-pause', undefined, 'Game paused')}>
              ⏸️ Pause game
            </button>
          )}

          <h3>Scoring</h3>
          <button className="btn admin-wide" onClick={() => run('revert-last-guess', undefined, 'Reverted')}>
            ↩️ Revert last correct word
          </button>

          <h3>Who guessed what</h3>
          {guessedSlips.length === 0 ? (
            <p className="admin-hint">Nothing guessed yet — words show up here once they&rsquo;ve been scored.</p>
          ) : (
            <>
              <div className="admin-table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Word</th>
                      {ROUND_KEYS.map((phase) => (
                        <th key={phase}>{ROUND_LABELS[phase]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {guessedSlips.map((slip) => (
                      <tr key={slip.id}>
                        <th scope="row">{slip.text}</th>
                        {ROUND_KEYS.map((phase, i) => {
                          const round = i + 1;
                          const hit = slip.scoredBy?.find((s) => s.round === round);
                          return (
                            <td key={phase}>
                              <select
                                className={`admin-select ${hit ? TEAM_CLASS[hit.team] : ''}`}
                                aria-label={`Who guessed “${slip.text}” in ${ROUND_LABELS[phase]}`}
                                value={hit?.playerId ?? ''}
                                onChange={(e) =>
                                  run(
                                    'set-slip-scorer',
                                    { slipId: slip.id, round, playerId: e.target.value || null },
                                    'Scoring updated',
                                  )
                                }
                              >
                                <option value="">—</option>
                                {state!.players.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="admin-hint">
                Team scores follow from this — pick who actually got it, or “—” to un-score that round.
              </p>
            </>
          )}

          <h3>Hand turn to someone else</h3>
          <div className="admin-grid">
            <select className="admin-select" value={handTo} onChange={(e) => setHandTo(e.target.value)}>
              <option value="">Choose a player…</option>
              {state.players
                .filter((p) => p.connected)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (Team {TEAM_LABELS[p.team]})
                  </option>
                ))}
            </select>
            <button
              className="btn"
              disabled={!handTo}
              onClick={() => run('set-drawer', { playerId: handTo }, 'Turn handed over')}
            >
              Hand over
            </button>
          </div>
          <p className="admin-hint">Switches the active team to theirs; any word in hand goes back in the pile.</p>

          <h3>Remove a player</h3>
          <div className="admin-grid">
            <select className="admin-select" value={kickTarget} onChange={(e) => setKickTarget(e.target.value)}>
              <option value="">Choose a player…</option>
              {state.players
                .filter((p) => p.id !== state!.hostId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.isBot ? ' (bot)' : ''}
                    {p.connected ? '' : ' — offline'}
                  </option>
                ))}
            </select>
            <button className="btn" disabled={!kickTarget} onClick={kick}>
              Kick
            </button>
          </div>
          <p className="admin-hint">
            They&rsquo;re sent back to the home screen. If it&rsquo;s their turn, it passes to the next player.
          </p>

          <h3>Danger zone</h3>
          <button className={`btn admin-wide ${confirmEnd ? 'btn-danger' : ''}`} onClick={endRoom}>
            {confirmEnd ? 'Tap again to end for everyone' : '⛔ End room for everyone'}
          </button>
          <p className="admin-hint">Closes the room and sends every player back to the home screen.</p>

          {error && <p className="error">{error}</p>}
          {note && <p className="admin-note">{note}</p>}
        </div>
      </dialog>
    </>
  );
}
