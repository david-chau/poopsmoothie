import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeState } from '../test-fixtures';
import type { Phase } from '../types';

const { mockUseGame } = vi.hoisted(() => ({ mockUseGame: vi.fn() }));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({
  emitAck: vi.fn().mockResolvedValue({ ok: true }),
  // this screen doesn't test voice — TurnChat's own tests cover the mic UI in
  // depth, so here it's just "no voice on this server", same as Phase 1
  onVoiceAvailable: (fn: (v: boolean) => void) => {
    fn(false);
    return () => {};
  },
}));

import Turn from './Turn';

/** drawer mid-turn, holding a slip, in the given round phase */
function drawerTurn(phase: Phase) {
  const state = makeState({
    phase,
    activeTeam: 'A',
    round: {
      number: 1,
      remainingCount: 3,
      guessedCount: 0,
      drawerId: 'p1',
      turnId: 't1',
      turnEndsAt: Date.now() + 60_000,
      paused: false,
      pauseReason: null,
      awaitingReady: false,
      readyPlayerIds: [],
      guessedThisRound: [],
      chat: [],
    },
  });
  mockUseGame.mockReturnValue({
    state,
    mySlip: { id: 's1', text: 'banana', authorId: 'p2' },
    isDrawer: true,
    isHost: false,
    clockOffsetMs: 0,
  });
}

beforeEach(() => vi.clearAllMocks());

test('shows the Pass button when skip is allowed for the round (Taboo)', () => {
  drawerTurn('ROUND1');
  render(<Turn />);
  expect(screen.getByRole('button', { name: 'Pass' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Correct!' })).toBeInTheDocument();
});

test('hides the Pass button when skip is disabled for the round (Password)', () => {
  drawerTurn('ROUND3');
  render(<Turn />);
  expect(screen.queryByRole('button', { name: 'Pass' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Correct!' })).toBeInTheDocument();
});

test('renders the round label with team-colored score line', () => {
  drawerTurn('ROUND1');
  render(<Turn />);
  expect(screen.getByText(/Round 1: Taboo/)).toBeInTheDocument();
  expect(screen.getByText(/Team Blue: 0/)).toBeInTheDocument();
  expect(screen.getByText(/Team Red: 0/)).toBeInTheDocument();
});

test('shows what has been guessed this round, newest first, with who got it', () => {
  const state = makeState({
    phase: 'ROUND1',
    round: {
      number: 1,
      remainingCount: 2,
      guessedCount: 2,
      drawerId: 'p2', // someone else is drawing, so we are a watcher
      turnId: 't1',
      turnEndsAt: Date.now() + 60_000,
      paused: false,
      pauseReason: null,
      awaitingReady: false,
      readyPlayerIds: [],
      guessedThisRound: [
        { id: 's1', text: 'banana', playerName: 'Alice', team: 'A' },
        { id: 's2', text: 'thunder', playerName: 'Bob', team: 'B' },
      ],
      chat: [],
    },
  });
  mockUseGame.mockReturnValue({ state, mySlip: null, isDrawer: false, isHost: false, clockOffsetMs: 0 });
  render(<Turn />);

  expect(screen.getByText('Guessed this round')).toBeInTheDocument();
  const words = screen.getAllByText(/banana|thunder/).map((n) => n.textContent);
  expect(words).toEqual(['thunder', 'banana']); // most recent first
  expect(screen.getByText('Alice')).toBeInTheDocument();
});

test('the guessed list stays out of the way before anything is guessed', () => {
  drawerTurn('ROUND1');
  render(<Turn />);
  expect(screen.queryByText('Guessed this round')).not.toBeInTheDocument();
});

test('chat is a per-room opt-in — hidden unless the host turned it on', () => {
  drawerTurn('ROUND1');
  render(<Turn />);
  expect(screen.queryByRole('heading', { name: 'Chat' })).not.toBeInTheDocument();
});

test('chat appears once the room has it enabled', () => {
  const state = makeState({
    phase: 'ROUND1',
    activeTeam: 'A',
    config: { wordsPerPlayer: 5, turnSeconds: 60, hotJoin: true, chatEnabled: true, allowSkip: { ROUND1: true, ROUND2: true, ROUND3: false } },
    round: {
      number: 1,
      remainingCount: 3,
      guessedCount: 0,
      drawerId: 'p1',
      turnId: 't1',
      turnEndsAt: Date.now() + 60_000,
      paused: false,
      pauseReason: null,
      awaitingReady: false,
      readyPlayerIds: [],
      guessedThisRound: [],
      chat: [],
    },
  });
  mockUseGame.mockReturnValue({ state, mySlip: { id: 's1', text: 'banana', authorId: 'p2' }, isDrawer: true, isHost: false, clockOffsetMs: 0 });
  render(<Turn />);
  expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument();
});
