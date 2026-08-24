import { useHashRoute } from './components.js';
import { Home } from './screens/Home.js';
import { Buddies } from './screens/Buddies.js';
import { Game } from './screens/Game.js';
import { Result } from './screens/Result.js';
import { Replay } from './screens/Replay.js';
import { Lab } from './screens/Lab.js';
import { Settings } from './screens/Settings.js';

export function App() {
  const route = useHashRoute();
  const parts = route.split('/').filter(Boolean);

  if (parts[0] === 'buddies') return <Buddies />;
  if (parts[0] === 'settings') return <Settings />;
  if (parts[0] === 'match' && parts[1]) {
    const id = parts[1];
    if (parts[2] === 'result') return <Result matchId={id} />;
    if (parts[2] === 'replay') return <Replay matchId={id} />;
    if (parts[2] === 'lab') return <Lab matchId={id} />;
    return <Game matchId={id} />;
  }
  return <Home />;
}
