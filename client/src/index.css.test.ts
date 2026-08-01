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
  const rule = block('.word-row > .dice-btn');
  // what actually matters is that it overrides the 100%, not the specific
  // value it overrides it *with* — it's a fixed column now, because the
  // folding animation reserves and offsets by exactly this width
  expect(rule).toMatch(/width:\s*(auto|var\(--dice-col\)|[\d.]+(rem|px))/);
  expect(rule).not.toMatch(/width:\s*100%/);
});

// Regression: the dice buttons used to be unmounted while the slips folded
// into the box, which freed their column and made every slip jump sideways
// and widen at the exact moment the fold began. They now stay in the layout,
// so the box has to offset by that same column or it no longer lines up with
// the paper falling into it.
test('the folding box offsets by the dice column it now has to share the row with', () => {
  expect(block('.word-row > .dice-btn-placeholder')).toMatch(/visibility:\s*hidden/);
  expect(block('.foldaway-box')).toMatch(/margin-right:/);
});

// Regression: the folded slip replaces the input *in place*, so any metric
// that differs between the two reads as the paper resizing mid-animation.
test('the folding slip keeps the written slip\'s ink metrics', () => {
  const input = block('.write-slip-input');
  const folded = block('.foldaway-text');
  const fontOf = (rule: string) => rule.match(/font-size:\s*([^;]+)/)?.[1]?.trim();
  expect(fontOf(folded)).toBe(fontOf(input));
});

// Regression: .paper-surface carried `position:absolute; inset:0` from the rule
// it was extracted from. `inset` sets left:0, which combined with the face's
// width:200% over-constrains the box — left wins on both halves, so both
// rendered the same (left) portion of the phrase side by side.
test('the shared paper class paints only, and never positions', () => {
  const paint = block('.paper-surface');
  expect(paint).not.toMatch(/(^|[;{\s])position:/);
  expect(paint).not.toMatch(/(^|[;{\s])inset:/);
  expect(paint).toMatch(/clip-path/); // but it does still carry the torn edge
});

test('the two halves show opposite sides of the phrase, unambiguously', () => {
  // both faces pin to the same edge; the right one shifts by exactly one half.
  // left:0 on one + right:0 on the other reads as symmetric but over-constrains
  // width:200%, and whichever edge wins decides — silently — which half of the
  // phrase you see. That flipped "Star Wars" to "Wars | Star".
  expect(block('.slip-face')).toMatch(/left:\s*0/);
  expect(block('.slip-face')).not.toMatch(/right:\s*0/);
  expect(block('.slip-half-right .slip-face')).toMatch(/translateX\(-50%\)/);
  expect(block('.slip-half-left .slip-face')).toBe(''); // the left half needs no override at all
});

// Regression: the flap has to be the right half. Hinging the left one makes the
// folded slip sit on the right and open leftward — the animation reads as
// running backwards.
test('the flap hinges on the crease, opening rightward', () => {
  expect(block('.slip-half-right')).toMatch(/transform-origin:\s*left center/);
  expect(css).not.toMatch(/\.slip-half-left\s*\{[^}]*transform-origin/);
});

// The back has to read as the same paper, darker. Overriding background-color
// or background-image to darken it replaces the whole crumple stack inherited
// from .paper-surface, leaving a flat tan rectangle with no texture at all —
// which is exactly what it looked like. Darken with a filter instead.
test('the back of the fold is darker but still paper', () => {
  const back = block('.paper-surface-blank');
  expect(back).toMatch(/filter:[^;]*brightness\(0?\.\d+\)/); // visibly darker
  expect(back).not.toMatch(/background-image:/); // or the texture is gone
  expect(back).not.toMatch(/background-color:/);
});

// Regression: with `transform-style: preserve-3d` on .slip the two halves are
// depth-sorted — z-index is ignored, and the flap fights the half it folds onto
// for who paints on top. Coplanar at the end of the swing, so it flickered and
// settled underneath. Flat, they paint in DOM order and the flap (later sibling)
// is always above.
test('the slip is a flat stacking context, so the flap always paints on top', () => {
  expect(block('.slip')).not.toMatch(/transform-style/);
  expect(block('.slip')).toMatch(/perspective/); // depth still comes from here
  expect(block('.foldaway-slip')).not.toMatch(/transform-style/);
  // z-index would be meaningless in a 3D context and unnecessary in a flat one
  expect(block('.slip-half-right')).not.toMatch(/z-index:/);
});

test('each half still owns a 3D context, for its front/back faces', () => {
  expect(block('.slip-half')).toMatch(/transform-style:\s*preserve-3d/);
  expect(block('.slip-clip')).toMatch(/backface-visibility:\s*hidden/);
});

// Regression: the drawer has the most on screen (timer + slip + both action
// buttons + the chat panel) and is the one person who must never lose sight
// of the clock — with chat open it used to scroll away entirely.
test('the timer sticks to the top rather than scrolling away', () => {
  const rule = block('.timer');
  expect(rule).toMatch(/position:\s*sticky/);
  expect(rule).toMatch(/top:\s*0/);
  expect(rule).toMatch(/background:/); // or content scrolls visibly through it
});

// Regression: `.turn-actions .btn` and `.turn-actions-compact .btn` have equal
// specificity, so the compact override only works if it comes *after*. It was
// declared earlier and silently did nothing.
test('the compact action buttons override the default height', () => {
  expect(block('.turn-actions-compact .btn')).toMatch(/min-height:\s*48px/);
  expect(css.indexOf('.turn-actions-compact .btn')).toBeGreaterThan(css.indexOf('.turn-actions .btn'));
});

// Regression: these are set-once controls competing with the timer and the
// slip for height — they have to float, not push the log down.
test('the voice options menu floats instead of taking permanent height', () => {
  expect(block('.turn-chat-menu-panel')).toMatch(/position:\s*absolute/);
  expect(block('.turn-chat-menu')).toMatch(/position:\s*relative/);
});

// Regression: in a fixed, non-scrolling column the on-screen keyboard covers
// the compose box and there is no scrolling to escape it. 100svh describes the
// whole screen *including* the covered part, so the height has to come from
// the visual viewport instead (TurnChat sets --app-vh).
test('the fixed screen shrinks to the space the keyboard leaves', () => {
  expect(block('.app-shell:has(.screen-fit)')).toMatch(/height:\s*var\(--app-vh/);
});

// Regression: the meter used to mount/unmount with the mic, which changed the
// header's width and bounced the ⋯ and filters onto another row mid-tap.
test('the idle meter is hidden but still occupies the row', () => {
  expect(block('.mic-meter-idle')).toMatch(/visibility:\s*hidden/);
  expect(block('.mic-meter-idle')).not.toMatch(/display:\s*none/);
  expect(block('.turn-chat-mic')).toMatch(/min-width:/);
});
