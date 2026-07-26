import { motion, useReducedMotion } from 'framer-motion';

/** Row pitch on the writing screen: .write-slip's min-height plus .screen's gap.
 *  Used to work out how far each slip has to fall to reach the box, so they
 *  land in it rather than stopping short or sailing past. */
const ROW_PITCH_PX = 68;
const GAP_TO_BOX_PX = 28;

const BOX_IN_MS = 300; // the box arrives first, so there's something to aim at
const PER_SLIP_MS = 150; // stagger, top slip first
const FOLD_MS = 450;
const DROP_MS = 520;

/** How long the whole thing takes, so the caller knows when to move on. */
export function foldAwayDurationMs(count: number) {
  return BOX_IN_MS + Math.max(0, count - 1) * PER_SLIP_MS + FOLD_MS + DROP_MS;
}

/**
 * One written slip folding shut and dropping into the box, animated *in place*
 * on the writing screen.
 *
 * It deliberately keeps the exact footprint of the input it replaces
 * (`.write-slip` inside the same `.word-row`). Playing this on a screen of its
 * own — which is what it used to do — re-laid everything out the moment it
 * started: the slips jumped to a different size and slid down the page before
 * any folding happened, which read as a glitch rather than as paper moving.
 */
export function FoldingSlip({ text, index, total }: { text: string; index: number; total: number }) {
  const reduceMotion = useReducedMotion();
  const delay = (BOX_IN_MS + index * PER_SLIP_MS) / 1000;
  // far enough to reach the box: past every row still below it, plus the gap
  const drop = (total - index) * ROW_PITCH_PX + GAP_TO_BOX_PX;

  const face = (hideAsItCloses: boolean) => (
    <div className="slip-face paper-surface">
      {hideAsItCloses ? (
        // the held half's writing is inside the fold, so it has to be gone by
        // the time the flap lands on it
        <motion.span
          className="foldaway-text"
          initial={{ opacity: 1 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: FOLD_MS / 2000, delay, ease: 'linear' }}
        >
          {text}
        </motion.span>
      ) : (
        <span className="foldaway-text">{text}</span>
      )}
    </div>
  );

  if (reduceMotion) {
    return (
      <div className="write-slip">
        <div className="paper-surface write-slip-paper" />
        <span className="write-slip-static">{text}</span>
      </div>
    );
  }

  return (
    // outer element only falls — the fold happens on the half inside, so the
    // two motions can't be mistaken for the slip shrinking
    <motion.div
      className="write-slip"
      initial={{ x: 0, y: 0, scale: 1, opacity: 1 }}
      // x as well as y: folding collapses the slip onto the *left* half of its
      // row, so its centre sits a quarter-width left of the box. Dropping
      // straight down from there misses — it lands beside the box, not in it.
      animate={{ x: [0, 0, '25%'], y: [0, 0, drop], scale: [1, 1, 0.62], opacity: [1, 1, 1, 0] }}
      transition={{
        duration: (FOLD_MS + DROP_MS) / 1000,
        // hold still while folding, then fall; only vanish in the last moment,
        // as it passes the rim — fading it out early looks like it evaporated
        // rather than went in
        times: [0, FOLD_MS / (FOLD_MS + DROP_MS), 1],
        opacity: { times: [0, 0.75, 0.92, 1], duration: (FOLD_MS + DROP_MS) / 1000, delay },
        delay,
        ease: 'easeIn',
      }}
    >
      {/* left half first: .slip is a flex row, so DOM order decides which side
          of the phrase lands where. The right half is the flap, closing onto
          the left — the reveal's hinge in reverse. */}
      <div className="slip slip-compact">
        <div className="slip-half slip-half-left">
          <div className="slip-clip">{face(true)}</div>
        </div>
        <motion.div
          className="slip-half slip-half-right"
          initial={{ rotateY: 0 }}
          animate={{ rotateY: 180 }}
          transition={{ duration: FOLD_MS / 1000, delay, ease: 'easeInOut' }}
        >
          <div className="slip-clip slip-clip-front">{face(false)}</div>
          <div className="slip-clip slip-clip-back">
            <div className="slip-face paper-surface paper-surface-blank" />
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

/** The box they go into. Arrives first and stays put — the slips move, not it.
 *
 *  Plainly centred, which only works because the dice buttons are unmounted for
 *  the duration: while they were still there the rows were narrower than the
 *  screen and the slips fell past the box's edge. */
export function SlipBox() {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className="foldaway-box"
      aria-hidden="true"
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: BOX_IN_MS / 1000, ease: 'easeOut' }}
    >
      <span className="foldaway-box-lip" />
      <span className="foldaway-box-label">in the box</span>
    </motion.div>
  );
}
