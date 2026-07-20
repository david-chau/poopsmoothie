import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeState } from '../test-fixtures';

const { mockUseGame } = vi.hoisted(() => ({ mockUseGame: vi.fn() }));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({ emitAck: vi.fn().mockResolvedValue({ ok: true }) }));

import Writing from './Writing';

beforeEach(() => vi.clearAllMocks());

test('renders one input per configured word', () => {
  const state = makeState({ phase: 'WRITING', config: { wordsPerPlayer: 3, turnSeconds: 60, allowSkip: { ROUND1: true, ROUND2: true, ROUND3: false } } });
  mockUseGame.mockReturnValue({ state, identity: { playerId: 'p1' }, isHost: false, leaveToLanding: vi.fn() });
  render(<Writing />);
  expect(screen.getByPlaceholderText('Word 1')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Word 3')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Word 4')).not.toBeInTheDocument();
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
