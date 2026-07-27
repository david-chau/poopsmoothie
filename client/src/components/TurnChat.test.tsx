import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeState } from '../test-fixtures';
import type { ChatMessage } from '../types';

const { mockUseGame, mockEmitAck, mockOnVoiceAvailable, mockUseOpenMic } = vi.hoisted(() => ({
  mockUseGame: vi.fn(),
  mockEmitAck: vi.fn(),
  // default: no voice on this server — every existing test in this file is
  // exercising the Phase 1 text-only shape, so the mic button must stay gone
  // unless a test opts in below
  mockOnVoiceAvailable: vi.fn((fn: (v: boolean) => void) => {
    fn(false);
    return () => {};
  }),
  mockUseOpenMic: vi.fn(() => ({ on: false, level: 0, error: null, start: vi.fn(), stop: vi.fn() })),
}));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({ emitAck: mockEmitAck, onVoiceAvailable: mockOnVoiceAvailable }));
vi.mock('../useOpenMic', () => ({ useOpenMic: mockUseOpenMic }));

import TurnChat from './TurnChat';

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    playerId: 'p1',
    name: 'Alice',
    team: 'A',
    wasDrawer: false,
    via: 'text',
    text: 'hello',
    at: Date.now(),
    ...over,
  };
}

function setup(chat: ChatMessage[], identityPlayerId = 'p1') {
  mockUseGame.mockReturnValue({
    state: makeState({ phase: 'ROUND1', round: { ...makeState().round, chat } }),
    identity: { playerId: identityPlayerId },
    isDrawer: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmitAck.mockResolvedValue({ ok: true });
  localStorage.clear();
  // jsdom has no mediaDevices at all by default; stubbing it present (but not
  // exercised — useOpenMic itself is mocked above) lets the "voice available"
  // tests below actually find the toggle, same as a real mic-capable browser
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true });
});

test('renders each message with a team-colored name', () => {
  setup([msg({ id: 'a', name: 'Alice', team: 'A', text: 'over here' })]);
  render(<TurnChat />);
  expect(screen.getByText('over here')).toBeInTheDocument();
  expect(screen.getByText('Alice')).toHaveClass('team-blue');
});

test('each message shows the clock time it was said — the point of an audit trail', () => {
  const at = new Date(2026, 0, 2, 14, 5, 9).getTime();
  setup([msg({ id: 'a', text: 'before the buzzer', at })]);
  render(<TurnChat />);
  // matched loosely: the exact separator/12-vs-24h formatting is the runtime
  // locale's business, but hour/minute/second must all be there
  const expected = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  expect(screen.getByText(expected)).toBeInTheDocument();
  expect(expected).toMatch(/\d{1,2}\D\d{2}\D\d{2}/);
});

test('badges a message sent while that player was drawing', () => {
  setup([
    msg({ id: 'a', name: 'Alice', wasDrawer: true, text: 'guess it' }),
    msg({ id: 'b', name: 'Bob', team: 'B', wasDrawer: false, text: 'no idea' }),
  ]);
  render(<TurnChat />);
  // exactly one drawer badge, and it belongs to Alice's row, not Bob's
  expect(screen.getAllByText('drawer')).toHaveLength(1);
  const aliceRow = screen.getByText('guess it').closest('li');
  const bobRow = screen.getByText('no idea').closest('li');
  expect(aliceRow).toContainElement(screen.getByText('drawer'));
  expect(bobRow).not.toContainElement(screen.queryByText('drawer'));
});

test('marks voice-derived messages distinctly from typed ones', () => {
  setup([msg({ id: 'a', via: 'voice', text: 'said aloud' })]);
  render(<TurnChat />);
  expect(screen.getByTitle('Captured from voice')).toBeInTheDocument();
});

test('shows an empty state before anyone has said anything', () => {
  setup([]);
  render(<TurnChat />);
  expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
});

test('filters: All / My team / Drawer narrow what is shown', async () => {
  const user = userEvent.setup();
  setup(
    [
      msg({ id: 'a', name: 'Alice', team: 'A', wasDrawer: true, text: 'drawer team A' }),
      msg({ id: 'b', name: 'Carol', team: 'A', wasDrawer: false, text: 'teammate A' }),
      msg({ id: 'c', name: 'Bob', team: 'B', wasDrawer: false, text: 'other team B' }),
    ],
    'p3', // "my" identity is on team A (Carol), per makeState's default roster
  );
  render(<TurnChat />);

  // all three visible by default
  expect(screen.getByText('drawer team A')).toBeInTheDocument();
  expect(screen.getByText('teammate A')).toBeInTheDocument();
  expect(screen.getByText('other team B')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'My team' }));
  expect(screen.getByText('drawer team A')).toBeInTheDocument();
  expect(screen.getByText('teammate A')).toBeInTheDocument();
  expect(screen.queryByText('other team B')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Drawer' }));
  expect(screen.getByText('drawer team A')).toBeInTheDocument();
  expect(screen.queryByText('teammate A')).not.toBeInTheDocument();
  expect(screen.queryByText('other team B')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'All' }));
  expect(screen.getByText('other team B')).toBeInTheDocument();
});

test('the chosen filter survives a remount, via localStorage', async () => {
  const user = userEvent.setup();
  setup([]);
  const { unmount } = render(<TurnChat />);
  await user.click(screen.getByRole('button', { name: 'Drawer' }));
  unmount();

  render(<TurnChat />);
  expect(screen.getByRole('button', { name: 'Drawer' })).toHaveAttribute('aria-pressed', 'true');
});

test('sending trims, clears the draft, and hits chat-send', async () => {
  const user = userEvent.setup();
  setup([]);
  render(<TurnChat />);

  const input = screen.getByPlaceholderText('Say something…');
  await user.type(input, '  hello table  ');
  await user.click(screen.getByRole('button', { name: 'Send' }));

  expect(mockEmitAck).toHaveBeenCalledWith('chat-send', { text: 'hello table' });
});

test('the send button is disabled for an empty or whitespace-only draft', async () => {
  const user = userEvent.setup();
  setup([]);
  render(<TurnChat />);
  const button = screen.getByRole('button', { name: 'Send' });
  expect(button).toBeDisabled();

  await user.type(screen.getByPlaceholderText('Say something…'), '   ');
  expect(button).toBeDisabled();
});

test('a failed send surfaces the server error instead of clearing the draft', async () => {
  mockEmitAck.mockResolvedValue({ ok: false, error: 'slow down — try again in a moment' });
  const user = userEvent.setup();
  setup([]);
  render(<TurnChat />);

  await user.type(screen.getByPlaceholderText('Say something…'), 'too fast');
  await user.click(screen.getByRole('button', { name: 'Send' }));

  expect(await screen.findByText('slow down — try again in a moment')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Say something…')).toHaveValue('too fast'); // not cleared
});

test('the drawer sees a gentle reminder not to give the word away', () => {
  mockUseGame.mockReturnValue({
    state: makeState({ phase: 'ROUND1', round: { ...makeState().round, chat: [] } }),
    identity: { playerId: 'p1' },
    isDrawer: true,
  });
  render(<TurnChat />);
  expect(screen.getByPlaceholderText(/careful, no giving it away/)).toBeInTheDocument();
});

test('the mic toggle is hidden when this server has no voice capture', () => {
  setup([]); // default mockOnVoiceAvailable reports false
  render(<TurnChat />);
  expect(screen.queryByTitle(/table hear you/)).not.toBeInTheDocument();
});

test('the mic toggle appears once the server reports voice is available, and starts capture on click', async () => {
  const user = userEvent.setup();
  const start = vi.fn();
  mockOnVoiceAvailable.mockImplementation((fn: (v: boolean) => void) => {
    fn(true);
    return () => {};
  });
  mockUseOpenMic.mockReturnValue({ on: false, level: 0, error: null, start, stop: vi.fn() });
  setup([]);
  render(<TurnChat />);

  const toggle = screen.getByTitle(/table hear you/);
  await user.click(toggle);
  expect(start).toHaveBeenCalled();
});

test('a listening mic renders as on and can be stopped from the same toggle', async () => {
  const user = userEvent.setup();
  const stop = vi.fn();
  mockOnVoiceAvailable.mockImplementation((fn: (v: boolean) => void) => {
    fn(true);
    return () => {};
  });
  mockUseOpenMic.mockReturnValue({ on: true, level: 0.5, error: null, start: vi.fn(), stop });
  setup([]);
  render(<TurnChat />);

  const toggle = screen.getByTitle(/tap to stop/i);
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await user.click(toggle);
  expect(stop).toHaveBeenCalled();
});

test('a mic error is surfaced distinctly from a chat-send error', () => {
  mockOnVoiceAvailable.mockImplementation((fn: (v: boolean) => void) => {
    fn(true);
    return () => {};
  });
  mockUseOpenMic.mockReturnValue({ on: false, level: 0, error: 'could not access the microphone', start: vi.fn(), stop: vi.fn() });
  setup([]);
  render(<TurnChat />);
  expect(screen.getByText('Mic: could not access the microphone')).toBeInTheDocument();
});
