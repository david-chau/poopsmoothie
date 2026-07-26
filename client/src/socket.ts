import { io, type Socket } from 'socket.io-client';

export interface Identity {
  roomCode: string;
  playerId: string;
  secret: string;
}

const STORAGE_KEY = 'poopsmoothie-identity';

export function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Identity) : null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: Identity) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

export function clearIdentity() {
  localStorage.removeItem(STORAGE_KEY);
}

// gap #13: no args = same-origin — this server serves the static client too,
// so phones reach it over LAN by NAS IP with no CORS config needed.
export const socket: Socket = io();

// The server asks this when someone else tries to join under our name, to tell
// a live tab from a socket it hasn't noticed is dead yet. Answering keeps the
// name; staying silent hands it over — so this must be registered on the module,
// not inside a component that might not be mounted.
socket.on('are-you-there', (ack?: () => void) => ack?.());

/** gap #14: re-fires on every transport reconnect (new sid), not just first mount. */
export function wireAutoRejoin(onFailed: () => void) {
  socket.on('connect', () => {
    const identity = loadIdentity();
    if (!identity) return;
    socket.emit('rejoin', identity, (res: { ok: boolean }) => {
      if (!res.ok) {
        clearIdentity(); // gap #7: stale creds for a dead room -> back to landing
        onFailed();
      }
    });
  });
}

export function emitAck<T = { ok: boolean; error?: string }>(event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve) => {
    socket.emit(event, payload ?? {}, (res: T) => resolve(res));
  });
}
