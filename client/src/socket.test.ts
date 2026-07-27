import { test, expect, vi, beforeEach } from 'vitest';

// socket.ts opens a real connection at import time; the transport itself isn't
// what's under test here, only the server-info bookkeeping around it.
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => void>() }));
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: (event: string, fn: (...args: unknown[]) => void) => handlers.set(event, fn),
    emit: vi.fn(),
    volatile: { emit: vi.fn() },
  }),
}));

const { voiceHttpsUrl } = await import('./socket');

/** Pretend the server just told us what it supports. */
const sendServerInfo = (info: unknown) => handlers.get('server-info')?.(info);

function setOrigin({ secure, hostname = 'smoothie.dmjnas', pathname = '/' }: { secure: boolean; hostname?: string; pathname?: string }) {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
  Object.defineProperty(window, 'location', { value: { hostname, pathname }, configurable: true });
}

beforeEach(() => {
  sendServerInfo({ voiceAvailable: false, voiceLanguages: [], voiceHttpsPort: null });
});

test('offers the https URL on an insecure origin, keeping host and path', () => {
  setOrigin({ secure: false, pathname: '/join/ABCD' });
  sendServerInfo({ voiceAvailable: true, voiceLanguages: ['en'], voiceHttpsPort: 4322 });
  expect(voiceHttpsUrl()).toBe('https://smoothie.dmjnas:4322/join/ABCD');
});

test('offers nothing when already on a secure origin — the mic works here', () => {
  setOrigin({ secure: true });
  sendServerInfo({ voiceAvailable: true, voiceLanguages: ['en'], voiceHttpsPort: 4322 });
  expect(voiceHttpsUrl()).toBeNull();
});

test('offers nothing when the server has no https listener to point at', () => {
  setOrigin({ secure: false });
  sendServerInfo({ voiceAvailable: true, voiceLanguages: ['en'], voiceHttpsPort: null });
  expect(voiceHttpsUrl()).toBeNull();
});

test('a server that never sends a port is treated as having none', () => {
  setOrigin({ secure: false });
  sendServerInfo({ voiceAvailable: true, voiceLanguages: ['en'] }); // older server
  expect(voiceHttpsUrl()).toBeNull();
});
