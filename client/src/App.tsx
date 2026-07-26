import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useGame } from './GameContext';
import Landing from './screens/Landing';
import Lobby from './screens/Lobby';
import Writing from './screens/Writing';
import Turn from './screens/Turn';
import Scores from './screens/Scores';
import RoundIntermission from './screens/RoundIntermission';
import MyNameBadge from './components/MyNameBadge';
import Toast from './components/Toast';
import SoundToggle from './components/SoundToggle';
import GameSounds from './components/GameSounds';

export default function App() {
  const { state, identity } = useGame();

  let screen: ReactNode;
  let screenKey: string;
  if (!identity || !state) {
    screen = <Landing />;
    screenKey = 'landing';
  } else {
    screenKey = state.phase;
    switch (state.phase) {
      case 'LOBBY':
        screen = <Lobby />;
        break;
      case 'WRITING':
        screen = <Writing />;
        break;
      case 'ROUND1':
      case 'ROUND2':
      case 'ROUND3':
        // a real screen swap, not an overlay: while the gate is shut there is
        // no turn to interact with, so Turn must not be mounted at all
        screen = state.round.awaitingReady ? <RoundIntermission /> : <Turn />;
        if (state.round.awaitingReady) screenKey = `${state.phase}-ready`;
        break;
      case 'SCORES':
        screen = <Scores />;
        break;
      default:
        screen = <Landing />;
        screenKey = 'landing';
    }
  }

  return (
    <div className="app-shell">
      <Toast />
      <GameSounds />
      {/* outside AnimatePresence on purpose: shell chrome shouldn't slide out
          and back in on every phase change */}
      <div className="shell-chrome">
        <MyNameBadge />
        <SoundToggle />
      </div>
      {/* Sequential slide, not an overlapping crossfade: screens vary wildly in
          height (Landing vs a long scrollable Scores list), so the old screen
          fully exits left before the new one enters from the right — a clean
          "next step" beat rather than two mismatched-height screens overlapping. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={screenKey}
          className="screen-transition"
          initial={{ x: 48, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -48, opacity: 0 }}
          transition={{ duration: 0.26, ease: 'easeInOut' }}
        >
          {screen}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
