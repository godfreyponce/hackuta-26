import { VideoBufferType, VideoFrame, VideoSource, VideoStream, type RemoteTrack } from '@livekit/rtc-node';
import sharp from 'sharp';
import { errText, log, warn } from './log.ts';

export const OUT_W = 640;
export const OUT_H = 360;
/**
 * agent-video size. Call 3: FaceTime showed our 640x360 frame cut to about 3:2 (source x 51..588 on the iPhone and in
 * the Mac self-view), so we send 3:2 and letterbox the game inside it. 640 wide keeps the usual friend-view unscaled;
 * 428 is 640/1.5 rounded up to a multiple of 4 (libwebrtc rounds sizes down to multiples of 4).
 */
export const AGENT_W = 640;
export const AGENT_H = 428;
const CARD_FPS = 15;
const LIVE_STALE_MS = 1_000; // show the card again if friend-view stops this long

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

async function titleCard(title: string, subtitle: string): Promise<VideoFrame> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${AGENT_W}" height="${AGENT_H}">
    <rect width="100%" height="100%" fill="#140d07"/>
    <text x="50%" y="40%" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="#c9a24a">THE QUARTERMASTER</text>
    <text x="50%" y="58%" text-anchor="middle" font-family="Georgia, serif" font-size="40" font-weight="bold" fill="#f3e6c4">${esc(title)}</text>
    <text x="50%" y="74%" text-anchor="middle" font-family="Georgia, serif" font-size="24" fill="#a89878">${esc(subtitle)}</text>
  </svg>`;
  const raw = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
  return new VideoFrame(new Uint8Array(raw), AGENT_W, AGENT_H, VideoBufferType.RGBA);
}

/** RGBA rows [top, top + height) of agent-video, drawn over the frame; alpha is per pixel. */
export type Caption = { data: Uint8Array; top: number; height: number };

/**
 * 28 px: a portrait iPhone (390 pt wide) shows the 640 px frame at about 0.61x, so 28 px is about 17 pt, the iOS body
 * text size. Guess: that FaceTime shows our frame full width in portrait; the next live call confirms it.
 */
const CAPTION_SIZE = 28;
const CAPTION_MAX_LINES = 2;
const CAPTION_INSET = 32; // text inset from each side
/** Georgia bold measured in sharp at 0.47 to 0.555 em per character over LINES; 0.6 leaves room for wider words. */
const EM_PER_CHAR = 0.6;
/** Bottom row of the game inside agent-video: friend-view is OUT_W x OUT_H, letterboxed with equal bars. */
export const GAME_BOTTOM = (AGENT_H + OUT_H) / 2;
/** Measured: the 22 cached ElevenLabs lines run 11 to 19 characters per second, 16.1 over all of them. */
export const SPEECH_CHARS_PER_S = 16;
/** Guess: how long a caption stays after its audio ends, so the friend can finish reading the last words. */
export const CAPTION_LINGER_MS = 700;

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.map((l) => (l.length > maxChars ? `${l.slice(0, maxChars - 1)}…` : l));
}

/** A line wrapped for agent-video and cut into pages of at most CAPTION_MAX_LINES lines, shown one after another. */
export function captionPages(text: string): string[][] {
  const lines = wrap(text, Math.floor((AGENT_W - 2 * CAPTION_INSET) / (CAPTION_SIZE * EM_PER_CHAR)));
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += CAPTION_MAX_LINES) pages.push(lines.slice(i, i + CAPTION_MAX_LINES));
  return pages;
}

/** One caption page as a band at the bottom of the game, above the letterbox bar, so the friend can read it in FaceTime. */
export async function renderCaption(lines: string[]): Promise<Caption> {
  const lineH = Math.round(CAPTION_SIZE * 1.25), pad = 10, height = lines.length * lineH + 2 * pad;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${AGENT_W}" height="${height}">
    <rect x="16" y="0" width="${AGENT_W - 32}" height="${height}" rx="10" fill="#000" fill-opacity="0.72"/>
    ${lines.map((l, i) => `<text x="50%" y="${pad + (i + 1) * lineH - Math.round(CAPTION_SIZE * 0.3)}" text-anchor="middle" font-family="Georgia, serif" font-weight="bold" font-size="${CAPTION_SIZE}" fill="#f3e6c4">${esc(l)}</text>`).join('')}
  </svg>`;
  const data = new Uint8Array(await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer());
  return { data, top: GAME_BOTTOM - height - 8, height };
}

/** Blends the caption into an AGENT_W x AGENT_H RGBA buffer in place. */
export function drawCaption(rgba: Uint8Array, c: Caption): void {
  const base = c.top * AGENT_W * 4;
  for (let i = 0; i < c.data.length; i += 4) {
    const a = c.data[i + 3]!;
    if (!a) continue;
    const o = base + i;
    for (let k = 0; k < 3; k++) rgba[o + k] = (c.data[i + k]! * a + rgba[o + k]! * (255 - a) + 127) / 255;
  }
}

/** Feeds agent-video: a title card until friend-view frames arrive, then those frames letterboxed to 3:2, with captions. */
export class VideoRelay {
  readonly source = new VideoSource(AGENT_W, AGENT_H);
  private card: VideoFrame | null = null;
  private caption: Caption | null = null;
  private captionGen = 0;
  private captionTimers: NodeJS.Timeout[] = [];
  private lastLive = 0;
  private timer: NodeJS.Timeout | null = null;
  private stream: VideoStream | null = null;
  liveFrames = 0;

  async start(friendName: string): Promise<void> {
    this.card = await titleCard(`Calling ${friendName}…`, 'Odysseus is home. The hall is full of suitors.');
    this.timer = setInterval(() => {
      if (this.card && Date.now() - this.lastLive > LIVE_STALE_MS) this.source.captureFrame(this.withCaption(this.card, true));
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
          this.source.captureFrame(this.withCaption(letterbox(frame, AGENT_W, AGENT_H), false));
        }
      } catch (e) {
        warn('friend_view_ended', { error: errText(e) });
      }
    })();
  }

  /**
   * Shows a line as captions: its pages in turn, each for its share of the line at SPEECH_CHARS_PER_S. The last page
   * stays until endCaption or the next line.
   */
  showCaption(text: string): void {
    this.clearCaption();
    const gen = this.captionGen;
    let at = 0;
    for (const lines of captionPages(text)) {
      const page = renderCaption(lines);
      const show = () => void page.then(
        (c) => { if (gen === this.captionGen) this.caption = c; },
        (e) => { if (gen === this.captionGen) this.caption = null; warn('caption_render_failed', { error: errText(e) }); },
      );
      if (at === 0) show(); else this.captionTimers.push(setTimeout(show, at));
      at += (lines.join(' ').length / SPEECH_CHARS_PER_S) * 1000;
    }
  }

  /** The line's audio ended: clear its caption CAPTION_LINGER_MS later, unless a newer line has replaced it. */
  endCaption(): void {
    const gen = this.captionGen;
    this.captionTimers.push(setTimeout(() => { if (gen === this.captionGen) this.clearCaption(); }, CAPTION_LINGER_MS));
  }

  private clearCaption(): void {
    this.captionGen++; // a page still rendering must not come back
    for (const t of this.captionTimers) clearTimeout(t);
    this.captionTimers = [];
    this.caption = null;
  }

  /** copy: the frame is reused (the title card), so draw on a copy instead of in place. */
  private withCaption(f: VideoFrame, copy: boolean): VideoFrame {
    if (!this.caption) return f;
    const data = copy ? new Uint8Array(f.data) : f.data;
    drawCaption(data, this.caption);
    return copy ? new VideoFrame(data, f.width, f.height, VideoBufferType.RGBA) : f;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.clearCaption();
    void this.stream?.cancel().catch(() => {});
    await this.source.close();
  }
}

/**
 * libwebrtc rounds a published frame down to a multiple of 4 px (measured: 14x16 came out 12x16) and aborts the whole
 * process on width 0. WebRTC sends 8x8 frames when a track restarts, and a tight crop makes those 2 px wide.
 * 16 px is a guess with room for the encoder's own downscale steps; nothing that small is worth showing.
 */
const MIN_RELAY_PX = 16;
export const relayable = (f: VideoFrame): boolean => f.width >= MIN_RELAY_PX && f.height >= MIN_RELAY_PX;

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

/** Fits a frame whole inside outW x outH, centered on black (nearest pixel; the edge pixels map to the edges). */
export function letterbox(f: VideoFrame, outW: number, outH: number): VideoFrame {
  const src = f.type === VideoBufferType.RGBA ? f : f.convert(VideoBufferType.RGBA);
  const { width: w, height: h } = src;
  const wide = w * outH >= h * outW;
  const gw = wide ? outW : Math.round((outH * w) / h);
  const gh = wide ? Math.round((outW * h) / w) : outH;
  const left = (outW - gw) >> 1, top = (outH - gh) >> 1;
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < gh; y++) {
    const sy = gh > 1 ? Math.round((y * (h - 1)) / (gh - 1)) : 0;
    const row = sy * w * 4, o = ((top + y) * outW + left) * 4;
    if (gw === w) { out.set(src.data.subarray(row, row + w * 4), o); continue; }
    for (let x = 0; x < gw; x++) {
      const s = row + (gw > 1 ? Math.round((x * (w - 1)) / (gw - 1)) : 0) * 4;
      out[o + x * 4] = src.data[s]!; out[o + x * 4 + 1] = src.data[s + 1]!; out[o + x * 4 + 2] = src.data[s + 2]!; out[o + x * 4 + 3] = 255;
    }
  }
  return new VideoFrame(out, outW, outH, VideoBufferType.RGBA);
}
