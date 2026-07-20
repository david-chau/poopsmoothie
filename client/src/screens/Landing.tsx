import { useRef, useState } from 'react';
import { useGame } from '../GameContext';
import RulesDialog from '../components/RulesDialog';

export default function Landing() {
  const { createRoom, joinRoom } = useGame();
  const [name, setName] = useState(() => localStorage.getItem('poopsmoothie-name') ?? '');
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rulesRef = useRef<HTMLDialogElement>(null);

  function rememberName(value: string) {
    setName(value);
    localStorage.setItem('poopsmoothie-name', value);
  }

  async function handleCreate() {
    if (!name.trim()) return setError('enter your name first');
    setBusy(true);
    setError(null);
    const res = await createRoom(name.trim());
    setBusy(false);
    if (!res.ok) setError(res.error ?? 'could not create room');
  }

  async function handleJoin() {
    if (!name.trim()) return setError('enter your name first');
    if (roomCode.trim().length !== 4) return setError('room code is 4 letters');
    setBusy(true);
    setError(null);
    const res = await joinRoom(roomCode.trim().toUpperCase(), name.trim());
    setBusy(false);
    if (!res.ok) setError(res.error ?? 'could not join room');
  }

  return (
    <div className="screen screen-center">
      <h1 className="title">💩🥤 Poopsmoothie</h1>
      <p className="subtitle">Write nouns. Split into teams. Guess like crazy.</p>
      <button className="link-btn" onClick={() => rulesRef.current?.showModal()}>
        📜 How to play
      </button>
      <RulesDialog ref={rulesRef} />

      <label className="field">
        <span>Your name</span>
        <input
          value={name}
          onChange={(e) => rememberName(e.target.value)}
          placeholder="Dave"
          maxLength={40}
          autoComplete="off"
        />
      </label>

      <div className="card">
        <h2>Join a room</h2>
        <label className="field">
          <span>Room code</span>
          <input
            className="room-code-input"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value.toUpperCase().slice(0, 4))}
            placeholder="ABCD"
            maxLength={4}
            autoCapitalize="characters"
            autoComplete="off"
          />
        </label>
        <button className="btn btn-primary" disabled={busy} onClick={handleJoin}>
          Join room
        </button>
      </div>

      <div className="card">
        <h2>Start a new game</h2>
        <button className="btn" disabled={busy} onClick={handleCreate}>
          Create room
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
