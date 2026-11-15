// Standalone Motion Lab dev page (no game needed): pnpm --filter @ithaca/motion lab
import { mountMotionLab } from '../src/lab';

const root = document.getElementById('lab');
if (root) mountMotionLab(root, { modelBaseUrl: '/models' });
