import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeState } from '../test-fixtures';

const { mockUseGame, mockOnVoiceLanguages } = vi.hoisted(() => ({
  mockUseGame: vi.fn(),
  // default: no languages available, so the picker just doesn't render,
  // same as Phase 1 — one test below overrides this to check the picker itself
  mockOnVoiceLanguages: vi.fn((fn: (langs: string[]) => void) => {
    fn([]);
    return () => {};
  }),
}));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({
  emitAck: vi.fn().mockResolvedValue({ ok: true }),
  onVoiceLanguages: mockOnVoiceLanguages,
}));

import Lobby from './Lobby';

beforeEach(() => vi.clearAllMocks());

test('renders team columns with Blue/Red labels', () => {
  mockUseGame.mockReturnValue({ state: makeState(), identity: { playerId: 'p1' }, isHost: true, leaveToLanding: vi.fn() });
  render(<Lobby />);
  // scope to the column headings — "Team Blue"/"Team Red" also appear in the
  // (closed) rules dialog's intro text
  expect(screen.getByRole('heading', { name: 'Team Blue' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Team Red' })).toBeInTheDocument();
});

test('host start button is enabled at 4 connected players', () => {
  mockUseGame.mockReturnValue({ state: makeState(), identity: { playerId: 'p1' }, isHost: true, leaveToLanding: vi.fn() });
  render(<Lobby />);
  expect(screen.getByRole('button', { name: /Start game/ })).toBeEnabled();
});

test('host start button is disabled below 4 connected players, showing how many more', () => {
  const state = makeState({
    players: [
      { id: 'p1', name: 'Alice', team: 'A', connected: true },
      { id: 'p2', name: 'Bob', team: 'B', connected: true },
      { id: 'p3', name: 'Carol', team: 'A', connected: false }, // disconnected
      { id: 'p4', name: 'Dave', team: 'B', connected: false },
    ],
  });
  mockUseGame.mockReturnValue({ state, identity: { playerId: 'p1' }, isHost: true, leaveToLanding: vi.fn() });
  render(<Lobby />);
  const btn = screen.getByRole('button', { name: /Start game/ });
  expect(btn).toBeDisabled();
  expect(btn).toHaveTextContent('need 2 more');
});

test('non-host does not see the settings/start panel', () => {
  mockUseGame.mockReturnValue({ state: makeState(), identity: { playerId: 'p2' }, isHost: false, leaveToLanding: vi.fn() });
  render(<Lobby />);
  expect(screen.queryByRole('button', { name: /Start game/ })).not.toBeInTheDocument();
});

test('only the host can close the room, and it takes a confirmation', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const { emitAck } = await import('../socket');
  const state = makeState();

  mockUseGame.mockReturnValue({ state, identity: { playerId: 'p1' }, isHost: false, leaveToLanding: vi.fn() });
  const { unmount } = render(<Lobby />);
  expect(screen.queryByRole('button', { name: /End room for everyone/ })).not.toBeInTheDocument();
  unmount();

  mockUseGame.mockReturnValue({ state, identity: { playerId: 'p1' }, isHost: true, leaveToLanding: vi.fn() });
  render(<Lobby />);
  const button = screen.getByRole('button', { name: /End room for everyone/ });

  // closing a room out from under everyone shouldn't happen on a stray tap
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await userEvent.click(button);
  expect(emitAck).not.toHaveBeenCalledWith('end-room');

  confirm.mockReturnValue(true);
  await userEvent.click(button);
  expect(emitAck).toHaveBeenCalledWith('end-room');
  confirm.mockRestore();
});

test('chat/voice is a host-only toggle, off by default (a beta, opt-in per room)', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const { emitAck } = await import('../socket');
  const state = makeState(); // chatEnabled: false by default

  mockUseGame.mockReturnValue({ state, identity: { playerId: 'p1' }, isHost: true, leaveToLanding: vi.fn() });
  render(<Lobby />);

  const toggle = screen.getByRole('checkbox', { name: /Chat & voice/ });
  expect(toggle).not.toBeChecked();

  await userEvent.click(toggle);
  expect(emitAck).toHaveBeenCalledWith('set-config', { chatEnabled: true });
});

test('voice language picker is hidden until chat is on and the server actually offers a language', () => {
  mockOnVoiceLanguages.mockImplementation((fn: (langs: string[]) => void) => {
    fn(['en', 'zh']);
    return () => {};
  });
  const state = makeState({ config: { ...makeState().config, chatEnabled: false } });
  mockUseGame.mockReturnValue({ state, identity: { playerId: 'p1' }, isHost: true, leaveToLanding: vi.fn() });
  render(<Lobby />);
  expect(screen.queryByText('Voice language')).not.toBeInTheDocument();
});

test('voice language picker offers only what the server has loaded, and toggling sends set-config', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const { emitAck } = await import('../socket');
  mockOnVoiceLanguages.mockImplementation((fn: (langs: string[]) => void) => {
    fn(['en', 'zh']);
    return () => {};
  });
  const state = makeState({ config: { ...makeState().config, chatEnabled: true, voiceLanguage: 'en' } });
  mockUseGame.mockReturnValue({ state, identity: { playerId: 'p1' }, isHost: true, leaveToLanding: vi.fn() });
  render(<Lobby />);

  const english = screen.getByRole('radio', { name: /English/ });
  const chinese = screen.getByRole('radio', { name: '中文' });
  expect(english).toBeChecked();
  expect(chinese).not.toBeChecked();

  await userEvent.click(chinese);
  expect(emitAck).toHaveBeenCalledWith('set-config', { voiceLanguage: 'zh' });
});

test('voice language picker only shows languages the server reports, not every known one', () => {
  mockOnVoiceLanguages.mockImplementation((fn: (langs: string[]) => void) => {
    fn(['en']); // this box never fetched the Chinese model
    return () => {};
  });
  const state = makeState({ config: { ...makeState().config, chatEnabled: true } });
  mockUseGame.mockReturnValue({ state, identity: { playerId: 'p1' }, isHost: true, leaveToLanding: vi.fn() });
  render(<Lobby />);
  expect(screen.getByRole('radio', { name: /English/ })).toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: '中文' })).not.toBeInTheDocument();
});
