import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { makeState } from '../test-fixtures';
import type { Slip } from '../types';

const { mockUseGame } = vi.hoisted(() => ({ mockUseGame: vi.fn() }));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({ emitAck: vi.fn().mockResolvedValue({ ok: true }) }));

import Scores from './Scores';

const pool: Slip[] = [
  { id: 's1', text: 'banana', authorId: 'p1', scoredBy: [{ round: 1, team: 'A', playerId: 'p1' }] },
  { id: 's2', text: 'thunder', authorId: 'p2', scoredBy: [{ round: 1, team: 'A', playerId: 'p1' }] },
  { id: 's3', text: 'pickle', authorId: 'p3', scoredBy: [{ round: 1, team: 'B', playerId: 'p2' }] },
];

function scoresState(scores: { A: number; B: number }) {
  return makeState({
    phase: 'SCORES',
    teamScores: scores,
    roundScores: [scores],
    pool,
  });
}

beforeEach(() => vi.clearAllMocks());

function renderScores({ isHost }: { isHost: boolean }) {
  mockUseGame.mockReturnValue({ state: scoresState({ A: 2, B: 1 }), leaveToLanding: vi.fn(), isHost });
  render(<Scores />);
}

test('badges the winning team with a trophy and calls per-team MVP', () => {
  mockUseGame.mockReturnValue({ state: scoresState({ A: 2, B: 1 }), leaveToLanding: vi.fn() });
  render(<Scores />);
  // Team Blue heading contains the trophy; Team Red does not
  const blueHeading = screen.getByText('Team Blue').closest('h2')!;
  expect(within(blueHeading).getByText('🏆')).toBeInTheDocument();
  const redHeading = screen.getByText('Team Red').closest('h2')!;
  expect(within(redHeading).queryByText('🏆')).not.toBeInTheDocument();
  // MVP: p1 (Alice) scored 2 for blue, p2 (Bob) scored 1 for red
  const mvpLines = screen.getAllByText(/MVP:/).map((el) => el.closest('.mvp-line')!);
  expect(mvpLines).toHaveLength(2);
  expect(within(mvpLines[0]).getByText('Alice')).toBeInTheDocument(); // blue MVP
  expect(within(mvpLines[1]).getByText('Bob')).toBeInTheDocument(); // red MVP
});

test('shows a tie message and no trophy when scores are equal', () => {
  mockUseGame.mockReturnValue({ state: scoresState({ A: 2, B: 2 }), leaveToLanding: vi.fn() });
  render(<Scores />);
  expect(screen.getByText(/It.s a tie!/)).toBeInTheDocument();
  expect(screen.queryByText('🏆')).not.toBeInTheDocument();
});

test('reveals the full pool with author + per-round scorer', () => {
  mockUseGame.mockReturnValue({ state: scoresState({ A: 2, B: 1 }), leaveToLanding: vi.fn() });
  render(<Scores />);
  const bananaRow = screen.getByText('banana').closest('tr')!;
  // author p1 (Alice) + round-1 scorer p1 (Alice) both appear in this row
  expect(within(bananaRow).getAllByText('Alice').length).toBeGreaterThanOrEqual(1);
  const pickleRow = screen.getByText('pickle').closest('tr')!;
  expect(within(pickleRow).getByText('Carol')).toBeInTheDocument(); // author p3
});

test('only the host is offered a rematch, and it keeps the room', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const { emitAck } = await import('../socket');

  renderScores({ isHost: false });
  expect(screen.queryByRole('button', { name: /Play again/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Leave room' })).toBeInTheDocument();
  cleanup();

  renderScores({ isHost: true });
  await userEvent.click(screen.getByRole('button', { name: /Play again/ }));
  expect(emitAck).toHaveBeenCalledWith('play-again');
});
