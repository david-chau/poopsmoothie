import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeState } from '../test-fixtures';

const { mockUseGame, mockEmitAck } = vi.hoisted(() => ({ mockUseGame: vi.fn(), mockEmitAck: vi.fn() }));
vi.mock('../GameContext', () => ({ useGame: mockUseGame }));
vi.mock('../socket', () => ({ emitAck: mockEmitAck }));
// These tests are about the form, not the sheet-into-slips intro that plays
// before it. Stubbing it keeps them focused and off a 1.3s wait apiece; the
// intro has its own tests.
vi.mock('../components/PaperCutIntro', () => ({
  default: ({ onDone }: { onDone: () => void }) => {
    onDone();
    return null;
  },
}));

import Writing from './Writing';

/** writing screen with `n` empty boxes */
function writingScreen(n: number) {
  const state = makeState({
    phase: 'WRITING',
    config: { wordsPerPlayer: n, turnSeconds: 60, hotJoin: true, allowSkip: { ROUND1: true, ROUND2: true, ROUND3: false } },
  });
  mockUseGame.mockReturnValue({ state, identity: { playerId: 'p1' }, isHost: false, leaveToLanding: vi.fn() });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmitAck.mockResolvedValue({ ok: true });
});

test('renders one input per configured word', () => {
  writingScreen(3);
  render(<Writing />);
  expect(screen.getByPlaceholderText('Word or phrase 1')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Word or phrase 3')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Word or phrase 4')).not.toBeInTheDocument();
});

test('the dice button fills only its own box', async () => {
  writingScreen(3);
  mockEmitAck.mockResolvedValue({ ok: true, words: ['Pineapple'] });
  render(<Writing />);

  await userEvent.click(screen.getByRole('button', { name: /Suggest a word or phrase for slot 2/ }));

  await waitFor(() => expect(screen.getByPlaceholderText('Word or phrase 2')).toHaveValue('Pineapple'));
  expect(screen.getByPlaceholderText('Word or phrase 1')).toHaveValue('');
  expect(screen.getByPlaceholderText('Word or phrase 3')).toHaveValue('');
});

test('fill-the-rest keeps what you typed and only asks for the empty slots', async () => {
  writingScreen(3);
  render(<Writing />);
  await userEvent.type(screen.getByPlaceholderText('Word or phrase 1'), 'Sushi');

  mockEmitAck.mockResolvedValue({ ok: true, words: ['Igloo', 'Kayak'] });
  await userEvent.click(screen.getByRole('button', { name: /Fill the empty ones/ }));

  await waitFor(() => expect(screen.getByPlaceholderText('Word or phrase 2')).toHaveValue('Igloo'));
  expect(screen.getByPlaceholderText('Word or phrase 1')).toHaveValue('Sushi'); // untouched
  expect(screen.getByPlaceholderText('Word or phrase 3')).toHaveValue('Kayak');
  // asked for 2, and told the server what's already in the boxes so it can't hand back a clash
  expect(mockEmitAck).toHaveBeenLastCalledWith('suggest-words', { count: 2, exclude: ['Sushi', '', ''] });
});

test('fill-the-rest is disabled once every box is filled', async () => {
  writingScreen(1);
  render(<Writing />);
  const fillAll = screen.getByRole('button', { name: /Fill the empty ones/ });
  expect(fillAll).toBeEnabled();
  await userEvent.type(screen.getByPlaceholderText('Word or phrase 1'), 'Sushi');
  expect(fillAll).toBeDisabled();
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

/** fill a slip without userEvent's per-keystroke re-render of the paper */
function write(index: number, text: string) {
  fireEvent.change(screen.getByPlaceholderText(`Word or phrase ${index}`), { target: { value: text } });
}

test('slips fold into the box before anything is submitted', async () => {
  writingScreen(2);
  render(<Writing />);
  write(1, 'Walrus');
  write(2, 'Nachos');

  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

  // the physical part happens first: nothing has been sent yet
  expect(mockEmitAck).not.toHaveBeenCalledWith('submit-words', expect.anything());
  expect(screen.getByText('in the box')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Word or phrase 1')).toBeNull(); // inputs gone, slips folding

  // ...and only once they've landed does it go
  await waitFor(() => expect(mockEmitAck).toHaveBeenCalledWith('submit-words', { words: ['Walrus', 'Nachos'] }), {
    timeout: 4000,
  });
});

test('an empty slip is caught before the animation, not after it', () => {
  writingScreen(2);
  render(<Writing />);
  write(1, 'Walrus'); // slip 2 left blank

  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

  // no point folding paper into a box only for the server to reject it
  expect(screen.getByText(/Fill in all 2 slips first/)).toBeInTheDocument();
  expect(screen.queryByText('in the box')).toBeNull();
  expect(mockEmitAck).not.toHaveBeenCalledWith('submit-words', expect.anything());
});

test('the re-roll buttons go away on submit, so the slips centre on the box', () => {
  writingScreen(2);
  render(<Writing />);
  write(1, 'Walrus');
  write(2, 'Nachos');
  expect(screen.getAllByRole('button', { name: /Suggest a word or phrase/ })).toHaveLength(2);

  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

  // nothing left to re-roll once they're folding, and leaving them mounted made
  // the rows narrower than the screen so the slips fell past the box's edge
  expect(screen.queryAllByRole('button', { name: /Suggest a word or phrase/ })).toHaveLength(0);
  expect(screen.getByText('in the box')).toBeInTheDocument();
});

test('the sheet is cut into slips before the form appears', async () => {
  // unmock the intro for this one: the point is that it gates the inputs
  vi.resetModules();
  vi.doUnmock('../components/PaperCutIntro');
  const { default: RealWriting } = await import('./Writing');

  writingScreen(3);
  render(<RealWriting />);

  // paper first, no form yet
  expect(document.querySelectorAll('.papercut-strip')).toHaveLength(3);
  expect(screen.queryByPlaceholderText('Word or phrase 1')).toBeNull();

  // and it always hands over to the real inputs
  await waitFor(() => expect(screen.getByPlaceholderText('Word or phrase 1')).toBeInTheDocument(), {
    timeout: 4000,
  });
  expect(document.querySelector('.papercut')).toBeNull();
});

test('someone returning to a room they already submitted in skips the intro', async () => {
  const base = makeState();
  mockUseGame.mockReturnValue({
    state: makeState({
      phase: 'WRITING',
      submittedPlayerIds: ['p1'],
      players: base.players,
    }),
    identity: { playerId: 'p1' },
    isHost: false,
    leaveToLanding: vi.fn(),
  });
  render(<Writing />);
  // straight to the waiting view — no re-cutting paper they already filled in
  expect(screen.getByText(/Words in/)).toBeInTheDocument();
  expect(document.querySelector('.papercut')).toBeNull();
});
