import { AnimatePresence, motion } from 'framer-motion';

interface PaperSlipProps {
  text: string;
  /** changing this re-triggers the unfold — one animation per drawn slip */
  slipKey: string;
  /** brief text-color pulse on Correct/Pass, before the next slip unfolds in */
  flash?: { id: number; kind: 'correct' | 'pass' } | null;
}

// Matches paperFlashPulse's CSS duration (index.css) exactly — the fold used
// to be a spring (variable, decaying speed) while the correct/pass flash was
// a fixed-duration keyframe, so the two never read as the same tempo.
const FOLD_DURATION = 0.5;

/** Slips hold phrases, not just words. CSS can't measure the string, so pick
 *  the size band here rather than letting a long one overflow the paper. */
function lengthClass(text: string): string {
  if (text.length > 28) return 'paper-slip-text-xlong';
  if (text.length > 14) return 'paper-slip-text-long';
  return '';
}

// Paper folded along its vertical center crease: folded width is half the
// unfolded width, and unfolding doubles it back out — like the real slips.
// The crumple texture is a static SVG bump-map baked into .paper-slip-paper's
// background-image (see index.css) rather than a live CSS `filter:` — an SVG
// used as a background-image is rasterized once at decode time, so scaling it
// during the fold is as cheap as any other image layer. A live `filter:` on
// the element itself would instead recompute every single frame, which is
// exactly what made this jank on mobile GPUs before.
export default function PaperSlip({ text, slipKey, flash }: PaperSlipProps) {
  return (
    <div className="paper-slip-stage">
      <AnimatePresence mode="wait">
        <motion.div key={slipKey} className="paper-slip-wrap" initial="folded" animate="open" exit="folded">
          <motion.div
            className="paper-slip-paper"
            variants={{ folded: { scaleX: 0.5 }, open: { scaleX: 1 } }}
            transition={{ duration: FOLD_DURATION, ease: 'easeOut' }}
          />
          <motion.div
            className="paper-slip-crease"
            variants={{ folded: { opacity: 1 }, open: { opacity: 0 } }}
            transition={{ duration: FOLD_DURATION * 0.7, delay: FOLD_DURATION * 0.3 }}
          />
          <motion.span
            className={`paper-slip-text ${lengthClass(text)}`}
            variants={{ folded: { opacity: 0 }, open: { opacity: 1 } }}
            transition={{ duration: FOLD_DURATION * 0.6, delay: FOLD_DURATION * 0.5 }}
          >
            {/* nested + separately keyed so the color pulse (a plain CSS
                @keyframes, guaranteed to play via key-remount regardless of
                React's batching) doesn't disturb the outer fade-in above */}
            <span
              key={flash ? `flash-${flash.id}` : 'plain'}
              className={flash ? `paper-word-flash paper-word-flash-${flash.kind}` : undefined}
            >
              {text}
            </span>
          </motion.span>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
