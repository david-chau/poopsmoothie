import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockUseGame } = vi.hoisted(() => ({ mockUseGame: vi.fn() }));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));

import Landing from './Landing';

beforeEach(() => {
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
