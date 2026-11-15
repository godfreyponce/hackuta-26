// Review 2 #2: a drop and the next replace on the same name run in order; a late drop for an old track leaves the new relay.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RelaySlots } from '../src/relay-slots.ts';

const tick = () => new Promise((r) => setTimeout(r, 10));

function rig() {
  const order: string[] = [];
  let release: () => void = () => {};
  const slots = new RelaySlots<'friend-cam'>(async (sid) => {
    order.push(`unpublish-start ${sid}`);
    await new Promise<void>((r) => { release = r; });
    order.push(`unpublish-done ${sid}`);
  });
  const parts = (tag: string) => ({
    stream: { cancel: async () => { order.push(`cancel ${tag}`); } },
    source: { close: async () => { order.push(`close ${tag}`); } },
  });
  const publish = (sid: string) => async () => { order.push(`publish ${sid}`); return sid; };
  return { order, slots, parts, publish, release: () => release() };
}

test('a new subscribe right after an unsubscribe publishes only after the old unpublish', async () => {
  const { order, slots, parts, publish, release } = rig();
  slots.replace('friend-cam', 'A', parts('A'), publish('sidA'));
  await tick();
  void slots.drop('friend-cam', 'A');
  slots.replace('friend-cam', 'B', parts('B'), publish('sidB'));
  await tick();
  assert.deepEqual(order, ['publish sidA', 'cancel A', 'unpublish-start sidA']);
  release();
  await tick();
  assert.deepEqual(order.slice(3), ['unpublish-done sidA', 'close A', 'publish sidB']);
});

test('a late unsubscribe of the old track does not drop the new relay', async () => {
  const { order, slots, parts, publish, release } = rig();
  slots.replace('friend-cam', 'A', parts('A'), publish('sidA'));
  await tick();
  slots.replace('friend-cam', 'B', parts('B'), publish('sidB'));
  await tick();
  release();
  await tick();
  await slots.drop('friend-cam', 'A');
  await tick();
  assert.equal(order.includes('cancel B'), false);
  assert.equal(order.includes('unpublish-start sidB'), false);
  assert.equal(slots.size, 1);
});
