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

// Whether *this server* has voice capture available (models loaded — see
// server/index.js), and which ASR languages it actually loaded, sent once
// right on connection. Server-wide, not per-room, so these live at module
// scope like everything else on this page rather than inside GameState
// (which is one room's state).
let voiceAvailable = false;
let voiceLanguages: string[] = [];
let voiceHttpsPort: number | null = null;
const voiceListeners = new Set<(v: boolean) => void>();
const voiceLanguageListeners = new Set<(langs: string[]) => void>();
socket.on(
  'server-info',
  (info: { voiceAvailable?: boolean; voiceLanguages?: string[]; voiceHttpsPort?: number | null }) => {
    voiceAvailable = !!info.voiceAvailable;
    voiceLanguages = info.voiceLanguages ?? [];
    voiceHttpsPort = info.voiceHttpsPort ?? null;
    voiceListeners.forEach((fn) => fn(voiceAvailable));
    voiceLanguageListeners.forEach((fn) => fn(voiceLanguages));
  },
);

/**
 * The https URL to reach this same server on, or null if there's no point
 * offering one (no https listener, or we're already on a secure origin).
 *
 * Browsers don't expose `navigator.mediaDevices` *at all* on a plain-http
 * origin, so on the LAN URL the mic simply cannot work — and hiding the
 * toggle with no explanation reads as "the feature is broken" rather than
 * "you're on the wrong URL".
 */
export function voiceHttpsUrl(): string | null {
  if (typeof window === 'undefined' || voiceHttpsPort == null) return null;
  if (window.isSecureContext) return null; // already somewhere the mic can work
  return `https://${window.location.hostname}:${voiceHttpsPort}${window.location.pathname}`;
}

/** Fires immediately with the current value, then again on every change
 *  (e.g. a reconnect to a different process). Returns an unsubscribe fn. */
export function onVoiceAvailable(fn: (available: boolean) => void): () => void {
  fn(voiceAvailable);
  voiceListeners.add(fn);
  return () => voiceListeners.delete(fn);
}

/** Which voice languages this server actually has models loaded for — e.g.
 *  `['en']` on a box that only fetched the English model. Same fire-now,
 *  fire-on-change shape as onVoiceAvailable. */
export function onVoiceLanguages(fn: (languages: string[]) => void): () => void {
  fn(voiceLanguages);
  voiceLanguageListeners.add(fn);
  return () => voiceLanguageListeners.delete(fn);
}

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
