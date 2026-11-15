// Caller scanning -> forge (spec B.7).
import { mkdir, writeFile } from 'node:fs/promises';
import { VideoBufferType, type VideoFrame } from '@livekit/rtc-node';
import sharp from 'sharp';
import { env } from './env.ts';
import { errText, log, warn } from './log.ts';
import { cropRgba } from './video.ts';

const TICK_MS = 700;
const WINDOW_MS = 10_000;
const FORGE_TIMEOUT_MS = 6_000;
const MIN_CHANGE = 0.02;
const CAPTURES = 3;

export type Detected = { forgeId: string; objectName: string; displayName: string; weaponClass: string; quip: string };

export class CallerScanner {
  private latest: VideoFrame | null = null;
  private prevThumb: Buffer | null = null;
  private saved = 0;
  private active = false;

  constructor(private sessionId: string) {}

  /** Called for every caller frame; keeps only the newest. */
  offer(frame: VideoFrame): void {
    this.latest = frame;
    if (this.saved === 0) void this.saveCapture(frame);
  }

  get scanning(): boolean { return this.active; }

  /** Samples frames until the forge detects an object or 10 s pass. Returns null on timeout or cancel. */
  async scan(onTick?: (elapsedMs: number) => void): Promise<Detected | null> {
    if (this.active) return null;
    this.active = true;
    this.prevThumb = null;
    const t0 = Date.now();
    try {
      while (this.active && Date.now() - t0 < WINDOW_MS) {
        const tickStart = Date.now();
        onTick?.(tickStart - t0);
        const frame = this.latest;
        if (frame) {
          const jpeg = await this.prepare(frame);
          if (jpeg) {
            const hit = await this.forge(jpeg);
            if (hit) return hit;
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
    if (this.prevThumb) {
      let diff = 0;
      for (let i = 0; i < thumb.length; i++) diff += Math.abs(thumb[i]! - this.prevThumb[i]!);
      if (diff / (thumb.length * 255) < MIN_CHANGE) return null; // same picture as last time
    }
    this.prevThumb = thumb;
    // Blur check (Laplacian variance) left out: no threshold measured yet.
    return img().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  }

  private async forge(jpeg: Buffer): Promise<Detected | null> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'frame.jpg');
    form.append('sessionId', this.sessionId);
    form.append('source', 'facetime');
    const t0 = Date.now();
    try {
      const res = await fetch(`${env.SERVER_HTTP_URL}/api/forge`, { method: 'POST', body: form, signal: AbortSignal.timeout(FORGE_TIMEOUT_MS) });
      const body = (await res.json().catch(() => ({}))) as Partial<Detected> & { detected?: boolean; reason?: string };
      log('forge_reply', { status: res.status, detected: body.detected ?? false, reason: body.reason, ms: Date.now() - t0 });
      if (res.status === 202 && body.detected && body.forgeId) {
        return {
          forgeId: body.forgeId, objectName: body.objectName ?? 'something',
          displayName: body.displayName ?? body.objectName ?? 'a weapon',
          weaponClass: body.weaponClass ?? 'blunt', quip: body.quip ?? 'Forging now.',
        };
      }
    } catch (e) {
      warn('forge_failed', { error: errText(e), ms: Date.now() - t0 });
    }
    return null;
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
