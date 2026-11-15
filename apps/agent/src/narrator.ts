// Narration scheduler (spec B.6): priority queue, 2.5 s gap, stale lines dropped, interrupts only at >= 90.
import { log } from './log.ts';
import type { Mixer } from './mixer.ts';
import { ttsStream } from './tts.ts';

export const PRIORITY = { greeting: 100, scan: 90, weapon: 80, danger: 70, trickshot: 50, flavor: 10 } as const;
const MIN_GAP_MS = 2_500;
const STALE_MS = 3_000;

type Item = { text: string; pcm?: Int16Array; priority: number; at: number };

export class Narrator {
  private queue: Item[] = [];
  private current: Item | null = null;
  private lastEnd = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private mixer: Mixer,
    private onSpoken: (text: string, priority: number) => void,
    /** Not called for a line that another line interrupted. */
    private onFinished: (text: string) => void = () => {},
  ) {}

  /** pcm = a cached render; without it the line streams from ElevenLabs. */
  say(text: string, priority: number, pcm?: Int16Array): void {
    if (this.stopped) return;
    const item: Item = { text, priority, at: Date.now(), ...(pcm ? { pcm } : {}) };
    if (this.current && priority >= 90 && priority > this.current.priority) {
      log('narration_interrupt', { was: this.current.text });
      this.mixer.interrupt();
      this.current = null;
      this.lastEnd = 0;
    }
    this.queue.push(item);
    this.queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    this.pump();
  }

  /** Plays a line now, skipping the queue and gap. Resolves when it finishes. */
  async sayNow(text: string, priority: number, pcm?: Int16Array): Promise<void> {
    this.mixer.interrupt();
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.speak({ text, priority, at: Date.now(), ...(pcm ? { pcm } : {}) });
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private pump(): void {
    if (this.stopped || this.current || this.timer) return;
    const now = Date.now();
    this.queue = this.queue.filter((i) => i.priority >= 80 || now - i.at <= STALE_MS);
    const next = this.queue[0];
    if (!next) return;
    const wait = this.lastEnd + MIN_GAP_MS - now;
    if (wait > 0 && next.priority < 90) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
      return;
    }
    this.queue.shift();
    void this.speak(next).then(() => this.pump());
  }

  private async speak(item: Item): Promise<void> {
    this.current = item;
    this.onSpoken(item.text, item.priority);
    log('narration', { text: item.text, priority: item.priority, cached: !!item.pcm });
    await this.mixer.play(item.pcm ?? ttsStream(item.text));
    if (this.current === item) { this.current = null; this.lastEnd = Date.now(); this.onFinished(item.text); }
  }
}
