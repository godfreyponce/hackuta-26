// React wrapper so A can mount the lab at a dev route:
//   import { MotionLab } from '@ithaca/motion/lab';
//   <Route path="/motion-lab" element={<MotionLab />} />
import { useEffect, useRef } from 'react';
import { mountMotionLab, type MotionLabOptions } from './mountMotionLab';

export function MotionLab(props: MotionLabOptions) {
  const ref = useRef<HTMLDivElement>(null);
  const { modelBaseUrl } = props;
  useEffect(() => {
    if (!ref.current) return;
    return mountMotionLab(ref.current, { modelBaseUrl });
  }, [modelBaseUrl]);
  return <div ref={ref} />;
}
