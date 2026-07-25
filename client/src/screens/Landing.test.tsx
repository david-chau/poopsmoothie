import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockUseGame, mockEmitAck, mockSocket } = vi.hoisted(() => ({
  mockUseGame: vi.fn(),
  mockEmitAck: vi.fn(),
  mockSocket: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({ socket: mockSocket, emitAck: mockEmitAck }));

/** push a lobbies list through the subscription the screen registered */
function pushLobbies(lobbies: unknown[]) {
  const handler = mockSocket.on.mock.calls.find(([event]) => event === 'lobbies')?.[1];
  act(() => handler(lobbies));
}

import Landing from './Landing';

beforeEach(() => {
  vi.clearAllMocks();
  mockEmitAck.mockResolvedValue({ ok: true, lobbies: [] });
  mockUseGame.mockReturnValue({
    createRoom: vi.fn().mockResolvedValue({ ok: true }),
    joinRoom: vi.fn().mockResolvedValue({ ok: true }),
  });
  window.history.pushState({}, '', '/');
  localStorage.clear();
});

test('prefills the room code from a /join/<code> deep link', () => {
  window.history.pushState({}, '', '/join/wxyz');
  render(<Landing />);
  expect(screen.getByPlaceholderText('ABCD')).toHaveValue('WXYZ'); // uppercased
});

test('cleans the URL back to / after reading the deep link', () => {
  window.history.pushState({}, '', '/join/WXYZ');
  render(<Landing />);
  expect(window.location.pathname).toBe('/');
});

test('no prefill for a normal visit', () => {
  render(<Landing />);
  expect(screen.getByPlaceholderText('ABCD')).toHaveValue('');
});

/** name filled in, so the button is gated only by the room code */
async function named() {
  const user = userEvent.setup();
  render(<Landing />);
  await user.type(screen.getByPlaceholderText('Please enter your name'), 'Alice');
  return { user, code: screen.getByPlaceholderText('ABCD') };
}

test('blank code creates a new room', async () => {
  const createRoom = vi.fn().mockResolvedValue({ ok: true });
  mockUseGame.mockReturnValue({ createRoom, joinRoom: vi.fn() });
  const { user } = await named();

  const btn = screen.getByRole('button', { name: /Start a new game/ });
  expect(btn).toBeEnabled();
  await user.click(btn);
  expect(createRoom).toHaveBeenCalledWith('Alice');
});

test('a full 4-char code joins that room via the secondary path', async () => {
  const joinRoom = vi.fn().mockResolvedValue({ ok: true });
  mockUseGame.mockReturnValue({ createRoom: vi.fn(), joinRoom });
  const { user, code } = await named();

  await user.type(code, 'wxyz');
  await user.click(screen.getByRole('button', { name: 'Join' }));
  expect(joinRoom).toHaveBeenCalledWith('WXYZ', 'Alice');
});

test('a half-typed code leaves the code Join button disabled', async () => {
  const { user, code } = await named();
  await user.type(code, 'AB');
  expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
});

test('the button stays disabled until a name is entered', () => {
  render(<Landing />);
  expect(screen.getByRole('button', { name: /Start a new game/ })).toBeDisabled();
});

test('shows the empty state until rooms exist', () => {
  render(<Landing />);
  expect(screen.getByText(/No rooms yet/)).toBeInTheDocument();
  expect(screen.getByText('0 open')).toBeInTheDocument();
});

test('lists open rooms pushed from the server and joins one on tap', async () => {
  const joinRoom = vi.fn().mockResolvedValue({ ok: true });
  mockUseGame.mockReturnValue({ createRoom: vi.fn(), joinRoom });
  const user = userEvent.setup();
  render(<Landing />);
  await user.type(screen.getByPlaceholderText('Please enter your name'), 'Alice');

  pushLobbies([{ code: 'WXYZ', playerCount: 2, hostName: 'Bob', phase: 'LOBBY' }]);

  expect(screen.getByText('1 open')).toBeInTheDocument();
  expect(screen.getByText(/Bob's room · In lobby · 2 players/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /WXYZ/ }));
  expect(joinRoom).toHaveBeenCalledWith('WXYZ', 'Alice');
});

test('room rows are not tappable before a name is entered', () => {
  render(<Landing />);
  pushLobbies([{ code: 'WXYZ', playerCount: 1, hostName: null, phase: 'LOBBY' }]);
  expect(screen.getByRole('button', { name: /WXYZ/ })).toBeDisabled();
});

test('a game already in progress is listed as live and joinable', () => {
  render(<Landing />);
  pushLobbies([{ code: 'WXYZ', playerCount: 5, hostName: 'Bob', phase: 'ROUND2' }]);
  expect(screen.getByText('live', { selector: '.lobby-live' })).toBeInTheDocument();
  expect(screen.getByText(/Round 2 · Charades · 5 players/)).toBeInTheDocument();
});

test('explains why things are disabled while the name is empty', async () => {
  const user = userEvent.setup();
  render(<Landing />);
  pushLobbies([{ code: 'WXYZ', playerCount: 1, hostName: null, phase: 'LOBBY' }]);

  // the tooltip lives on the <li>, since a disabled button never shows one
  const row = screen.getByRole('button', { name: /WXYZ/ }).closest('li');
  expect(row).toHaveAttribute('title', 'Please enter your name');

  await user.type(screen.getByPlaceholderText('Please enter your name'), 'Alice');
  expect(row).not.toHaveAttribute('title'); // no longer blocked, so no nag
});

test('a late list-lobbies reply does not clobber a push that beat it', async () => {
  let resolveList: (v: unknown) => void = () => {};
  mockEmitAck.mockReturnValueOnce(new Promise((r) => (resolveList = r)));
  render(<Landing />);

  pushLobbies([{ code: 'WXYZ', playerCount: 2, hostName: 'Bob', phase: 'LOBBY' }]);
  expect(screen.getByText('1 open')).toBeInTheDocument();

  // the initial snapshot finally arrives, from before that room existed
  await act(async () => {
    resolveList({ ok: true, lobbies: [] });
  });

  expect(screen.getByText('1 open')).toBeInTheDocument(); // push still wins
});
