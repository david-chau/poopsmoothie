import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { socket, loadIdentity, saveIdentity, clearIdentity, wireAutoRejoin, emitAck, type Identity } from './socket';
import type { GameState, Slip } from './types';

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
  createRoom: (name: string) => Promise<{ ok: boolean; error?: string }>;
  joinRoom: (roomCode: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  leaveToLanding: () => void;
}

const GameContext = createContext<GameContextValue | null>(null);

export function GameProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GameState | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(loadIdentity());
  const [mySlip, setMySlip] = useState<DrawnSlip | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
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
    function onRejoinFailed() {
      identityRef.current = null;
      setIdentity(null);
      setState(null);
    }

    socket.on('state', onState);
    socket.on('slip-revealed', onSlipRevealed);
    wireAutoRejoin(onRejoinFailed);

    return () => {
      socket.off('state', onState);
      socket.off('slip-revealed', onSlipRevealed);
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

  async function joinRoom(roomCode: string, name: string) {
    const res = await emitAck<{ ok: boolean; error?: string; roomCode: string; playerId: string; secret: string }>(
      'join-room',
      { roomCode, name },
    );
    if (res.ok) {
      const id = { roomCode: res.roomCode, playerId: res.playerId, secret: res.secret };
      saveIdentity(id);
      setIdentity(id);
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
