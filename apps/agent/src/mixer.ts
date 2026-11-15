// The one-voice rule (spec B.5): one 48 kHz mono AudioSource, 10 ms frames, out = tts + mic x g.
import { AudioFrame, AudioSource, AudioStream, type RemoteTrack } from '@livekit/rtc-node';
import { errText, warn } from './log.ts';

const RATE = 48_000;
const FRAME = 480; // 10 ms
const MIC_MAX = RATE / 5; // 200 ms cap; drop the oldest beyond this
const DUCK_GAIN = 0.35;
const GATE_DBFS = -45;
const attackCoef = 1 - Math.exp(-1 / (0.03 * RATE));
const releaseCoef = 1 - Math.exp(-1 / (0.25 * RATE));

type Clip = { chunks: Int16Array[]; pos: number; streaming: boolean; done: () => void; cancelled: boolean };

export class Mixer {
  readonly source: AudioSource;
  private clips: Clip[] = [];
  private mic = new Int16Array(0);
  private micStream: AudioStream | null = null;
  private gain = 1;
  private running = false;

  constructor() {
    // Small native queue so a greeting starts within ~100 ms of play(), not behind a second of silence.
    this.source = new AudioSource(RATE, 1, 100);
  }

  /** Starts pushing frames (silence until something plays). */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  get speaking(): boolean {
    return this.clips.length > 0;
  }

  /** Queues a clip. Resolves when it has been pushed out (or cancelled). */
  play(pcm: Int16Array | AsyncIterable<Int16Array>): Promise<void> {
    return new Promise((resolve) => {
      const clip: Clip = { chunks: [], pos: 0, streaming: !(pcm instanceof Int16Array), done: resolve, cancelled: false };
      if (pcm instanceof Int16Array) clip.chunks.push(pcm);
      else {
        void (async () => {
          try {
            for await (const c of pcm) { if (clip.cancelled) break; clip.chunks.push(c); }
          } catch (e) {
            warn('tts_stream_failed', { error: errText(e) });
          } finally {
            clip.streaming = false;
          }
        })();
      }
      this.clips.push(clip);
    });
  }

  /** Stops the current clip and drops anything queued. */
  interrupt(): void {
    for (const c of this.clips) { c.cancelled = true; c.done(); }
    this.clips = [];
  }

  enableMic(track: RemoteTrack): void {
    this.disableMic();
    const stream = new AudioStream(track, { sampleRate: RATE, numChannels: 1 });
    this.micStream = stream;
    void (async () => {
      try {
        for await (const f of stream) this.pushMic(f.data);
      } catch (e) {
        warn('mic_stream_ended', { error: errText(e) });
      }
    })();
  }

  disableMic(): void {
    void this.micStream?.cancel().catch(() => {});
    this.micStream = null;
    this.mic = new Int16Array(0);
  }

  async close(): Promise<void> {
    this.running = false;
    this.interrupt();
    this.disableMic();
    await this.source.close();
  }

  private pushMic(data: Int16Array): void {
    // Noise gate per incoming frame.
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += (data[i]! / 32768) ** 2;
    const dbfs = 10 * Math.log10(sum / Math.max(1, data.length) + 1e-12);
    const frame = dbfs < GATE_DBFS ? new Int16Array(data.length) : data;
    const merged = new Int16Array(this.mic.length + frame.length);
    merged.set(this.mic);
    merged.set(frame, this.mic.length);
    this.mic = merged.length > MIC_MAX ? merged.slice(merged.length - MIC_MAX) : merged;
  }

  private takeMic(n: number): Int16Array {
    const out = new Int16Array(n);
    const k = Math.min(n, this.mic.length);
    out.set(this.mic.subarray(0, k));
    this.mic = this.mic.slice(k);
    return out;
  }

  private takeTts(n: number): { pcm: Float32Array; active: boolean } {
    const pcm = new Float32Array(n);
    let i = 0;
    while (i < n && this.clips.length > 0) {
      const clip = this.clips[0]!;
      const chunk = clip.chunks[0];
      if (!chunk) {
        if (clip.streaming) break; // waiting on the network; keep the clip
        this.clips.shift();
        clip.done();
        continue;
      }
      const k = Math.min(n - i, chunk.length - clip.pos);
      for (let j = 0; j < k; j++) pcm[i + j] = chunk[clip.pos + j]!;
      i += k;
      clip.pos += k;
      if (clip.pos >= chunk.length) { clip.chunks.shift(); clip.pos = 0; }
    }
    return { pcm, active: this.clips.length > 0 || i > 0 };
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const { pcm: tts, active } = this.takeTts(FRAME);
      const mic = this.takeMic(FRAME);
      const target = active ? DUCK_GAIN : 1;
      const out = new Int16Array(FRAME);
      for (let i = 0; i < FRAME; i++) {
        this.gain += (target - this.gain) * (target < this.gain ? attackCoef : releaseCoef);
        const x = (tts[i]! + mic[i]! * this.gain) / 32768;
        out[i] = Math.round(Math.tanh(x) * 32767);
      }
      try {
        await this.source.captureFrame(new AudioFrame(out, RATE, 1, FRAME));
      } catch (e) {
        if (this.running) warn('mixer_capture_failed', { error: errText(e) });
        return;
      }
    }
  }
}
