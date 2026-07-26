import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockAlert } = vi.hoisted(() => ({
  mockAlert: { isMuted: vi.fn(), setMuted: vi.fn(), primeAudio: vi.fn(), tick: vi.fn() },
}));
vi.mock('../alert', () => mockAlert);

import SoundToggle from './SoundToggle';

beforeEach(() => {
  vi.clearAllMocks();
  mockAlert.isMuted.mockReturnValue(false);
});

test('starts from the saved preference', () => {
  mockAlert.isMuted.mockReturnValue(true);
  render(<SoundToggle />);
  expect(screen.getByRole('button', { name: /Unmute/ })).toHaveAttribute('aria-pressed', 'true');
});

test('muting persists and stops previewing', async () => {
  render(<SoundToggle />);
  await userEvent.click(screen.getByRole('button', { name: /Mute turn alerts/ }));

  expect(mockAlert.setMuted).toHaveBeenCalledWith(true);
  expect(mockAlert.tick).not.toHaveBeenCalled(); // no parting beep on the way out
  expect(screen.getByRole('button', { name: /Unmute/ })).toBeInTheDocument();
});

test('unmuting unlocks audio and plays a confirmation', async () => {
  mockAlert.isMuted.mockReturnValue(true);
  render(<SoundToggle />);
  await userEvent.click(screen.getByRole('button', { name: /Unmute/ }));

  expect(mockAlert.setMuted).toHaveBeenCalledWith(false);
  // the click is a real user gesture, the only moment audio can be unlocked
  expect(mockAlert.primeAudio).toHaveBeenCalled();
  expect(mockAlert.tick).toHaveBeenCalled();
});
