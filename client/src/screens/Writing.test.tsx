import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeState } from '../test-fixtures';

const { mockUseGame, mockEmitAck } = vi.hoisted(() => ({ mockUseGame: vi.fn(), mockEmitAck: vi.fn() }));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({ emitAck: mockEmitAck }));

import Writing from './Writing';

/** writing screen with `n` empty boxes */
function writingScreen(n: number) {
  const state = makeState({
    phase: 'WRITING',
    config: { wordsPerPlayer: n, turnSeconds: 60, hotJoin: true, allowSkip: { ROUND1: true, ROUND2: true, ROUND3: false } },
  });
  mockUseGame.mockReturnValue({ state, identity: { playerId: 'p1' }, isHost: false, leaveToLanding: vi.fn() });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmitAck.mockResolvedValue({ ok: true });
});

test('renders one input per configured word', () => {
  writingScreen(3);
  render(<Writing />);
  expect(screen.getByPlaceholderText('Word or phrase 1')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Word or phrase 3')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Word or phrase 4')).not.toBeInTheDocument();
});

test('the dice button fills only its own box', async () => {
  writingScreen(3);
  mockEmitAck.mockResolvedValue({ ok: true, words: ['Pineapple'] });
  render(<Writing />);

  await userEvent.click(screen.getByRole('button', { name: /Suggest a word or phrase for slot 2/ }));

  await waitFor(() => expect(screen.getByPlaceholderText('Word or phrase 2')).toHaveValue('Pineapple'));
  expect(screen.getByPlaceholderText('Word or phrase 1')).toHaveValue('');
  expect(screen.getByPlaceholderText('Word or phrase 3')).toHaveValue('');
});

test('fill-the-rest keeps what you typed and only asks for the empty slots', async () => {
  writingScreen(3);
  render(<Writing />);
  await userEvent.type(screen.getByPlaceholderText('Word or phrase 1'), 'Sushi');

  mockEmitAck.mockResolvedValue({ ok: true, words: ['Igloo', 'Kayak'] });
  await userEvent.click(screen.getByRole('button', { name: /Fill the empty ones/ }));

  await waitFor(() => expect(screen.getByPlaceholderText('Word or phrase 2')).toHaveValue('Igloo'));
  expect(screen.getByPlaceholderText('Word or phrase 1')).toHaveValue('Sushi'); // untouched
  expect(screen.getByPlaceholderText('Word or phrase 3')).toHaveValue('Kayak');
  // asked for 2, and told the server what's already in the boxes so it can't hand back a clash
  expect(mockEmitAck).toHaveBeenLastCalledWith('suggest-words', { count: 2, exclude: ['Sushi', '', ''] });
});

test('fill-the-rest is disabled once every box is filled', async () => {
  writingScreen(1);
  render(<Writing />);
  const fillAll = screen.getByRole('button', { name: /Fill the empty ones/ });
  expect(fillAll).toBeEnabled();
  await userEvent.type(screen.getByPlaceholderText('Word or phrase 1'), 'Sushi');
  expect(fillAll).toBeDisabled();
});

test('waiting ratio counts only connected players (submitted-then-disconnected does not inflate it)', () => {
  // p1 submitted; p4 submitted then disconnected. connected = p1,p2,p3 -> 1/3, not 2/4
  const state = makeState({
    phase: 'WRITING',
    submittedPlayerIds: ['p1', 'p4'],
    players: [
      { id: 'p1', name: 'Alice', team: 'A', connected: true },
      { id: 'p2', name: 'Bob', team: 'B', connected: true },
      { id: 'p3', name: 'Carol', team: 'A', connected: true },
      { id: 'p4', name: 'Dave', team: 'B', connected: false },
    ],
  });
  mockUseGame.mockReturnValue({ state, identity: { playerId: 'p1' }, isHost: false, leaveToLanding: vi.fn() });
  render(<Writing />);
  expect(screen.getByText(/1\/3/)).toBeInTheDocument();
});
