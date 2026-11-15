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

test('nothing new is spoken after stop() (review 2 #5)', async () => {
  const mixer = new FakeMixer();
  const spoken: string[] = [];
  const narrator = new Narrator(mixer as unknown as Mixer, (t) => spoken.push(t));
  narrator.stop();
  narrator.say('weapon line', PRIORITY.weapon, Int16Array.of(3));
  await tick();
  assert.deepEqual(spoken, []);
  assert.deepEqual(mixer.played, []);
});

test('a line queued behind the farewell is dropped when stop() comes first', async () => {
  const mixer = new FakeMixer();
  const spoken: string[] = [];
  const narrator = new Narrator(mixer as unknown as Mixer, (t) => spoken.push(t));
  const farewell = narrator.sayNow('farewell', PRIORITY.greeting, Int16Array.of(1));
  await tick();
  narrator.say('weapon line', PRIORITY.weapon, Int16Array.of(3));
  narrator.stop();
  mixer.endCurrent();
  await farewell;
  await tick();
  assert.deepEqual(spoken, ['farewell']);
});

test('the caption clears when a line ends, but not when a higher line interrupts it (captions)', async () => {
  const mixer = new FakeMixer();
  const events: string[] = [];
  const narrator = new Narrator(mixer as unknown as Mixer, (t) => events.push(`show ${t}`), (t) => events.push(`clear ${t}`));
  narrator.say('flavor', PRIORITY.flavor, Int16Array.of(1));
  await tick();
  narrator.say('scan', PRIORITY.scan, Int16Array.of(2));
  await tick();
  mixer.endCurrent();
  await tick();
  assert.deepEqual(events, ['show flavor', 'show scan', 'clear scan']);
  narrator.stop();
});
