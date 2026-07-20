import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeState } from '../test-fixtures';
import type { Phase } from '../types';

const { mockUseGame } = vi.hoisted(() => ({ mockUseGame: vi.fn() }));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({ emitAck: vi.fn().mockResolvedValue({ ok: true }) }));

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
