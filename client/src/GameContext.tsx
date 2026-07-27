import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { socket, loadIdentity, saveIdentity, clearIdentity, wireAutoRejoin, emitAck, type Identity } from './socket';
import type { ChatMessage, GameState, Slip } from './types';

/** Mirrors the server's cap (server/events.js chat-send) so a very chatty
 *  round can never grow the array without bound between full state syncs. */
const CHAT_HISTORY_CAP = 200;

interface DrawnSlip {
  slip: Slip;
  turnId: string;
}

interface GameContextValue {
  state: GameState | null;
  identity: Identity | null;
  mySlip: Slip | null;
  clockOffsetMs: number;
  myPlayer: GameState['players'][number] | null;
  isHost: boolean;
  isDrawer: boolean;
  /** one-off message to surface as a toast (e.g. the host closed the room) */
  notice: string | null;
  dismissNotice: () => void;
  createRoom: (name: string) => Promise<{ ok: boolean; error?: string }>;
  joinRoom: (
    roomCode: string,
    name: string,
    opts?: { reclaim?: boolean },
  ) => Promise<{ ok: boolean; error?: string; nameTaken?: boolean; canReclaim?: boolean; name?: string }>;
  leaveToLanding: () => void;
}

const GameContext = createContext<GameContextValue | null>(null);

export function GameProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GameState | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(loadIdentity());
  const [mySlip, setMySlip] = useState<DrawnSlip | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // kept in a ref so the 'connect'/'state' listeners (registered once) always see the latest identity
  const identityRef = useRef(identity);
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);

  useEffect(() => {
    function onState(payload: GameState) {
      setState(payload);
      setClockOffsetMs(payload.serverNow - Date.now()); // gap #N: correct for phone clock skew
      // clear any local slip once I'm no longer the drawer, or the turn has moved on
      setMySlip((prev) => {
        if (!prev) return null;
        if (payload.round.drawerId !== identityRef.current?.playerId) return null;
        if (payload.round.turnId !== prev.turnId) return null;
        return prev;
      });
    }
    function onSlipRevealed(payload: DrawnSlip) {
      setMySlip(payload);
    }
    // Chat is deliberately NOT part of the full 'state' broadcast cadence (see
    // server/events.js chat-send) — a full state+lobbies rebroadcast per line of
    // text is too heavy. So new messages arrive on their own event and are
    // appended locally; the next real 'state' event still replaces round.chat
    // wholesale with the server's authoritative array (e.g. the empty array a
    // new round starts with), so nothing here can outlive a round boundary.
    function onChatMessage(msg: ChatMessage) {
      setState((prev) => {
        if (!prev) return prev;
        const next = [...prev.round.chat, msg].slice(-CHAT_HISTORY_CAP);
        return { ...prev, round: { ...prev.round, chat: next } };
      });
    }
    function onRejoinFailed() {
      identityRef.current = null;
      setIdentity(null);
      setState(null);
    }
    // host hit "End room for everyone" — the room is already gone server-side,
    // so drop our stored identity too or auto-rejoin would retry a dead code.
    function onRoomClosed(payload?: { reason?: string }) {
      clearIdentity();
      identityRef.current = null;
      setIdentity(null);
      setState(null);
      setMySlip(null);
      setNotice(payload?.reason ?? 'The room was closed.');
    }

    socket.on('state', onState);
    socket.on('slip-revealed', onSlipRevealed);
    socket.on('chat-message', onChatMessage);
    socket.on('room-closed', onRoomClosed);
    wireAutoRejoin(onRejoinFailed);

    return () => {
      socket.off('state', onState);
      socket.off('slip-revealed', onSlipRevealed);
      socket.off('chat-message', onChatMessage);
      socket.off('room-closed', onRoomClosed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createRoom(name: string) {
    const res = await emitAck<{ ok: boolean; error?: string; roomCode: string; playerId: string; secret: string }>(
      'create-room',
      { name },
    );
    if (res.ok) {
      const id = { roomCode: res.roomCode, playerId: res.playerId, secret: res.secret };
      saveIdentity(id);
      setIdentity(id);
    }
    return res;
  }

  async function joinRoom(roomCode: string, name: string, opts: { reclaim?: boolean } = {}) {
    const res = await emitAck<{
      ok: boolean;
      error?: string;
      roomCode: string;
      playerId: string;
      secret: string;
      reclaimed?: boolean;
      /** the name is in use by someone still connected */
      nameTaken?: boolean;
      /** the name exists but is offline — ask before assuming their identity */
      canReclaim?: boolean;
      name?: string;
    }>('join-room', { roomCode, name, reclaim: opts.reclaim });
    if (res.ok) {
      const id = { roomCode: res.roomCode, playerId: res.playerId, secret: res.secret };
      saveIdentity(id);
      setIdentity(id);
      // say so, or picking up someone else's team and score looks like a bug
      if (res.reclaimed) setNotice('Welcome back — you picked up where you left off.');
    }
    return res;
  }

  function leaveToLanding() {
    emitAck('leave-room');
    clearIdentity();
    setIdentity(null);
    setState(null);
    setMySlip(null);
  }

  const myPlayer = state?.players.find((p) => p.id === identity?.playerId) ?? null;
  const isHost = !!identity && state?.hostId === identity.playerId;
  const isDrawer = !!identity && state?.round.drawerId === identity.playerId;

  return (
    <GameContext.Provider
      value={{
        state,
        identity,
        mySlip: mySlip?.slip ?? null,
        clockOffsetMs,
        myPlayer,
        isHost,
        isDrawer,
        notice,
        dismissNotice: () => setNotice(null),
        createRoom,
        joinRoom,
        leaveToLanding,
      }}
    >
      {children}
    </GameContext.Provider>
  );
}

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used within GameProvider');
  return ctx;
}
