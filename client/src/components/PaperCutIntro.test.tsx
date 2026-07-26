import { test, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import PaperCutIntro, { paperCutDurationMs } from './PaperCutIntro';

test('cuts the sheet into exactly one strip per slip', () => {
  const { container } = render(<PaperCutIntro count={5} onDone={vi.fn()} />);
  expect(container.querySelectorAll('.papercut-strip')).toHaveLength(5);
  expect(container.querySelector('.papercut-blade')).toBeTruthy();
});

// The sheet is the finished slips stacked edge to edge, so the cut is the gaps
// opening between them. That's what puts the strips exactly where the writing
// rows appear — a separately-sized sheet would jump at the handover.
test('the sheet is the stacked slips, and ends at the rows own height', () => {
  const { container } = render(<PaperCutIntro count={4} onDone={vi.fn()} />);
  const ROW_H = 56;
  const ROW_GAP = 12;
  const sheet = container.querySelector('.papercut-sheet') as HTMLElement;
  const frame = container.querySelector('.papercut') as HTMLElement;

  expect(sheet.style.height).toBe(`${4 * ROW_H}px`); // uncut: no gaps yet
  expect(frame.style.height).toBe(`${4 * ROW_H + 3 * ROW_GAP}px`); // cut: gaps opened
  // each strip is one row tall, stacked with no space between
  const strips = [...container.querySelectorAll('.papercut-strip')] as HTMLElement[];
  strips.forEach((strip, i) => {
    expect(strip.style.height).toBe(`${ROW_H}px`);
    expect(strip.style.top).toBe(`${i * ROW_H}px`);
  });
});

test('it always hands over, so the form can never be stuck behind it', async () => {
  const onDone = vi.fn();
  render(<PaperCutIntro count={5} onDone={onDone} />);
  await waitFor(() => expect(onDone).toHaveBeenCalled(), { timeout: paperCutDurationMs() + 800 });
});

test('it is decorative, and skipped entirely under reduced motion', async () => {
  const { container } = render(<PaperCutIntro count={3} onDone={vi.fn()} />);
  expect(container.querySelector('.papercut')).toHaveAttribute('aria-hidden', 'true');

  vi.resetModules();
  vi.doMock('framer-motion', async () => {
    const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion');
    return { ...actual, useReducedMotion: () => true };
  });
  const { default: Reduced } = await import('./PaperCutIntro');
  const onDone = vi.fn();
  const { container: reduced } = render(<Reduced count={3} onDone={onDone} />);
  expect(reduced).toBeEmptyDOMElement(); // no paper flying about
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  vi.doUnmock('framer-motion');
});
