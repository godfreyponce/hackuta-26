import { useEffect } from 'react';
import { useApp } from './state/store';
import { GameView } from './game/GameView';
import { Title } from './ui/Title';
import { Setup } from './ui/Setup';
import { Calibration } from './ui/Calibration';
import { Lobby } from './ui/Lobby';
import { Hud, Toasts } from './ui/Hud';
import { Results } from './ui/Results';
import { Armory } from './ui/Armory';
import { Leaderboard } from './ui/Leaderboard';
import { DevFriendView, DevMotionLab } from './ui/DevPages';
import { audio } from './game/engine/audio';

const dev = new URLSearchParams(location.search).get('dev');

export function App() {
  const screen = useApp((s) => s.screen);

  useEffect(() => {
    const unlock = () => { audio.unlock(); audio.startAmbience(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);

  if (dev === 'motionlab') return <DevMotionLab />;

  return (
    <>
      <GameView />
      {screen === 'title' && <Title />}
      {screen === 'setup' && <Setup />}
      {screen === 'calibration' && <Calibration />}
      {screen === 'lobby' && <Lobby />}
      {screen === 'game' && <Hud />}
      {screen === 'results' && <Results />}
      {screen === 'armory' && <Armory />}
      {screen === 'leaderboard' && <Leaderboard />}
      {screen !== 'game' && <div className="hud" aria-live="polite"><Toasts /></div>}
      {dev === 'friendview' && <DevFriendView />}
    </>
  );
}
