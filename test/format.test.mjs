import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as F from '../src/format.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/hooks/${n}.json`, import.meta.url), 'utf8'));
const cbs = (kb) => kb.flat().map((b) => b.callback_data);
const mkq = (n, multi = false) => ({ header: 'h', question: 'q', multiSelect: multi, options: Array.from({ length: n }, (_, i) => ({ label: 'o' + i, description: 'd' })) });

test('esc', () => assert.equal(F.esc('a<b>&c'), 'a&lt;b&gt;&amp;c'));
test('header', () => assert.equal(F.header('p<1'), '📁 <b>p&lt;1</b>'));

test('completionText', () => {
  assert.equal(F.completionText('p · main', 'done', 'a<b'), '📁 <b>p · main</b>\nСтатус: ✅ завершено\na&lt;b');
  assert.match(F.completionText('p', 'waiting', 'x'), /⏸ ждёт решения/);
  assert.match(F.completionText('p', 'error', 'x'), /❌ ошибка/);
});

test('askText single and numbering', () => {
  const q = fx('PreToolUse-Ask-single').tool_input.questions[0];
  const t = F.askText('p', q, 0, 1);
  assert.ok(t.startsWith('📁 <b>p</b>\n❓ '));
  assert.ok(t.includes('1. <b>'));
  assert.ok(!t.includes('(1/1)'));
  assert.ok(!t.includes('Можно выбрать несколько.'));
});
test('askText multi and qTotal', () => {
  const q = fx('PreToolUse-Ask-multi').tool_input.questions[0];
  const t = F.askText('p', q, 1, 3);
  assert.ok(t.includes('(2/3) '));
  assert.ok(t.includes('Можно выбрать несколько.'));
  assert.ok(t.includes('4. <b>TypeScript</b> — Язык TypeScript'));
});
test('askText escapes', () => {
  const t = F.askText('p', { header: 'h<', question: 'q&', options: [{ label: 'a<', description: 'd>' }] }, 0, 1);
  assert.ok(t.includes('h&lt;') && t.includes('q&amp;') && t.includes('1. <b>a&lt;</b> — d&gt;'));
});

test('askKeyboard single', () => {
  const kb = F.askKeyboard('abc123', 0, mkq(3));
  assert.equal(kb.length, 2);
  assert.deepEqual(kb[0].map((b) => b.text), ['1', '2', '3']);
  assert.equal(kb[0][0].callback_data, 'a|abc123|0|1');
  assert.equal(kb[1].length, 1);
  assert.equal(kb[1][0].text, '✏️ Другое');
  assert.equal(kb[1][0].callback_data, 'o|abc123|0');
});
test('askKeyboard 7 options -> 5+2', () => {
  const kb = F.askKeyboard('abc123', 0, mkq(7));
  assert.deepEqual(kb.map((r) => r.length), [5, 2, 1]);
});
test('askKeyboard multi', () => {
  const kb = F.askKeyboard('abc123', 2, mkq(3, true), [1]);
  assert.deepEqual(kb[0].map((b) => b.text), ['☐ 1', '☑ 2', '☐ 3']);
  assert.equal(kb[0][1].callback_data, 't|abc123|2|2');
  assert.deepEqual(kb[1].map((b) => b.text), ['✏️ Другое', '✅ Отправить']);
  assert.equal(kb[1][1].callback_data, 's|abc123|2');
  assert.equal(kb[1][0].callback_data, 'o|abc123|2');
});

test('planText', () => {
  const t = F.planText('p', 'step <1>\nstep 2');
  assert.equal(t, '📁 <b>p</b>\n📝 План на подтверждение\nstep &lt;1&gt;\nstep 2');
  assert.ok(!t.includes('<pre>'));
});

test('permText', () => {
  const cmd = 'git commit -m "x" && echo <hi>\nline2';
  const t = F.permText('p', 'Bash', { command: cmd });
  assert.ok(t.includes('🔐 Разрешение: <b>Bash</b>'));
  assert.ok(t.includes('<pre>git commit -m "x" &amp;&amp; echo &lt;hi&gt;\nline2</pre>'));
  const w = fx('PermissionRequest-Write');
  const t2 = F.permText('p', w.tool_name, w.tool_input);
  assert.ok(t2.includes(F.esc(w.tool_input.file_path)));
  const big = F.permText('p', 'Other', { a: 'x'.repeat(5000) });
  assert.ok(big.length < 1700);
});

test('optionsKeyboard', () => {
  const kb = F.optionsKeyboard('abc123', ['Yes', 'No <x>']);
  assert.deepEqual(kb, [[{ text: '1. Yes', callback_data: 'p|abc123|1' }], [{ text: '2. No <x>', callback_data: 'p|abc123|2' }]]);
});

test('resolvedSuffix', () => {
  assert.equal(F.resolvedSuffix('telegram', 'a<'), '\n\n✔ выбрано: a&lt;');
  assert.equal(F.resolvedSuffix('terminal'), '\n\n✔ отвечено в терминале');
  assert.equal(F.resolvedSuffix('stale'), '\n\n⌛ устарело');
});

test('statusText', () => {
  assert.equal(F.statusText([], 0), 'Активных сессий нет');
  const now = 1_000_000_000;
  const s = (state, p, a) => ({ label: 'l<', session: { state, lastPromptAt: p, lastActivityAt: a } });
  const t = F.statusText([s('working', now - 180000, now), s('waiting', 0, 0), s('idle', 0, now - 12 * 60000), s('working', now + 5000, now)], now).split('\n');
  assert.deepEqual(t, ['• l&lt; — работает 3 мин', '• l&lt; — ждёт ответа', '• l&lt; — простаивает 12 мин', '• l&lt; — работает 0 мин']);
});

test('sessionPickKeyboard', () => {
  const items = [{ label: 'a', short: 'abcd1234' }, { label: 'b', short: 'efgh5678' }];
  assert.deepEqual(F.sessionPickKeyboard(items, 'x'), [[{ text: 'a', callback_data: 'x|abcd1234' }], [{ text: 'b', callback_data: 'x|efgh5678' }]]);
  assert.equal(F.sessionPickKeyboard(items, 'r', 'k1')[0][0].callback_data, 'r|abcd1234|k1');
});

test('callback_data <= 64 bytes', () => {
  const all = [
    ...cbs(F.askKeyboard('zzzzzz', 9, mkq(12))),
    ...cbs(F.askKeyboard('zzzzzz', 9, mkq(12, true), [0, 11])),
    ...cbs(F.optionsKeyboard('zzzzzz', ['a', 'b', 'c'])),
    ...cbs(F.sessionPickKeyboard([{ label: 'a', short: '12345678' }], 'r', 'mk123456')),
  ];
  for (const c of all) assert.ok(Buffer.byteLength(c) <= 64, c);
});
