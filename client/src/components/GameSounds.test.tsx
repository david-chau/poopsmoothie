import { test, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { makeState } from '../test-fixtures';
import type { GameState } from '../types';

const { mockUseGame, sounds } = vi.hoisted(() => ({
  mockUseGame: vi.fn(),
  sounds: { correct: vi.fn(), playerJoined: vi.fn(), roundEnd: vi.fn(), fanfare: vi.fn() },
}));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../alert', () => sounds);

import GameSounds from './GameSounds';

function withState(overrides: Partial<GameState>) {
  mockUseGame.mockReturnValue({ state: makeState({ phase: 'ROUND1', ...overrides }) });
}

beforeEach(() => vi.clearAllMocks());

test('the first state seen is a baseline, not a burst of catch-up sounds', () => {
  withState({ round: { ...makeState().round, guessedCount: 7 }, roundScores: [{ A: 3, B: 4 }] });
  render(<GameSounds />);
  expect(sounds.correct).not.toHaveBeenCalled();
  expect(sounds.roundEnd).not.toHaveBeenCalled();
  expect(sounds.playerJoined).not.toHaveBeenCalled();
});

test('a correct guess plays for everyone, off the shared count', () => {
  const base = makeState().round;
  withState({ round: { ...base, guessedCount: 0 } });
  const { rerender } = render(<GameSounds />);

  withState({ round: { ...base, guessedCount: 1 } });
  rerender(<GameSounds />);
  expect(sounds.correct).toHaveBeenCalledTimes(1);
});

test('a new player joining is announced', () => {
  withState({});
  const { rerender } = render(<GameSounds />);
  withState({ players: [...makeState().players, { id: 'p5', name: 'Eve', team: 'B', connected: true }] });
  rerender(<GameSounds />);
  expect(sounds.playerJoined).toHaveBeenCalledTimes(1);
});

test('someone leaving is not announced as a join', () => {
  withState({});
  const { rerender } = render(<GameSounds />);
  withState({ players: makeState().players.slice(0, 2) });
  rerender(<GameSounds />);
  expect(sounds.playerJoined).not.toHaveBeenCalled();
});

test('closing a round plays the round sting, and the final screen the fanfare', () => {
  withState({ roundScores: [] });
  const { rerender } = render(<GameSounds />);

  withState({ roundScores: [{ A: 5, B: 2 }] });
  rerender(<GameSounds />);
  expect(sounds.roundEnd).toHaveBeenCalledTimes(1);
  expect(sounds.fanfare).not.toHaveBeenCalled();

  withState({ phase: 'SCORES', roundScores: [{ A: 5, B: 2 }] });
  rerender(<GameSounds />);
  expect(sounds.fanfare).toHaveBeenCalledTimes(1);

  // and it does not keep firing while sitting on the scores screen
  rerender(<GameSounds />);
  expect(sounds.fanfare).toHaveBeenCalledTimes(1);
});
