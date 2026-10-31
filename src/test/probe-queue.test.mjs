import assert from 'node:assert/strict';
import test from 'node:test';
import { createProbeLimiter } from '../preferred.mjs';

test('FIFO transfer preserves concurrency and drains queue', async () => {
  const q = createProbeLimiter({ concurrency: 1 });
  await q.acquire();
  const order = [];
  const a = q.acquire().then(() => order.push('a'));
  const b = q.acquire().then(() => order.push('b'));
  assert.equal(q.active, 1); assert.equal(q.queued, 2);
  q.release(); await a;
  assert.deepEqual(order, ['a']); assert.equal(q.active, 1);
  q.release(); await b; q.release();
  assert.deepEqual(order, ['a', 'b']); assert.equal(q.active, 0); assert.equal(q.queued, 0);
});
test('queue overflow rejects without growing queue', async () => {
  const q = createProbeLimiter({ concurrency: 1, maxQueue: 1 });
  await q.acquire(); const pending = q.acquire();
  await assert.rejects(q.acquire(), { status: 429 });
  assert.equal(q.queued, 1); q.release(); await pending; q.release();
});
test('queued abort removes waiter and leaves active task alone', async () => {
  const q = createProbeLimiter({ concurrency: 1 });
  await q.acquire(); const c = new AbortController();
  const rejected = assert.rejects(q.acquire(c.signal), { status: 499 });
  c.abort(); await rejected;
  assert.equal(q.queued, 0); assert.equal(q.active, 1); q.release();
});
test('already aborted calls consume no slot', async () => {
  const q = createProbeLimiter(); const c = new AbortController(); c.abort();
  await assert.rejects(q.acquire(c.signal), { status: 499 }); assert.equal(q.active, 0);
});
test('queue timeout removes waiter and permits later work', async () => {
  const q = createProbeLimiter({ concurrency: 1, queueTimeoutMs: 20 });
  await q.acquire(); await assert.rejects(q.acquire(), { status: 503 });
  assert.equal(q.queued, 0); q.release(); await q.acquire(); q.release(); assert.equal(q.active, 0);
});
test('zero waiting capacity still allows immediate work', async () => {
  const q = createProbeLimiter({ concurrency: 1, maxQueue: 0 });
  await q.acquire(); await assert.rejects(q.acquire(), { status: 429 }); q.release();
});
test('invalid settings are rejected', () => {
  for (const settings of [{ concurrency: 0 }, { maxQueue: -1 }, { queueTimeoutMs: 0 }]) assert.throws(() => createProbeLimiter(settings), TypeError);
});
