import { VideoBufferType, VideoFrame, VideoSource, VideoStream, type RemoteTrack } from '@livekit/rtc-node';
import sharp from 'sharp';
import { errText, log, warn } from './log.ts';

export const OUT_W = 640;
export const OUT_H = 360;
const CARD_FPS = 15;
const LIVE_STALE_MS = 1_000; // show the card again if friend-view stops this long

async function titleCard(title: string, subtitle: string): Promise<VideoFrame> {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${OUT_H}">
    <rect width="100%" height="100%" fill="#140d07"/>
    <text x="50%" y="40%" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="#c9a24a">THE QUARTERMASTER</text>
    <text x="50%" y="58%" text-anchor="middle" font-family="Georgia, serif" font-size="40" font-weight="bold" fill="#f3e6c4">${esc(title)}</text>
    <text x="50%" y="74%" text-anchor="middle" font-family="Georgia, serif" font-size="24" fill="#a89878">${esc(subtitle)}</text>
  </svg>`;
  const raw = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
  return new VideoFrame(new Uint8Array(raw), OUT_W, OUT_H, VideoBufferType.RGBA);
}

/** Feeds agent-video: a title card until friend-view frames arrive, then passes them through. */
export class VideoRelay {
  readonly source = new VideoSource(OUT_W, OUT_H);
  private card: VideoFrame | null = null;
  private lastLive = 0;
  private timer: NodeJS.Timeout | null = null;
  private stream: VideoStream | null = null;
  liveFrames = 0;

  async start(friendName: string): Promise<void> {
    this.card = await titleCard(`Calling ${friendName}…`, 'Odysseus is home. The hall is full of suitors.');
    this.timer = setInterval(() => {
      if (this.card && Date.now() - this.lastLive > LIVE_STALE_MS) this.source.captureFrame(this.card);
    }, 1000 / CARD_FPS);
  }

  attachFriendView(track: RemoteTrack): void {
    void this.stream?.cancel().catch(() => {});
    const stream = new VideoStream(track);
    this.stream = stream;
    log('friend_view_attached');
    void (async () => {
      try {
        for await (const { frame } of stream) {
          this.lastLive = Date.now();
          this.liveFrames++;
          this.source.captureFrame(frame);
        }
      } catch (e) {
        warn('friend_view_ended', { error: errText(e) });
      }
    })();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    void this.stream?.cancel().catch(() => {});
    await this.source.close();
  }
}

/** Crops an RGBA frame to normalized [x0,y0,x1,y1], with even width and height. */
export function cropRgba(f: VideoFrame, crop: [number, number, number, number]): VideoFrame {
  const rgba = f.type === VideoBufferType.RGBA ? f : f.convert(VideoBufferType.RGBA);
  const x0 = Math.floor((crop[0] * rgba.width) / 2) * 2;
  const y0 = Math.floor((crop[1] * rgba.height) / 2) * 2;
  const w = Math.max(2, Math.floor(((crop[2] - crop[0]) * rgba.width) / 2) * 2);
  const h = Math.max(2, Math.floor(((crop[3] - crop[1]) * rgba.height) / 2) * 2);
  const out = new Uint8Array(w * h * 4);
  const srcStride = rgba.width * 4;
  for (let y = 0; y < h; y++) {
    const s = (y0 + y) * srcStride + x0 * 4;
    out.set(rgba.data.subarray(s, s + w * 4), y * w * 4);
  }
  return new VideoFrame(out, w, h, VideoBufferType.RGBA);
}
