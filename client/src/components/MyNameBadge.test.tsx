import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeState } from '../test-fixtures';
import type { Phase } from '../types';

const { mockUseGame } = vi.hoisted(() => ({ mockUseGame: vi.fn() }));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));

import MyNameBadge from './MyNameBadge';

const alice = { id: 'p1', name: 'Alice', team: 'A' as const, connected: true };

beforeEach(() => vi.clearAllMocks());

test('renders nothing before joining a room', () => {
  mockUseGame.mockReturnValue({ state: null, myPlayer: null });
  const { container } = render(<MyNameBadge />);
  expect(container).toBeEmptyDOMElement();
});

test('shows the name uncolored in the lobby, where teams are still moving', () => {
  mockUseGame.mockReturnValue({ state: makeState({ phase: 'LOBBY' as Phase }), myPlayer: alice });
  render(<MyNameBadge />);
  const name = screen.getByText('Alice');
  expect(name).toBeInTheDocument();
  expect(name).not.toHaveClass('team-blue');
  expect(screen.queryByText(/Team Blue/)).not.toBeInTheDocument();
});

test('colors the name and spells out the team once past the lobby', () => {
  mockUseGame.mockReturnValue({ state: makeState({ phase: 'ROUND2' as Phase }), myPlayer: alice });
  render(<MyNameBadge />);
  expect(screen.getByText('Alice')).toHaveClass('team-blue');
  expect(screen.getByText(/Team Blue/)).toBeInTheDocument();
});
