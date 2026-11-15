// Owner rule for a player_pinned event during a call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pinAction } from '../src/pin.ts';

const base = { weaponCame: false, scanFailed: false, askOpen: false, linePending: false };

test('the pin that started the call stays silent: no scan has ended yet', () => {
  assert.equal(pinAction(base), 'silent');
});

test('after a weapon came, a pin says the line and starts no scan', () => {
  assert.equal(pinAction({ ...base, weaponCame: true }), 'say');
  assert.equal(pinAction({ ...base, weaponCame: true, scanFailed: true }), 'say');
});

test('after a failed scan with no weapon, a pin says the line and scans again (owner)', () => {
  assert.equal(pinAction({ ...base, scanFailed: true }), 'sayAndScan');
});

test('an open scan or forge keeps the pin silent', () => {
  assert.equal(pinAction({ ...base, weaponCame: true, askOpen: true }), 'silent');
  assert.equal(pinAction({ ...base, scanFailed: true, askOpen: true }), 'silent');
});

test('one copy at a time: a pin while the line is queued or playing is silent', () => {
  assert.equal(pinAction({ ...base, weaponCame: true, linePending: true }), 'silent');
  assert.equal(pinAction({ ...base, scanFailed: true, linePending: true }), 'silent');
});
