import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeState } from '../test-fixtures';
import type { ChatMessage } from '../types';

const { mockUseGame, mockEmitAck, mockOnVoiceAvailable, mockUseOpenMic, mockVoiceHttpsUrl, mockUseVoiceEnroll, mockEnrollRecord, MIC_EXTRA } =
  vi.hoisted(() => ({
    mockUseGame: vi.fn(),
    mockEmitAck: vi.fn(),
    // default: no voice on this server — every existing test in this file is
    // exercising the Phase 1 text-only shape, so the mic button must stay gone
    // unless a test opts in below
    mockOnVoiceAvailable: vi.fn((fn: (v: boolean) => void) => {
      fn(false);
      return () => {};
    }),
    // the sensitivity pair the live meter reads; spread into every stubbed
    // useOpenMic return so a test only has to state what it actually cares about
    MIC_EXTRA: { sensitivity: 0.012, setSensitivity: vi.fn() },
    mockUseOpenMic: vi.fn(() => ({
      on: false,
      level: 0,
      error: null,
      start: vi.fn(),
      stop: vi.fn(),
      sensitivity: 0.012,
      setSensitivity: vi.fn(),
    })),
    // default: nothing to suggest (already secure, or no https listener)
    mockVoiceHttpsUrl: vi.fn(() => null),
    mockEnrollRecord: vi.fn(),
    mockUseVoiceEnroll: vi.fn(() => ({ recording: false, secondsLeft: 5, error: null, justEnrolled: false, record: mockEnrollRecord })),
  }));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({
  emitAck: mockEmitAck,
  onVoiceAvailable: mockOnVoiceAvailable,
  voiceHttpsUrl: mockVoiceHttpsUrl,
}));
vi.mock('../useOpenMic', () => ({
  useOpenMic: mockUseOpenMic,
  MIN_ENERGY_RANGE: { min: 0, max: 0.06, default: 0.012 },
}));
vi.mock('../useVoiceEnroll', () => ({ useVoiceEnroll: mockUseVoiceEnroll, DEFAULT_RECORD_SECONDS: 5 }));

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
  // reset explicitly rather than leaning on the hoisted defaults surviving
  // clearAllMocks — it only clears call history, not a mockResolvedValue/
  // mockReturnValue set by an earlier test (bit this file before, see the
  // https-hint tests below)
  mockEnrollRecord.mockResolvedValue(true);
  mockUseVoiceEnroll.mockReturnValue({ recording: false, secondsLeft: 5, error: null, justEnrolled: false, record: mockEnrollRecord });
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

test('already enrolled: clicking the mic toggle starts capture directly, without recording again', async () => {
  const user = userEvent.setup();
  const start = vi.fn();
  mockOnVoiceAvailable.mockImplementation((fn: (v: boolean) => void) => {
    fn(true);
    return () => {};
  });
  mockUseOpenMic.mockReturnValue({ on: false, level: 0, error: null, start, stop: vi.fn(), ...MIC_EXTRA });
  mockUseGame.mockReturnValue({
    state: makeState({
      phase: 'ROUND1',
      round: { ...makeState().round, chat: [] },
      players: makeState().players.map((p) => (p.id === 'p1' ? { ...p, voiceEnrolled: true } : p)),
    }),
    identity: { playerId: 'p1' },
    isDrawer: false,
  });
  render(<TurnChat />);

  const toggle = screen.getByTitle(/table hear you/);
  await user.click(toggle);
  expect(mockEnrollRecord).not.toHaveBeenCalled();
  expect(start).toHaveBeenCalled();
});

test('not yet enrolled: clicking the mic toggle records a sample first, then starts capture', async () => {
  const user = userEvent.setup();
  const start = vi.fn();
  mockOnVoiceAvailable.mockImplementation((fn: (v: boolean) => void) => {
    fn(true);
    return () => {};
  });
  mockUseOpenMic.mockReturnValue({ on: false, level: 0, error: null, start, stop: vi.fn(), ...MIC_EXTRA });
  setup([]); // p1 has no voiceEnrolled flag -> not enrolled

  render(<TurnChat />);
  const toggle = screen.getByRole('button', { name: /Record 5s sample/ });
  await user.click(toggle);

  expect(mockEnrollRecord).toHaveBeenCalled();
  expect(start).toHaveBeenCalled();
});

test('a failed enrollment recording does not start the mic', async () => {
  const user = userEvent.setup();
  const start = vi.fn();
  mockEnrollRecord.mockResolvedValue(false);
  mockOnVoiceAvailable.mockImplementation((fn: (v: boolean) => void) => {
    fn(true);
    return () => {};
  });
  mockUseOpenMic.mockReturnValue({ on: false, level: 0, error: null, start, stop: vi.fn(), ...MIC_EXTRA });
  setup([]);

  render(<TurnChat />);
  await user.click(screen.getByRole('button', { name: /Record 5s sample/ }));

  expect(mockEnrollRecord).toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

test('a listening mic renders as on and can be stopped from the same toggle', async () => {
  const user = userEvent.setup();
  const stop = vi.fn();
  mockOnVoiceAvailable.mockImplementation((fn: (v: boolean) => void) => {
    fn(true);
    return () => {};
  });
  mockUseOpenMic.mockReturnValue({ on: true, level: 0.5, error: null, start: vi.fn(), stop, ...MIC_EXTRA });
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
  mockUseOpenMic.mockReturnValue({ on: false, level: 0, error: 'could not access the microphone', start: vi.fn(), stop: vi.fn(), ...MIC_EXTRA });
  setup([]);
  render(<TurnChat />);
  expect(screen.getByText('Mic: could not access the microphone')).toBeInTheDocument();
});

test('on a plain-http origin, voice explains itself and links to the https URL', () => {
  // jsdom has no navigator.mediaDevices by default — exactly what a browser
  // does on an insecure origin, which is the case being covered here
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  mockOnVoiceAvailable.mockImplementation((fn: (v: boolean) => void) => {
    fn(true); // server HAS voice — it's this origin that can't use it
    return () => {};
  });
  mockVoiceHttpsUrl.mockReturnValue('https://smoothie.dmjnas:4322/');
  setup([]);
  render(<TurnChat />);

  const link = screen.getByRole('link', { name: /open this room over https/i });
  expect(link).toHaveAttribute('href', 'https://smoothie.dmjnas:4322/');
  expect(screen.getByText(/needs a secure connection/i)).toBeInTheDocument();
});

test('no https nag once the mic actually works — that would just be noise', () => {
  mockOnVoiceAvailable.mockImplementation((fn: (v: boolean) => void) => {
    fn(true);
    return () => {};
  });
  mockVoiceHttpsUrl.mockReturnValue('https://smoothie.dmjnas:4322/');
  setup([]);
  render(<TurnChat />); // beforeEach leaves mediaDevices present -> mic is usable
  expect(screen.queryByText(/needs a secure connection/i)).not.toBeInTheDocument();
});

test('no https nag when the server has no voice at all — https would not help', () => {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  // set explicitly rather than leaning on the hoisted default: clearAllMocks
  // resets calls but not implementations, so an earlier test's mockImplementation
  // would otherwise still be in force here
  mockOnVoiceAvailable.mockImplementation((fn: (v: boolean) => void) => {
    fn(false);
    return () => {};
  });
  mockVoiceHttpsUrl.mockReturnValue('https://smoothie.dmjnas:4322/');
  setup([]);
  render(<TurnChat />);
  expect(screen.queryByText(/needs a secure connection/i)).not.toBeInTheDocument();
});

// --- the live meter: the point is seeing whether your voice clears the line -

const micOn = (over: Record<string, unknown> = {}) => {
  mockOnVoiceAvailable.mockImplementation((fn: (v: boolean) => void) => {
    fn(true);
    return () => {};
  });
  mockUseOpenMic.mockReturnValue({
    on: true,
    level: 0,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    sensitivity: 0.012,
    setSensitivity: vi.fn(),
    ...over,
  });
};

test('the meter only appears while the mic is actually listening', () => {
  micOn({ on: false });
  setup([]);
  render(<TurnChat />);
  expect(screen.queryByLabelText('Mic sensitivity')).not.toBeInTheDocument();
});

test('a level above the threshold reads as passing, below as not', () => {
  micOn({ level: 0.05, sensitivity: 0.012 });
  setup([]);
  const { container, unmount } = render(<TurnChat />);
  expect(container.querySelector('.mic-meter-fill-passing')).toBeTruthy();
  unmount();

  micOn({ level: 0.002, sensitivity: 0.012 });
  setup([]);
  const { container: quiet } = render(<TurnChat />);
  expect(quiet.querySelector('.mic-meter-fill-passing')).toBeNull();
});

test('dragging the slider reports the new floor', () => {
  const setSensitivity = vi.fn();
  micOn({ setSensitivity });
  setup([]);
  render(<TurnChat />);

  // fireEvent rather than userEvent: a range input is dragged, not typed into,
  // and userEvent has no drag-to-value gesture for it
  fireEvent.change(screen.getByLabelText('Mic sensitivity'), { target: { value: '0.03' } });
  expect(setSensitivity).toHaveBeenCalledWith(0.03);
});

test('the meter never overflows its bar, however loud the input', () => {
  micOn({ level: 5 }); // far past full scale
  setup([]);
  const { container } = render(<TurnChat />);
  const fill = container.querySelector('.mic-meter-fill') as HTMLElement;
  expect(fill.style.width).toBe('100%');
});

// --- editing/deleting your own line (mainly: fixing a voice mishear) -------

test('only your own messages offer edit and delete', () => {
  setup([msg({ id: 'mine', playerId: 'p1', text: 'mine' }), msg({ id: 'theirs', playerId: 'p2', text: 'theirs' })], 'p1');
  render(<TurnChat />);

  expect(screen.getAllByLabelText('Edit your message')).toHaveLength(1);
  expect(screen.getAllByLabelText('Delete your message')).toHaveLength(1);
  // and it's attached to the row that is actually mine
  expect(screen.getByText('mine').closest('li')).toContainElement(screen.getByLabelText('Edit your message'));
});

test('editing sends the correction and leaves edit mode', async () => {
  const user = userEvent.setup();
  setup([msg({ id: 'm', playerId: 'p1', via: 'voice', text: 'True.' })], 'p1');
  render(<TurnChat />);

  await user.click(screen.getByLabelText('Edit your message'));
  const input = screen.getByDisplayValue('True.');
  await user.clear(input);
  await user.type(input, 'Too');
  await user.click(screen.getByLabelText('Save correction'));

  expect(mockEmitAck).toHaveBeenCalledWith('chat-edit', { id: 'm', text: 'Too' });
});

test('cancelling an edit sends nothing and restores the row', async () => {
  const user = userEvent.setup();
  setup([msg({ id: 'm', playerId: 'p1', text: 'original' })], 'p1');
  render(<TurnChat />);

  await user.click(screen.getByLabelText('Edit your message'));
  await user.click(screen.getByLabelText('Cancel edit'));

  expect(mockEmitAck).not.toHaveBeenCalledWith('chat-edit', expect.anything());
  expect(screen.getByText('original')).toBeInTheDocument();
});

test('an empty correction is refused locally rather than sent', async () => {
  const user = userEvent.setup();
  setup([msg({ id: 'm', playerId: 'p1', text: 'original' })], 'p1');
  render(<TurnChat />);

  await user.click(screen.getByLabelText('Edit your message'));
  await user.clear(screen.getByDisplayValue('original'));
  await user.click(screen.getByLabelText('Save correction'));

  expect(mockEmitAck).not.toHaveBeenCalledWith('chat-edit', expect.anything());
  expect(screen.getByText(/can't be empty/i)).toBeInTheDocument();
});

test('deleting hits chat-delete for that message', async () => {
  const user = userEvent.setup();
  setup([msg({ id: 'gone', playerId: 'p1', text: 'oops' })], 'p1');
  render(<TurnChat />);

  await user.click(screen.getByLabelText('Delete your message'));
  expect(mockEmitAck).toHaveBeenCalledWith('chat-delete', { id: 'gone' });
});

test('an edited message says so — a correction must not read as what was said live', () => {
  setup([msg({ id: 'm', playerId: 'p2', text: 'Too', edited: true })], 'p1');
  render(<TurnChat />);
  expect(screen.getByText('(edited)')).toBeInTheDocument();
});
