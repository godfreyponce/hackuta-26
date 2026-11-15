// Review #2: a line queued while sayNow (the greeting) plays must play when the greeting ends.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mixer } from '../src/mixer.ts';
import { Narrator, PRIORITY } from '../src/narrator.ts';

class FakeMixer {
  played: number[] = [];
  private finish: Array<() => void> = [];
  play(pcm: Int16Array): Promise<void> {
    this.played.push(pcm[0]!);
    return new Promise((r) => this.finish.push(r));
  }
  interrupt(): void { for (const f of this.finish.splice(0)) f(); }
  endCurrent(): void { this.finish.shift()?.(); }
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test('a line queued during the greeting plays after it', async () => {
  const mixer = new FakeMixer();
  const narrator = new Narrator(mixer as unknown as Mixer, () => {});
  const greeting = narrator.sayNow('greeting', PRIORITY.greeting, Int16Array.of(1));
  await tick();
  narrator.say('cant see', PRIORITY.scan, Int16Array.of(2));
  await tick();
  assert.deepEqual(mixer.played, [1]);
  mixer.endCurrent();
  await greeting;
  await tick();
  assert.deepEqual(mixer.played, [1, 2]);
  narrator.stop();
});
