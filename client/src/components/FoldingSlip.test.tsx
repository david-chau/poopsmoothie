import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { FoldingSlip, SlipBox, foldAwayDurationMs } from './FoldingSlip';

/** the drop path lives in framer keyframes, which jsdom never runs */
const FoldingSlipSource = fs.readFileSync(path.join(__dirname, 'FoldingSlip.tsx'), 'utf8');

test('keeps the written phrase, in both halves like the reveal', () => {
  render(<FoldingSlip text="Pancakes" index={0} total={5} />);
  expect(screen.getAllByText('Pancakes')).toHaveLength(2);
});

test('folds a half onto the other, same flap as the reveal', () => {
  const { container } = render(<FoldingSlip text="Frozen" index={0} total={3} />);
  expect(container.querySelector('.slip-half-right .slip-clip-front')).toBeTruthy();
  expect(container.querySelector('.slip-half-right .slip-clip-back .paper-surface-blank')).toBeTruthy();
  expect(container.querySelector('.slip-half-left .slip-clip-back')).toBeNull();
});

// It animates in place inside the writing screen's own row. Playing it on a
// separate screen re-laid everything out first, so the slips visibly shrank and
// slid down the page before any folding started.
test('keeps the exact footprint of the input it replaces', () => {
  const { container } = render(<FoldingSlip text="Frozen" index={0} total={3} />);
  expect(container.firstElementChild).toHaveClass('write-slip');
});

test('the box is decorative and arrives before the slips', () => {
  const { container } = render(<SlipBox />);
  expect(container.querySelector('.foldaway-box')).toHaveAttribute('aria-hidden', 'true');
});

// Folding collapses a slip onto the left half of its row, so its centre sits a
// quarter-width left of where it started and it fell past the box's edge.
test('a folding slip moves sideways as well as down, to land in the box', () => {
  const { container } = render(<FoldingSlip text="Frozen" index={0} total={3} />);
  expect(container.firstElementChild).toHaveClass('write-slip');
  expect(FoldingSlipSource).toMatch(/x:\s*\[0,\s*0,\s*'25%'\]/);
});

test('the caller is told how long to wait, and it scales with the slips', () => {
  // long enough to actually watch — the old one was over almost instantly
  expect(foldAwayDurationMs(1)).toBeGreaterThan(1000);
  expect(foldAwayDurationMs(5)).toBeGreaterThan(foldAwayDurationMs(1));
  expect(foldAwayDurationMs(5)).toBeLessThan(3000); // but never a wait
});
