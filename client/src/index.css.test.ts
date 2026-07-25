import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(__dirname, 'index.css'), 'utf8');

/** the declarations inside `selector { ... }` */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

// Regression: a bare `display:` on a <dialog> overrides the UA's
// `dialog:not([open]) { display: none }`, so the sheet renders permanently and
// its Close button becomes a no-op. Layout must hang off [open].
test('dialog layout is scoped to [open] so closing actually hides it', () => {
  for (const selector of ['.admin-drawer', '.rules-dialog']) {
    expect(block(selector), `${selector} must not set display unconditionally`).not.toMatch(/display:/);
  }
  expect(block('.admin-drawer[open]')).toMatch(/display:\s*flex/);
});

// Regression: `.btn { width: 100% }` is declared after `.dice-btn`, so an
// unscoped `.dice-btn { width: auto }` loses on source order and the button
// swallows the whole row.
test('the dice button outranks the generic .btn width', () => {
  expect(css).toMatch(/\.word-row\s*>\s*\.dice-btn\s*\{/);
  expect(css.indexOf('.word-row > .dice-btn')).toBeGreaterThan(-1);
  expect(block('.word-row > .dice-btn')).toMatch(/width:\s*auto/);
});
