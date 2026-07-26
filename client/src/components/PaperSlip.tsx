import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

interface PaperSlipProps {
  text: string;
  /** changing this re-triggers the unfold — one animation per drawn slip */
  slipKey: string;
  /** brief text-color pulse on Correct/Pass, before the next slip unfolds in */
  flash?: { id: number; kind: 'correct' | 'pass' } | null;
}

// A slip's life follows the physical game. It comes up out of the box below,
// and where it goes afterwards depends on what happened to it:
//
//   guessed  -> lifted away and kept, still open. Nobody refolds a slip they
//               just won; it goes on the pile face-up.
//   passed   -> folded shut again and dropped back in the box, because it is
//               going to be drawn again later.
//
// Each phase waits for the last, or it reads as one slip morphing rather than
// paper being handled. Kept as tight as the sequence allows: this plays after
// every guess, and it's time the drawer isn't reading the next word.
const RISE = 0.28; // up out of the box
const UNFOLD = 0.42;
const FOLD_SHUT = 0.32; // only for a pass
const LEAVE = 0.26; // up and away, or back down into the box

/** Slips hold phrases, not just words. CSS can't measure the string, so pick
 *  the size band here rather than letting a long one overflow the paper. */
function lengthClass(text: string): string {
  if (text.length > 28) return 'paper-slip-text-xlong';
  if (text.length > 14) return 'paper-slip-text-long';
  return '';
}

/**
 * A slip of paper folded down the vertical centre, opening the way the real
 * thing does.
 *
 * This is a hinge, not a stretch. It used to scale the whole slip from
 * scaleX(0.5) to scaleX(1), which reads as paper being pulled wider — the
 * writing grew along with it. Real folded paper doesn't change size: one half is
 * flipped back onto the other, and opening it swings that half around the
 * crease.
 *
 * So the slip is two clipped halves of the *same* full-width face. You hold the
 * left half; the right one is the flap, swinging rotateY(180°) → 0° about the
 * crease at its left edge. Hinging the other half instead puts the folded slip
 * on the right and opens it leftward, which reads as the animation running
 * backwards.
 *
 * While it's shut you see only the flap's back — a shade darker than the front,
 * or a flap folded onto identical paper just merges into it and there's no fold
 * to see. The held half's writing is on the *inside*, so it fades in as the flap
 * clears rather than showing through the torn edges and the mid-swing gap.
 *
 * Each half is 50% wide and clips; the face inside is 200% wide (the whole
 * slip). Both faces pin to the same edge and the right one shifts by exactly one
 * half, so the two text centres land on the crease and the phrase reads
 * continuously across it. (Pinning one face left and the other right looks
 * symmetric but over-constrains `width: 200%` — whichever edge wins silently
 * decides which side of the phrase you see, which is how "Star Wars" once
 * rendered as "Wars | Star".)
 *
 * The slip itself is a *flat* stacking context with the perspective on it; only
 * each half declares preserve-3d, for its own front/back faces. Making the slip
 * preserve-3d instead depth-sorts the two halves, which makes z-index inert and
 * leaves the flap fighting the half it lands on — coplanar at the end of the
 * swing, so it flickers and settles underneath. Flat, they paint in DOM order
 * and the flap, being the later sibling, is simply always on top.
 *
 * Slips are handled, not rewritten. Each is drawn up out of the box below, and
 * leaves according to what happened to it: a guessed one is lifted away still
 * open (nobody refolds one they just won), a passed one is folded shut and
 * dropped back in, because it will come round again. Re-folding everything in
 * place made one slip look like it was magically re-inking itself.
 *
 * The crumple texture is a static SVG bump-map used as a background-image (see
 * .paper-surface in index.css), not a live CSS `filter:` — an SVG referenced
 * that way is rasterized once at decode time, so animating the element above it
 * is as cheap as moving any other image layer. A live filter would recompute
 * every frame, which is what janked mobile GPUs before.
 */
export default function PaperSlip({ text, slipKey, flash }: PaperSlipProps) {
  const reduceMotion = useReducedMotion();
  const sizeClass = lengthClass(text);
  // The exiting slip keeps the props it last rendered with, so the flash set
  // just before it was replaced tells us how it left. No flash means the turn
  // ran out — an unguessed slip goes back in the bag, same as a pass.
  const wasGuessed = flash?.kind === 'correct';

  const ink = (
    // nested + separately keyed so the colour pulse (a plain CSS @keyframes,
    // guaranteed to play via key-remount regardless of React's batching)
    // doesn't disturb the fold
    <span
      key={flash ? `flash-${flash.id}` : 'plain'}
      className={flash ? `paper-word-flash paper-word-flash-${flash.kind}` : undefined}
    >
      {text}
    </span>
  );

  /**
   * The same full-width face in both halves; each clips to its own side.
   *
   * The ink is plain — no fade. Opening the paper is already the reveal: the
   * flap's back hides the writing while shut, and you read more of the phrase
   * the further it swings, exactly as you would unfolding it by hand. Fading
   * the text in on top of that was doing the same job twice, and made the
   * halves resolve on a schedule of their own rather than with the fold.
   */
  const face = (
    <div className="slip-face paper-surface">
      <span className={`paper-slip-text ${sizeClass}`}>{ink}</span>
    </div>
  );

  return (
    <div className="paper-slip-stage">
      <AnimatePresence mode="wait">
        <motion.div
          key={slipKey}
          className="slip"
          // Three named states, not two. The old slip is *put down* and a new
          // one is *picked up*: it leaves to the left and the next arrives from
          // the right, so a guess reads as changing paper rather than as one
          // magic slip rewriting itself. That needs enter and exit to differ,
          // which a single "folded" variant used for both cannot express.
          initial="enter"
          animate="open"
          exit="exit"
          variants={
            reduceMotion
              ? { enter: { opacity: 0 }, open: { opacity: 1 }, exit: { opacity: 0 } }
              : {
                  enter: { y: '140%', opacity: 0 }, // drawn from the box below
                  // rises and stops; the unfold waits for it (see the flap)
                  open: { y: 0, opacity: 1, transition: { duration: RISE, ease: 'easeOut' } },
                  exit: wasGuessed
                    ? // won: straight up and out, still open, nothing to wait for
                      { y: '-140%', opacity: 0, transition: { duration: LEAVE, ease: 'easeIn' } }
                    : // passed: back down into the box, but only once it's shut
                      { y: '140%', opacity: 0, transition: { duration: LEAVE, delay: FOLD_SHUT, ease: 'easeIn' } },
                }
          }
        >
          {/* The half you're holding — never moves. DOM order is layout order
              (.slip is a flex row), so the left half must come first or the two
              sides of the phrase render swapped. */}
          <div className="slip-half slip-half-left">
            <div className="slip-clip">{face}</div>
          </div>

          {/* The flap: folded back over the left half, opening to the right.
              It's the right half that moves, hinged on the crease at its left
              edge — fold the other one and the slip appears on the right and
              opens leftward, which reads as running backwards. */}
          <motion.div
            className="slip-half slip-half-right"
            variants={
              reduceMotion
                ? { enter: { opacity: 0 }, open: { opacity: 1 }, exit: { opacity: 0 } }
                : {
                    enter: { rotateY: 180 },
                    // held shut until the slip has actually risen into place
                    open: { rotateY: 0, transition: { duration: UNFOLD, delay: RISE, ease: 'easeOut' } },
                    exit: wasGuessed
                      ? { rotateY: 0 } // stays open — you don't refold one you got
                      : { rotateY: 180, transition: { duration: FOLD_SHUT, ease: 'easeInOut' } },
                  }
            }
          >
            {/* the right half of the phrase, hidden until the flap turns past
                edge-on — you can't read the inside of a folded slip */}
            <div className="slip-clip slip-clip-front">{face}</div>
            {/* blank outside of the fold: what a slip looks like in the box */}
            <div className="slip-clip slip-clip-back">
              <div className="slip-face paper-surface paper-surface-blank" />
            </div>
          </motion.div>

          {/* the crease never fully disappears on real paper */}
          <motion.div
            className="paper-slip-crease"
            variants={{ enter: { opacity: 0 }, open: { opacity: 1 }, exit: { opacity: 0 } }}
            transition={{ duration: UNFOLD * 0.5, delay: RISE + UNFOLD * 0.5 }}
          />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
