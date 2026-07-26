import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeState } from '../test-fixtures';
import type { GameState } from '../types';

const { mockUseGame, mockEmitAck } = vi.hoisted(() => ({ mockUseGame: vi.fn(), mockEmitAck: vi.fn() }));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({ emitAck: mockEmitAck }));

import RoundIntermission from './RoundIntermission';

function show(overrides: Partial<GameState> = {}, opts: { isHost?: boolean; me?: string } = {}) {
  const base = makeState();
  mockUseGame.mockReturnValue({
    state: makeState({
      phase: 'ROUND2',
      roundScores: [{ A: 5, B: 3 }],
      teamScores: { A: 5, B: 3 },
      round: { ...base.round, number: 2, awaitingReady: true, readyPlayerIds: [] },
      ...overrides,
    }),
    identity: { playerId: opts.me ?? 'p1' },
    isHost: opts.isHost ?? false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmitAck.mockResolvedValue({ ok: true });
});

test('recaps the round that just finished and names the next one', () => {
  show();
  render(<RoundIntermission />);
  expect(screen.getByText(/Round 1 done/)).toBeInTheDocument();
  expect(screen.getByText('+5')).toBeInTheDocument();
  expect(screen.getByText(/took the round/)).toBeInTheDocument();
  expect(screen.getByText(/Next:.*Round 2/)).toBeInTheDocument();
});

test('marking ready reports it and then waits', async () => {
  show();
  render(<RoundIntermission />);
  await userEvent.click(screen.getByRole('button', { name: /I'm ready/ }));
  expect(mockEmitAck).toHaveBeenCalledWith('player-ready');
});

test('once you are ready the button locks and says so', () => {
  const base = makeState();
  show({ round: { ...base.round, number: 2, awaitingReady: true, readyPlayerIds: ['p1'] } });
  render(<RoundIntermission />);
  expect(screen.getByRole('button', { name: /Waiting for the others/ })).toBeDisabled();
});

test('counts only connected players, so an offline one cannot stall the count', () => {
  const base = makeState();
  show({
    players: [
      { id: 'p1', name: 'Alice', team: 'A', connected: true },
      { id: 'p2', name: 'Bob', team: 'B', connected: true },
      { id: 'p3', name: 'Ghost', team: 'A', connected: false },
    ],
    round: { ...base.round, number: 2, awaitingReady: true, readyPlayerIds: ['p1'] },
  });
  render(<RoundIntermission />);
  expect(screen.getByText(/1 of 2 ready/)).toBeInTheDocument();
  expect(screen.getByText(/Alice/)).toBeInTheDocument();
});

test('only the host is offered the override', () => {
  show({}, { isHost: false });
  const { unmount } = render(<RoundIntermission />);
  expect(screen.queryByRole('button', { name: /Start the round now/ })).not.toBeInTheDocument();
  unmount();

  show({}, { isHost: true });
  render(<RoundIntermission />);
  expect(screen.getByRole('button', { name: /Start the round now/ })).toBeInTheDocument();
});
