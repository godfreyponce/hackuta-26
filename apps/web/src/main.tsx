import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/montserrat';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource/cormorant-garamond/600-italic.css';
import '@fontsource/cinzel/600.css';
import '@fontsource/cinzel/700.css';
import '@fontsource/cinzel/900.css';
import './styles/global.css';
import { App } from './App';
import { bootNet, setupInput } from './game/runtime';
import { useApp } from './state/store';

const params = new URLSearchParams(location.search);
const inputParam = params.get('input');
const kind = (inputParam === 'motion' || inputParam === 'keyboard_mouse' || inputParam === 'replay')
  ? inputParam
  : useApp.getState().inputKind;

void bootNet();
if (import.meta.env.DEV || params.get('debug') === '1') {
  (window as unknown as { __ithaca: () => unknown }).__ithaca = () => {
    const s = useApp.getState();
    return { screen: s.screen, hud: s.hud, call: s.call.state, scan: s.scan.state, toasts: s.toasts.map((t) => t.title), narration: s.narration.map((n) => n.text) };
  };
}
void setupInput(kind);
// dev only: a local play log (errors, fps, tracking, combat) so a teammate can watch a session — see dev/playLog.ts
if (import.meta.env.DEV) void import('./dev/playLog').then((m) => m.startPlayLog());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
