// Review #3: spec D.3 replies 202 {forgeId, objectName, ...} with no `detected` field. That is a hit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseForgeReply } from '../src/scanner.ts';

const d3 = { forgeId: 'f1', objectName: 'frying pan', displayName: 'Pan of Telemachus', weaponClass: 'blunt', quip: 'Forging now.' };

test('202 with forgeId and no detected field is a hit', () => {
  assert.deepEqual(parseForgeReply(202, d3), d3);
});

test('202 with detected:true is a hit', () => {
  assert.equal(parseForgeReply(202, { detected: true, ...d3 })?.forgeId, 'f1');
});

test('200 no_object and 200 busy are misses', () => {
  assert.equal(parseForgeReply(200, { detected: false, reason: 'no_object' }), null);
  assert.equal(parseForgeReply(200, { detected: false, reason: 'busy' }), null);
});

test('202 without forgeId is a miss', () => {
  assert.equal(parseForgeReply(202, { objectName: 'pan' }), null);
});
