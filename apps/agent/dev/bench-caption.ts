// Cost per agent-video frame of the caption blend, next to the letterbox it rides on. `npx tsx --env-file=.env.local dev/bench-caption.ts`
import { VideoBufferType, VideoFrame, dispose } from '@livekit/rtc-node';
import { LINES } from '../src/lines.ts';
import { AGENT_H, AGENT_W, OUT_H, OUT_W, captionPages, drawCaption, letterbox, renderCaption } from '../src/video.ts';

const N = 2_000;
const game = new VideoFrame(new Uint8Array(OUT_W * OUT_H * 4).fill(128), OUT_W, OUT_H, VideoBufferType.RGBA);
const caption = await renderCaption(captionPages(LINES.greeting[0])[0]!);
const time = (f: () => void) => { for (let i = 0; i < 200; i++) f(); const t = process.hrtime.bigint(); for (let i = 0; i < N; i++) f(); return Number(process.hrtime.bigint() - t) / N / 1e6; };
const frame = letterbox(game, AGENT_W, AGENT_H);
const blend = time(() => drawCaption(frame.data, caption));
const box = time(() => letterbox(game, AGENT_W, AGENT_H));
console.log(JSON.stringify({ frames: N, captionRows: caption.height, blendMs: +blend.toFixed(3), letterboxMs: +box.toFixed(3), budgetMsAt15fps: +(1000 / 15).toFixed(1) }));
await dispose();
