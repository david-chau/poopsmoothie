import { useEffect } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/** Must match .write-slip's min-height and .screen's gap: the sheet is exactly
 *  the finished slips stacked with no gaps, so cutting it *is* what opens those
 *  gaps up. Getting these wrong makes the strips jump when the real rows
 *  replace them. */
const ROW_H = 56;
const ROW_GAP = 12;

const SETTLE_MS = 260; // sheet drops onto the table
const CUT_MS = 620; // blade travels top to bottom
const PART_MS = 300; // strips ease apart behind it
const HOLD_MS = 160; // a beat before the form appears

export function paperCutDurationMs() {
  return SETTLE_MS + CUT_MS + PART_MS + HOLD_MS;
}

/**
 * The sheet of paper being cut into slips, which is how a round of this game
 * actually starts at a table.
 *
 * Built as the finished slips already stacked edge to edge — so the "cut" is
 * literally the gaps opening between them, and the strips end up exactly where
 * the writing rows will be. Animating a separate sheet and then swapping in the
 * real inputs would need the two layouts to agree pixel for pixel, and any
 * disagreement reads as a jump at the handover.
 */
export default function PaperCutIntro({ count, onDone }: { count: number; onDone: () => void }) {
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) return onDone();
    const id = setTimeout(onDone, paperCutDurationMs());
    return () => clearTimeout(id);
  }, [reduceMotion, onDone]);

  if (reduceMotion) return null;

  const strips = Array.from({ length: count }, (_, i) => i);
  // spread outward from the middle, so the sheet opens rather than slides down
  const offsetFor = (i: number) => (i - (count - 1) / 2) * ROW_GAP;
  const cutAt = (i: number) => (SETTLE_MS + (CUT_MS * (i + 1)) / (count + 1)) / 1000;

  return (
    <div className="papercut" aria-hidden="true" style={{ height: count * ROW_H + (count - 1) * ROW_GAP }}>
      <motion.div
        className="papercut-sheet"
        style={{ height: count * ROW_H }}
        initial={{ scale: 0.94, opacity: 0, rotate: -1.2 }}
        animate={{ scale: 1, opacity: 1, rotate: 0 }}
        transition={{ duration: SETTLE_MS / 1000, ease: 'easeOut' }}
      >
        {strips.map((i) => (
          <motion.div
            key={i}
            className="papercut-strip paper-surface"
            style={{ top: i * ROW_H, height: ROW_H }}
            initial={{ y: 0 }}
            animate={{ y: offsetFor(i) }}
            transition={{ delay: cutAt(i), duration: PART_MS / 1000, ease: 'easeOut' }}
          />
        ))}

        {/* the blade: a bright line travelling down the sheet, each strip
            parting just as it passes */}
        <motion.div
          className="papercut-blade"
          initial={{ top: 0, opacity: 0 }}
          animate={{ top: count * ROW_H, opacity: [0, 1, 1, 0] }}
          transition={{
            delay: SETTLE_MS / 1000,
            duration: CUT_MS / 1000,
            ease: 'linear',
            opacity: { times: [0, 0.08, 0.9, 1], duration: CUT_MS / 1000, delay: SETTLE_MS / 1000 },
          }}
        />
      </motion.div>
    </div>
  );
}
