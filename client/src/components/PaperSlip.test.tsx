import { test, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import PaperSlip from './PaperSlip';

/** The sequencing lives in framer variant transitions, which have no DOM
 *  footprint under jsdom — assert on the source rather than fake a DOM test. */
const PaperSlipSource = fs.readFileSync(path.join(__dirname, 'PaperSlip.tsx'), 'utf8');

test('the phrase is rendered in both halves so it reads across the crease', () => {
  render(<PaperSlip text="Spider-Man" slipKey="s1" />);
  // one copy per half — the left half clips the left of the phrase, the right
  // half the right, and both faces carry the whole string
  expect(screen.getAllByText('Spider-Man')).toHaveLength(2);
});

test('the flap is the right half, and carries a blank back', () => {
  const { container } = render(<PaperSlip text="Napoleon" slipKey="s1" />);
  expect(container.querySelectorAll('.slip-half')).toHaveLength(2);
  // You hold the left half; the right one folds over it and opens rightward.
  // Hinging the left half instead makes the slip sit on the right and open
  // leftward, which reads as the animation running backwards.
  expect(container.querySelector('.slip-half-right .slip-clip-front')).toBeTruthy();
  expect(container.querySelector('.slip-half-right .slip-clip-back .paper-surface-blank')).toBeTruthy();
  // the static half has a single, unflipped face
  expect(container.querySelectorAll('.slip-half-left .slip-clip')).toHaveLength(1);
  expect(container.querySelector('.slip-half-left .slip-clip-back')).toBeNull();
});

test('ink size steps down as the phrase gets longer, instead of overflowing', () => {
  const size = (text: string) => {
    const { container, unmount } = render(<PaperSlip text={text} slipKey="k" />);
    const cls = container.querySelector('.paper-slip-text')!.className;
    unmount();
    return cls;
  };
  expect(size('Pickle')).not.toMatch(/long/);
  expect(size('Hot air balloon')).toMatch(/paper-slip-text-long/);
  expect(size('Trying to fold a fitted sheet')).toMatch(/paper-slip-text-xlong/);
});

// Regression: .slip is a flex row, so DOM order *is* left-to-right order.
// Rendering the right half first put "Wars" before "Star" — the phrase read
// backwards across the crease.
test('the left half comes first, or the phrase reads back to front', () => {
  const { container } = render(<PaperSlip text="Star Wars" slipKey="s1" />);
  const halves = [...container.querySelectorAll('.slip-half')];
  expect(halves).toHaveLength(2);
  expect(halves[0].className).toMatch(/slip-half-left/);
  expect(halves[1].className).toMatch(/slip-half-right/);
});

test('the ink is plain — the fold itself is the reveal', () => {
  const { container } = render(<PaperSlip text="Ramen" slipKey="s1" />);
  // No opacity animation on either half. Opening the paper already reveals the
  // writing: the flap's back hides it while shut, and you read more of the
  // phrase the further it swings, exactly as unfolding it by hand. Fading the
  // text in on top of that did the same job twice, on its own schedule.
  for (const ink of container.querySelectorAll('.paper-slip-text')) {
    expect(ink).not.toHaveStyle({ opacity: '0' });
  }
  expect(container.querySelectorAll('.paper-slip-text')).toHaveLength(2);
});

test('a new slipKey swaps in a whole new slip, rather than re-inking the old one', async () => {
  const { rerender } = render(<PaperSlip text="Nachos" slipKey="s1" />);
  expect(screen.getAllByText('Nachos')).toHaveLength(2);

  rerender(<PaperSlip text="Ramen" slipKey="s2" />);
  // AnimatePresence mode="wait" keeps the old slip mounted until it has left,
  // so the new one appears a beat later rather than synchronously
  await waitFor(() => expect(screen.getAllByText('Ramen')).toHaveLength(2));
  expect(screen.queryByText('Nachos')).toBeNull();
  // (the *direction* — old exits left, new enters right — is a visual property
  // with no stable DOM footprint under jsdom, so it isn't asserted here.)
});

// Each phase has to finish before the next starts, or it reads as one slip
// morphing rather than paper being handled: rise → unfold, and on a pass,
// fold shut → drop back.
test('rising, unfolding and folding back are sequenced, not overlapped', () => {
  render(<PaperSlip text="Ramen" slipKey="s1" />);
  // a slip only unfolds once it has risen into place
  expect(PaperSlipSource).toMatch(/open:\s*\{\s*rotateY:\s*0,[^}]*delay:\s*RISE/s);
  // and a passed one only drops once it has finished folding shut
  expect(PaperSlipSource).toMatch(/delay:\s*FOLD_SHUT/);
});

// The physical game: slips come out of the box, guessed ones are kept face-up,
// passed ones are folded and go back to be drawn again.
test('a guessed slip is lifted away still open; a passed one folds and goes back', () => {
  // exiting after a correct guess: up and out, and the flap stays at 0deg
  const { container: won } = render(
    <PaperSlip text="Ramen" slipKey="s1" flash={{ id: 1, kind: 'correct' }} />,
  );
  expect(won.querySelector('.slip')).toBeTruthy();

  // exiting after a pass: the flap closes again before it moves
  const { container: passed } = render(<PaperSlip text="Ramen" slipKey="s2" flash={{ id: 2, kind: 'pass' }} />);
  expect(passed.querySelector('.slip')).toBeTruthy();

  // the branch itself — framer variants have no DOM footprint under jsdom
  expect(PaperSlipSource).toMatch(/wasGuessed\s*=\s*flash\?\.kind === 'correct'/);
  expect(PaperSlipSource).toMatch(/exit:\s*wasGuessed[\s\S]*rotateY:\s*0.*stays open/);
  expect(PaperSlipSource).toMatch(/enter:\s*\{\s*y:\s*'140%'/); // up out of the box
  expect(PaperSlipSource).toMatch(/y:\s*'-140%'/); // guessed: away off the top
});
