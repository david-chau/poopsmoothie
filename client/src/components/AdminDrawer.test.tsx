import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { makeState } from '../test-fixtures';

const { mockUseGame } = vi.hoisted(() => ({ mockUseGame: vi.fn() }));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({ emitAck: vi.fn().mockResolvedValue({ ok: true }) }));

import AdminDrawer from './AdminDrawer';

/** The drawer's contents live inside a closed <dialog>, so every query needs
 *  `hidden: true` — this asserts on markup without depending on jsdom's
 *  showModal() support. */
function inDrawer(name: RegExp) {
  return screen.queryByRole('button', { name, hidden: true });
}

function mockState(pauseReason: string | null) {
  mockUseGame.mockReturnValue({
    state: makeState({
      phase: 'ROUND1',
      round: {
        number: 1,
        remainingCount: 3,
        guessedCount: 1,
        drawerId: 'p1',
        turnId: 't1',
        turnEndsAt: null,
        paused: pauseReason !== null,
        pauseReason,
      },
    }),
  });
}

beforeEach(() => vi.clearAllMocks());

test('offers Pause while the game is running', () => {
  mockState(null);
  render(<AdminDrawer />);
  expect(screen.getByRole('button', { name: /Admin controls/ })).toBeInTheDocument();
  expect(inDrawer(/Pause game/)).toBeInTheDocument();
  expect(inDrawer(/Resume game/)).not.toBeInTheDocument();
});

test('swaps Pause for Resume once the host has paused', () => {
  mockState('host-paused');
  render(<AdminDrawer />);
  expect(inDrawer(/Resume game/)).toBeInTheDocument();
  expect(inDrawer(/Pause game/)).not.toBeInTheDocument();
});

test('still offers Pause when the pause came from a dropped drawer, not the host', () => {
  mockState('drawer-disconnected');
  render(<AdminDrawer />);
  expect(inDrawer(/Pause game/)).toBeInTheDocument();
});

test('End room takes two taps before it fires', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const { emitAck } = await import('../socket');
  mockState(null);
  render(<AdminDrawer />);

  const btn = inDrawer(/End room for everyone/)!;
  await userEvent.click(btn);
  expect(emitAck).not.toHaveBeenCalled(); // first tap only arms it
  expect(inDrawer(/Tap again to end for everyone/)).toBeInTheDocument();

  await userEvent.click(inDrawer(/Tap again to end for everyone/)!);
  expect(emitAck).toHaveBeenCalledWith('end-room');
});

test('scoring table shows a row per guessed word, preselecting who got it', () => {
  mockUseGame.mockReturnValue({
    state: makeState({
      phase: 'ROUND2',
      guessedSlips: [{ id: 's1', text: 'banana', scoredBy: [{ round: 1, team: 'A', playerId: 'p3' }] }],
    }),
  });
  render(<AdminDrawer />);

  // round 1 (Taboo) is attributed to Carol; rounds 2/3 are still unscored
  expect(screen.getByRole('combobox', { name: /banana.*Taboo/, hidden: true })).toHaveValue('p3');
  expect(screen.getByRole('combobox', { name: /banana.*Charades/, hidden: true })).toHaveValue('');
});

test('scoring table stays out of the way until something has been guessed', () => {
  mockUseGame.mockReturnValue({ state: makeState({ phase: 'ROUND1', guessedSlips: [] }) });
  render(<AdminDrawer />);
  expect(screen.getByText(/Nothing guessed yet/)).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: /Taboo/, hidden: true })).not.toBeInTheDocument();
});

test('lists only connected players as hand-over targets', () => {
  mockUseGame.mockReturnValue({
    state: makeState({
      phase: 'ROUND1',
      players: [
        { id: 'p1', name: 'Alice', team: 'A', connected: true },
        { id: 'p2', name: 'Bob', team: 'B', connected: false },
      ],
    }),
  });
  render(<AdminDrawer />);
  // scoped to the hand-over select: the kick select deliberately lists offline
  // players too, since someone who has left is exactly who you want to remove
  const handOver = screen.getAllByRole('combobox', { hidden: true })[0];
  const options = within(handOver).getAllByRole('option', { hidden: true });
  const labels = options.map((o) => o.textContent);
  expect(labels.some((l) => l?.includes('Alice'))).toBe(true);
  expect(labels.some((l) => l?.includes('Bob'))).toBe(false); // offline
});

test('the kick list includes offline players but never the host', () => {
  mockUseGame.mockReturnValue({
    state: makeState({
      phase: 'ROUND1',
      hostId: 'p1',
      players: [
        { id: 'p1', name: 'Alice', team: 'A', connected: true },
        { id: 'p2', name: 'Bob', team: 'B', connected: false },
      ],
    }),
  });
  render(<AdminDrawer />);
  const kickSelect = screen.getAllByRole('combobox', { hidden: true })[1];
  const labels = within(kickSelect)
    .getAllByRole('option', { hidden: true })
    .map((o) => o.textContent);
  expect(labels.some((l) => l?.includes('Bob'))).toBe(true);
  expect(labels.some((l) => l?.includes('Alice'))).toBe(false); // can't kick yourself
});
