// Caller scanning -> forge (spec B.7).
import { mkdir, writeFile } from 'node:fs/promises';
import { VideoBufferType, type VideoFrame } from '@livekit/rtc-node';
import sharp from 'sharp';
import { env } from './env.ts';
import { errText, log, warn } from './log.ts';
import { cropRgba } from './video.ts';

const TICK_MS = 700;
const WINDOW_MS = 10_000;
// Above the server's worst case, vision 8.5 s plus one 8.5 s retry (apps/server/src/ai/vision.ts analyzeWithRetry):
// if we give up first, the server still forges a weapon we never announce. The 3 s for upload and parsing is a guess.
const FORGE_TIMEOUT_MS = 2 * 8_500 + 3_000;
const MIN_CHANGE = 0.02;
const CAPTURES = 3;

export type Detected = { forgeId: string; objectName: string; displayName: string; weaponClass: string; quip: string };

/** Spec D.3 replies 202 {forgeId, ...} and may leave out `detected`, so a 202 with a forgeId is a hit. */
export function parseForgeReply(status: number, raw: unknown): Detected | null {
  const body = (raw ?? {}) as Partial<Detected>;
  if (status !== 202 || !body.forgeId) return null;
  return {
    forgeId: body.forgeId, objectName: body.objectName ?? 'something',
    displayName: body.displayName ?? body.objectName ?? 'a weapon',
    weaponClass: body.weaponClass ?? 'blunt', quip: body.quip ?? 'Forging now.',
  };
}

export class CallerScanner {
  private latest: VideoFrame | null = null;
  private prevThumb: Buffer | null = null;
  // After no_object, send one unchanged picture again: Gemini missed a clearly held mug in 5 of 23 call 3 frames, at
  // random. Only once, so frozen video or an empty hand does not cost a forge call every tick.
  private retrySame = false;
  private sentSame = false;
  private saved = 0;
  private active = false;

  constructor(private sessionId: string) {}

  /** Called for every caller frame; keeps only the newest. */
  offer(frame: VideoFrame): void {
    this.latest = frame;
    if (this.saved === 0) void this.saveCapture(frame);
  }

  get scanning(): boolean { return this.active; }

  /**
   * Samples frames until the forge detects an object or 10 s pass. Returns null on timeout or cancel.
   * No new forge starts after 10 s, but one in flight runs to its reply (up to FORGE_TIMEOUT_MS), so a scan can last about 30 s.
   */
  async scan(onTick?: (elapsedMs: number) => void): Promise<Detected | null> {
    if (this.active) return null;
    this.active = true;
    this.prevThumb = null;
    this.retrySame = false;
    const t0 = Date.now();
    try {
      while (this.active && Date.now() - t0 < WINDOW_MS) {
        const tickStart = Date.now();
        onTick?.(tickStart - t0);
        const frame = this.latest;
        if (frame) {
          const jpeg = await this.prepare(frame);
          if (jpeg) {
            const { hit, reason } = await this.forge(jpeg);
            if (hit) return hit;
            this.retrySame = reason === 'no_object' && !this.sentSame;
          }
        }
        await new Promise((r) => setTimeout(r, Math.max(0, TICK_MS - (Date.now() - tickStart))));
      }
      return null;
    } finally {
      this.active = false;
    }
  }

  cancel(): void { this.active = false; }

  private async prepare(frame: VideoFrame): Promise<Buffer | null> {
    const c = cropRgba(frame, env.callerCrop);
    const img = () => sharp(Buffer.from(c.data), { raw: { width: c.width, height: c.height, channels: 4 } });
    const thumb = await img().resize(64, 64, { fit: 'fill' }).greyscale().raw().toBuffer();
    this.sentSame = false;
    if (this.prevThumb) {
      let diff = 0;
      for (let i = 0; i < thumb.length; i++) diff += Math.abs(thumb[i]! - this.prevThumb[i]!);
      if (diff / (thumb.length * 255) < MIN_CHANGE) { // same picture as last time
        if (!this.retrySame) return null;
        this.sentSame = true;
      }
    }
    this.prevThumb = thumb;
    // Blur check (Laplacian variance) left out: no threshold measured yet.
    return img().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  }

  private async forge(jpeg: Buffer): Promise<{ hit: Detected | null; reason?: string }> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'frame.jpg');
    form.append('sessionId', this.sessionId);
    form.append('source', 'facetime');
    const t0 = Date.now();
    try {
      const res = await fetch(`${env.SERVER_HTTP_URL}/api/forge`, { method: 'POST', body: form, headers: { 'x-session-id': this.sessionId }, signal: AbortSignal.timeout(FORGE_TIMEOUT_MS) });
      const body: unknown = await res.json().catch(() => ({}));
      const hit = parseForgeReply(res.status, body);
      const reason = (body as { reason?: string }).reason;
      log('forge_reply', { status: res.status, detected: !!hit, reason, ms: Date.now() - t0 });
      return { hit, reason };
    } catch (e) {
      warn('forge_failed', { error: errText(e), ms: Date.now() - t0 });
    }
    return { hit: null };
  }

  /** Saves a few raw caller frames to dev/captures (gitignored) to tune CALLER_CROP. */
  private async saveCapture(frame: VideoFrame): Promise<void> {
    this.saved++;
    const n = this.saved;
    try {
      const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
      const dir = new URL('../dev/captures/', import.meta.url);
      await mkdir(dir, { recursive: true });
      const jpg = await sharp(Buffer.from(rgba.data), { raw: { width: rgba.width, height: rgba.height, channels: 4 } }).jpeg().toBuffer();
      await writeFile(new URL(`caller-${Date.now()}-${n}.jpg`, dir), jpg);
      log('caller_capture_saved', { n, width: rgba.width, height: rgba.height });
    } catch (e) {
      warn('caller_capture_failed', { error: errText(e) });
    }
    if (n < CAPTURES) setTimeout(() => { if (this.latest) void this.saveCapture(this.latest); }, 2_000);
  }
}
