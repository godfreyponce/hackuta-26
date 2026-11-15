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
 * Owner pick, caption style 5 (big short chunks): one short phrase at a time in 40 px heavy black sans on an off-white
 * pill, one key word in blue, the pill's bottom 14 px above the game's bottom. Sizes and colors are the owner's mockup.
 * A portrait iPhone shows the 640 px frame at about 0.61x, so 40 px is about 24 pt.
 */
const CAPTION_SIZE = 40;
const CAPTION_FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const INK = '#111', KEY_BLUE = '#2f6bff';
const PILL_H = 64, PILL_PAD_X = 28, PILL_GAP = 14;
const PILL_MAX_W = AGENT_W - 2 * 24;
/** Guess: the mockup's heavy sans runs about 0.48 em per character; 0.6 leaves room for wide words. */
const EM_PER_CHAR = 0.6;
export const CHUNK_MAX_CHARS = Math.floor((PILL_MAX_W - 2 * PILL_PAD_X) / (CAPTION_SIZE * EM_PER_CHAR));
/** First row of the bottom letterbox bar: friend-view is OUT_W x OUT_H (640x360 by contract, callMedia.ts), centered. */
export const GAME_BOTTOM = (AGENT_H + OUT_H) / 2;
/** For a streamed line, whose length is unknown. Measured: the 22 cached ElevenLabs lines run 11 to 19 characters per second, 16.1 over all. */
export const SPEECH_CHARS_PER_S = 16;
/**
 * Guess: how long a caption stays after mixer.play resolves. The mixer's AudioSource still holds up to 100 ms, the
 * phone's jitter buffer more, and the friend needs a moment to finish reading.
 */
export const CAPTION_LINGER_MS = 700;
/** Guess: a chunk like "I," gets about 125 ms of audio, too short to read; it stays this long, and later chunks catch up. */
export const CHUNK_MIN_MS = 300;

/**
 * A variation selector (U+FE0F, as in a vision-model quip's "⚔️") makes Pango abort the whole agent (exit 133, "Could
 * not load fallback font"), and other emoji draw as black blobs, so captions drop both. © ® ™ stay: the font draws them.
 * Control characters are dropped too: they are invalid in the SVG, so the whole chunk would fail to render.
 */
const NOT_DRAWN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFE00-\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}\u{E0100}-\u{E01EF}\p{Emoji_Modifier}\p{Regional_Indicator}]|(?![©®™])\p{Extended_Pictographic}/gu;
const drawable = (text: string) => text.replace(NOT_DRAWN, '').replace(/\s+/g, ' ').trim();

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    for (; word.length > maxChars; word = word.slice(maxChars)) { if (line) lines.push(line); line = ''; lines.push(word.slice(0, maxChars)); }
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/** The fewest chunks that fit, made as even as possible, so a phrase does not end on one stray word. */
function evenWrap(phrase: string): string[] {
  const fewest = wrap(phrase, CHUNK_MAX_CHARS);
  const longest = Math.max(...phrase.split(' ').map((word) => word.length));
  for (let w = Math.max(Math.ceil(phrase.length / fewest.length), longest); w < CHUNK_MAX_CHARS; w++) {
    const lines = wrap(phrase, w);
    if (lines.length === fewest.length) return lines;
  }
  return fewest;
}

/** A line cut into one-line chunks, shown one after another: a chunk ends at every phrase break (. , ! ? ; :). */
export function captionChunks(text: string): string[] {
  const phrases: string[] = [];
  let phrase: string[] = [];
  for (const word of drawable(text).split(' ').filter(Boolean)) {
    phrase.push(word);
    if (/[.,!?;:]$/.test(word)) { phrases.push(phrase.join(' ')); phrase = []; }
  }
  if (phrase.length) phrases.push(phrase.join(' '));
  return phrases.flatMap(evenWrap);
}

/**
 * When each chunk shows: at its character share of the audio, but never sooner than CHUNK_MIN_MS after the one before,
 * and never after the line's audio ends (endCaption's clear would cancel it unseen).
 */
export function chunkStarts(chunks: string[], msPerChar: number): number[] {
  const end = chunks.reduce((n, c) => n + c.length, 0) * msPerChar;
  const starts: number[] = [];
  let audio = 0;
  for (const chunk of chunks) {
    starts.push(starts.length ? Math.min(end, Math.max(audio, starts.at(-1)! + CHUNK_MIN_MS)) : 0);
    audio += chunk.length * msPerChar;
  }
  return starts;
}

/** Small words, and the verbs, adjectives and adverbs of LINES, that are never the key word. */
const NOT_KEY = new Set(`show hold thank couldn't last nice steady badly moving cleared closing pinned cornered explodes catch fill
  find watch breathe hurry come long bleeding sharp the and but for nor yet you your yours him his her hers its
  it's they them their our ours she we us me my mine i'll i'm i've you've you're he's she's they've they're
  that's there's what who this that these those there here with from into onto over under about than then when
  how why all any some was were are been have has had did does can can't could would will won't don't just now
  too very much more still not off out ha hah quick again see let get got take tell need ask keep make done`.split(/\s+/));

function keyIndex(words: string[]): number {
  for (let i = words.length - 1; i >= 0; i--) {
    const bare = words[i]!.toLowerCase().replace(/[^a-z']/g, '');
    if (bare.length >= 3 && !NOT_KEY.has(bare)) return i;
  }
  return -1;
}

/**
 * The chunk's word drawn in blue. The owner asked for the last noun; without a tagger this is the last word of 3 or
 * more letters that is not in NOT_KEY, so a verb or adjective outside NOT_KEY can still win.
 */
export function keyWord(chunk: string): string | undefined {
  const words = chunk.split(' ');
  return words[keyIndex(words)];
}

/**
 * Text is measured at half size, so wide text (22 W's at 40 px is over 640 px) is not clipped to the frame before
 * trim. A 4x wider canvas instead made the first chunk about 45 ms later (measured).
 */
const MEASURE_SCALE = 2;

/** pillW 0 draws the text alone, for measuring. */
function captionSvg(chunk: string, size: number, pillW: number): string {
  const words = chunk.split(' '), key = keyIndex(words);
  const spans = words.map((w, i) => `<tspan fill="${i === key ? KEY_BLUE : INK}">${esc(w)}${i < words.length - 1 ? ' ' : ''}</tspan>`).join('');
  const pill = pillW ? `<rect x="${(AGENT_W - pillW) / 2}" y="1" width="${pillW}" height="${PILL_H}" rx="${PILL_H / 2}" fill="#fbfcff" stroke="#dfe4ee"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${AGENT_W}" height="${PILL_H + 2}">${pill}
    <text xml:space="preserve" x="${AGENT_W / 2}" y="${1 + PILL_H / 2 + Math.round(size * 0.35)}" text-anchor="middle" font-family="${CAPTION_FONT}" font-weight="800" font-size="${size}" letter-spacing="-0.4">${spans}</text>
  </svg>`;
}

/**
 * One chunk as a pill near the bottom of the game, above the letterbox bar. The text is measured first so the pill
 * fits it; a chunk too wide for the pill (one long word) gets a smaller font instead of running past it.
 */
export async function renderCaption(chunk: string): Promise<Caption> {
  chunk = drawable(chunk);
  const { info } = await sharp(Buffer.from(captionSvg(chunk, CAPTION_SIZE / MEASURE_SCALE, 0))).trim().toBuffer({ resolveWithObject: true });
  const textW = info.width * MEASURE_SCALE, room = PILL_MAX_W - 2 * PILL_PAD_X;
  const size = textW > room ? Math.floor((CAPTION_SIZE * room) / textW) : CAPTION_SIZE;
  const pillW = Math.round((textW * size) / CAPTION_SIZE) + 2 * PILL_PAD_X;
  const data = new Uint8Array(await sharp(Buffer.from(captionSvg(chunk, size, pillW))).ensureAlpha().raw().toBuffer());
  return { data, top: GAME_BOTTOM - PILL_GAP - PILL_H - 1, height: PILL_H + 2 };
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
   * Shows a line as captions: its chunks in turn, each for its character share of the line's audio (durationMs for a
   * cached line, else SPEECH_CHARS_PER_S). The last chunk stays until endCaption or the next line.
   */
  showCaption(text: string, durationMs?: number): void {
    const chunks = captionChunks(text);
    const msPerChar = durationMs ? durationMs / chunks.reduce((n, c) => n + c.length, 0) : 1000 / SPEECH_CHARS_PER_S;
    this.clearCaption();
    const gen = this.captionGen;
    const starts = chunkStarts(chunks, msPerChar);
    let prev: Promise<unknown> = Promise.resolve();
    for (const [i, chunk] of chunks.entries()) {
      // In order, one at a time: started together, the first chunk waited about 120 ms behind the rest (measured).
      const rendered = prev.catch(() => {}).then(() => renderCaption(chunk));
      prev = rendered;
      const show = () => void rendered.then(
        (c) => { if (gen === this.captionGen) this.caption = c; },
        (e) => { if (gen === this.captionGen) this.caption = null; warn('caption_render_failed', { error: errText(e) }); },
      );
      if (i === 0) show(); else this.captionTimers.push(setTimeout(show, starts[i]));
    }
  }

  /** The line's audio ended: clear its caption CAPTION_LINGER_MS later, unless a newer line has replaced it. */
  endCaption(): void {
    this.captionTimers.push(setTimeout(() => this.clearCaption(), CAPTION_LINGER_MS));
  }

  private clearCaption(): void {
    this.captionGen++; // a chunk still rendering must not come back
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
