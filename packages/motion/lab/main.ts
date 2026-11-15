// Standalone Motion Lab dev page (no game needed): pnpm --filter @ithaca/motion lab
import { mountMotionLab } from '../src/lab';

document.documentElement.style.background = '#12100e';
document.body.style.margin = '0';

const root = document.getElementById('lab');
if (root) mountMotionLab(root, { modelBaseUrl: '/models' });
