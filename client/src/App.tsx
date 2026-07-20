import type { ReactNode } from 'react';
import { useGame } from './GameContext';
import Landing from './screens/Landing';
import Lobby from './screens/Lobby';
import Writing from './screens/Writing';
import Turn from './screens/Turn';
import Scores from './screens/Scores';

export default function App() {
  const { state, identity } = useGame();

  let screen: ReactNode;
  if (!identity || !state) {
    screen = <Landing />;
  } else {
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
        screen = <Turn />;
        break;
      case 'SCORES':
        screen = <Scores />;
        break;
      default:
        screen = <Landing />;
    }
  }

  return <div className="app-shell">{screen}</div>;
}
