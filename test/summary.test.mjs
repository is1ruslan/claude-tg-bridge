import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, runClaude, fallbackSummary } from '../src/summary.mjs';

const long = Array.from({ length: 12 }, (_, i) => `Строка ${i + 1}: ` + 'x'.repeat(150)).join('\n');

test('short text, not failed: run not called, done', async () => {
  let called = false;
  const r = await summarize('Готово. Тесты зелёные.', { failed: false, run: async () => { called = true; return ''; } });
  assert.equal(called, false);
  assert.equal(r.status, 'done');
  assert.equal(r.summary, 'Готово. Тесты зелёные.');
});

test('short text ending with ? is waiting', async () => {
  const r = await summarize('Сделал два варианта.\nКакой вариант?\n\n', { failed: false, run: async () => assert.fail('no run') });
  assert.equal(r.status, 'waiting');
});

test('failed short text -> error without run', async () => {
  const r = await summarize('Упало', { failed: true, run: async () => assert.fail('no run') });
  assert.equal(r.status, 'error');
  assert.equal(r.summary, 'Упало');
});

test('long text: run result parsed from first {...}', async () => {
  let prompt;
  const r = await summarize(long, { failed: false, run: async (p) => { prompt = p; return 'bla {"status":"waiting","summary":"x"} bla'; } });
  assert.equal(prompt, long);
  assert.deepEqual(r, { status: 'waiting', summary: 'x' });
});

test('failed overrides model status', async () => {
  const r = await summarize(long, { failed: true, run: async () => '{"status":"done","summary":"y"}' });
  assert.deepEqual(r, { status: 'error', summary: 'y' });
});

test('run throws -> done + truncation <= 501 chars', async () => {
  const r = await summarize(long, { failed: false, run: async () => { throw new Error('boom'); } });
  assert.equal(r.status, 'done');
  assert.ok(r.summary.length <= 501);
  assert.ok(r.summary.endsWith('…'));
  assert.equal(r.summary.split('\n').length <= 5, true);
});

test('garbage output -> fallback; failed -> error', async () => {
  const r = await summarize(long, { failed: true, run: async () => 'no json here' });
  assert.equal(r.status, 'error');
  assert.ok(r.summary.length <= 501);
  const bad = await summarize(long, { failed: false, run: async () => '{"status":"weird"}' });
  assert.equal(bad.status, 'done');
});

test('invalid status from model with valid summary is normalised', async () => {
  const r = await summarize(long, { failed: false, run: async () => '{"status":"weird","summary":"ok"}' });
  assert.deepEqual(r, { status: 'done', summary: 'ok' });
});

test('input capped at 12000 chars', async () => {
  let prompt;
  await summarize('a\n'.repeat(10000), { failed: false, run: async (p) => { prompt = p; return '{"status":"done","summary":"s"}'; } });
  assert.equal(prompt.length, 12000);
});

test('fallback never splits a surrogate pair', () => {
  const s = fallbackSummary('😀'.repeat(600));
  assert.ok(s.endsWith('…'));
  assert.ok(!/[\ud800-\udbff]…$/.test(s));
  assert.equal([...s].length, 501);
});

test('fallback keeps first 5 non-empty lines', () => {
  const s = fallbackSummary('a\n\nb\n c \nd\ne\nf\ng');
  assert.equal(s, 'a\nb\nc\nd\ne');
});

test('live runClaude (opt-in)', { skip: process.env.CC_TG_LIVE !== '1' }, async () => {
  const out = await runClaude('Сделал рефакторинг модуля auth, тесты проходят. Осталось обновить документацию. Нужно ли мне это сделать?');
  console.log('LIVE OUTPUT:', out);
  const m = out.match(/\{[\s\S]*\}/);
  assert.ok(m, 'json present');
  const j = JSON.parse(m[0]);
  assert.ok(['done', 'waiting', 'error'].includes(j.status));
  assert.equal(typeof j.summary, 'string');
});
