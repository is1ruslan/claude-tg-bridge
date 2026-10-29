import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVscodeBridge } from '../src/vscode.mjs';

test('dispatch with no windows → no-window', async () => {
  const b = createVscodeBridge();
  assert.deepEqual(await b.dispatch({ cwd: 'C:\\x' }), { ok: false, error: 'no-window' });
});

test('waiting poll receives the job; ack resolves dispatch', async () => {
  const b = createVscodeBridge();
  const polled = b.poll({ id: 'w1', folders: [], focusedAt: 1 });
  const res = b.dispatch({ cwd: 'C:\\x', title: 't' });
  const job = await polled;
  assert.equal(job.cwd, 'C:\\x');
  assert.ok(job.id);
  assert.equal(b.ack(job.id, { ok: true }), true);
  assert.deepEqual(await res, { ok: true });
  assert.equal(b.ack(job.id, { ok: true }), false);
  b.close();
});

test('job queued between polls is returned by the next poll', async () => {
  const b = createVscodeBridge();
  const p1 = b.poll({ id: 'w1' }, { timeoutMs: 5 });
  assert.equal(await p1, null);
  const res = b.dispatch({ cwd: 'C:\\x' });
  const job = await b.poll({ id: 'w1' });
  b.ack(job.id, { ok: false, error: 'boom' });
  assert.deepEqual(await res, { ok: false, error: 'boom' });
});

test('window with the matching folder wins over the focused one; else most recently focused', async () => {
  const b = createVscodeBridge();
  const a = b.poll({ id: 'a', folders: ['C:\\Projects\\app'], focusedAt: 1 });
  const c = b.poll({ id: 'c', folders: ['C:\\Other'], focusedAt: 5 });
  b.dispatch({ cwd: 'c:\\projects\\APP\\sub' });
  const ja = await a;
  assert.equal(ja.cwd, 'c:\\projects\\APP\\sub');
  b.ack(ja.id, { ok: true });
  const a2 = b.poll({ id: 'a', folders: ['C:\\Projects\\app'] });
  b.dispatch({ cwd: 'D:\\elsewhere' });
  const jc = await c;
  assert.equal(jc.cwd, 'D:\\elsewhere');
  b.ack(jc.id, { ok: true });
  b.focus('a', 10);
  const c2 = b.poll({ id: 'c' });
  b.dispatch({ cwd: 'D:\\elsewhere' });
  const ja2 = await a2;
  assert.equal(ja2.cwd, 'D:\\elsewhere');
  b.ack(ja2.id, { ok: true });
  b.close();
  assert.equal(await c2, null);
});

test('no ack within timeout → timeout; stale windows are ignored', async () => {
  let t = 0;
  const b = createVscodeBridge({ now: () => t, windowTtlMs: 100 });
  const p = b.poll({ id: 'w' });
  const res = b.dispatch({ cwd: 'C:\\x' }, { timeoutMs: 10 });
  await p;
  assert.deepEqual(await res, { ok: false, error: 'timeout' });
  t = 1000;
  assert.deepEqual(await b.dispatch({ cwd: 'C:\\x' }), { ok: false, error: 'no-window' });
});
