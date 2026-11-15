// Integration run #6: the agent sends through @ithaca/shared's contract, and the server rejects what that contract
// rejects (shared caps narration.text at 400 chars). Every message the agent sends must pass agentToServerSchema.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentToServerSchema } from '@ithaca/shared';
import { outbound } from '../src/hub.ts';

const parse = (json: string | null) => agentToServerSchema.safeParse(JSON.parse(json ?? 'null'));

test('a narration over 400 chars is cut at a word, marked, and passes shared', () => {
  const long = 'The Quartermaster rambles on '.repeat(40);
  const r = parse(outbound({ type: 'narration', sessionId: 's1', text: long, priority: 1 }));
  assert.ok(r.success, 'shared rejected the narration');
  assert.equal(r.data.type, 'narration');
  if (r.data.type !== 'narration') return;
  assert.ok(r.data.text.length <= 400, `length ${r.data.text.length}`);
  assert.ok(r.data.text.endsWith('…'));
  assert.ok(long.startsWith(r.data.text.slice(0, -1)), 'not a prefix of the line');
  assert.ok(!/\s…$/.test(r.data.text), 'cut leaves a space before the mark');
  assert.ok(long.charAt(r.data.text.length - 1) === ' ', 'cut inside a word');
});

test('a narration of exactly 400 chars goes out unchanged', () => {
  const text = 'x'.repeat(400);
  const r = parse(outbound({ type: 'narration', sessionId: 's1', text, priority: 1 }));
  assert.ok(r.success);
  assert.equal(r.data.type === 'narration' && r.data.text, text);
});

test('one 500-char word is cut hard rather than dropped', () => {
  const r = parse(outbound({ type: 'narration', sessionId: 's1', text: 'a'.repeat(500), priority: 1 }));
  assert.ok(r.success);
  assert.equal(r.data.type === 'narration' && r.data.text.length, 400);
});

test('a cut never leaves half of an emoji', () => {
  const r = parse(outbound({ type: 'narration', sessionId: 's1', text: `${'a'.repeat(398)}😀😀`, priority: 1 }));
  assert.ok(r.success);
  const text = r.data.type === 'narration' ? r.data.text : '';
  assert.equal(text.slice(-2), 'a…', 'a lone surrogate before the mark');
});

test('a message shared rejects is not sent', () => {
  assert.equal(outbound({ type: 'call.status', sessionId: '', state: 'ended' }), null);
});

test('a normal status goes out with the envelope', () => {
  const r = parse(outbound({ type: 'call.status', sessionId: 's1', state: 'ringing' }));
  assert.ok(r.success);
  assert.equal(r.data.v, 1);
});
