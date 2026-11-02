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
  assert.equal(F.completionText('p · main', 'done', 'a<b'), '📁 <b>p · main</b>\n\nСтатус: ✅ завершено\n\na&lt;b');
  assert.match(F.completionText('p', 'waiting', 'x'), /⏸ ждёт решения/);
  assert.match(F.completionText('p', 'error', 'x'), /❌ ошибка/);
});

test('askText single and numbering', () => {
  const q = fx('PreToolUse-Ask-single').tool_input.questions[0];
  const t = F.askText('p', q, 0, 1);
  assert.ok(t.startsWith('📁 <b>p</b>\n\n❓ '));
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
  assert.equal(t, '📁 <b>p</b>\n\n📝 План на подтверждение\n\nstep &lt;1&gt;\nstep 2');
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

// ---------- final-fix wave ----------

test('minor: header("") -> 📁 <b>сессия</b>', () => {
  assert.equal(F.header(''), '📁 <b>сессия</b>');
  assert.equal(F.header(undefined), '📁 <b>сессия</b>');
});

test('F3: dialogKeyboard — ask uses cursor/question/multi, plan/perm use options', () => {
  const q0 = mkq(2), q1 = mkq(3, true);
  const ask = { id: 'abc123', kind: 'ask', cursor: 1, multi: [2], payload: { questions: [q0, q1] }, options: [] };
  assert.deepEqual(F.dialogKeyboard(ask), F.askKeyboard('abc123', 1, q1, [2]));
  const perm = { id: 'abc123', kind: 'perm', options: ['✅ Да', '⛔ Нет'] };
  assert.deepEqual(F.dialogKeyboard(perm), F.optionsKeyboard('abc123', ['✅ Да', '⛔ Нет']));
  const plan = { id: 'abc123', kind: 'plan', options: ['a', 'b', 'c'] };
  assert.deepEqual(F.dialogKeyboard(plan), F.optionsKeyboard('abc123', ['a', 'b', 'c']));
  assert.equal(F.dialogKeyboard({ id: 'x', kind: 'ask', cursor: 5, payload: { questions: [] } }), null);
});

const NOTE_CMD = (n) => `⚠ команда обрезана (всего ${n} символов) — полностью в терминале`;
const NOTE = (n) => `⚠ обрезано (всего ${n} символов) — полностью в терминале`;

test('F10: Bash command up to 3500 chars shown in full; longer -> first 3500 + note', () => {
  const ok = 'a'.repeat(3500);
  const t = F.permText('p', 'Bash', { command: ok });
  assert.ok(t.includes(`<pre>${ok}</pre>`));
  assert.ok(!t.includes('⚠'));
  const long = 'b'.repeat(5000);
  const t2 = F.permText('p', 'Bash', { command: long });
  assert.ok(t2.includes(`<pre>${'b'.repeat(3500)}</pre>\n${NOTE_CMD(5000)}`));
  assert.ok(!t2.includes('b'.repeat(3501)));
});

test('F10: never cuts a surrogate pair', () => {
  const cmd = 'x'.repeat(3499) + '😀' + 'tail';
  const t = F.permText('p', 'Bash', { command: cmd });
  assert.ok(t.includes(`<pre>${'x'.repeat(3499)}</pre>`));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t), 'no lone high surrogate');
});

test('F10: Edit shows file_path + old/new previews (≤ 800 each, note when cut)', () => {
  const t = F.permText('p', 'Edit', { file_path: 'C:/a<b>.js', old_string: 'old & text', new_string: 'n'.repeat(900) });
  assert.ok(t.includes('C:/a&lt;b&gt;.js'));
  assert.ok(t.includes('<pre>old &amp; text</pre>'));
  assert.ok(t.includes(`<pre>${'n'.repeat(800)}</pre>\n${NOTE(900)}`));
  assert.ok(!t.includes('n'.repeat(801)));
});

test('F10: Write shows file_path + content preview ≤ 1200 with note; others JSON ≤ 1500 with note', () => {
  const w = F.permText('p', 'Write', { file_path: 'C:/f.txt', content: 'c'.repeat(1300) });
  assert.ok(w.includes('C:/f.txt'));
  assert.ok(w.includes(`<pre>${'c'.repeat(1200)}</pre>\n${NOTE(1300)}`));
  const shortW = F.permText('p', 'Write', { file_path: 'C:/f.txt', content: 'hi' });
  assert.ok(shortW.includes('<pre>hi</pre>') && !shortW.includes('⚠'));
  const o = F.permText('p', 'Other', { a: 'x'.repeat(5000) });
  const json = JSON.stringify({ a: 'x'.repeat(5000) });
  assert.ok(o.includes(`<pre>${F.esc(json.slice(0, 1500))}</pre>\n${NOTE(json.length)}`));
  const small = F.permText('p', 'Other', { a: 1 });
  assert.ok(small.includes('<pre>{"a":1}</pre>') && !small.includes('⚠'));
});

test('paragraphs: blank line between prose lines, lists stay compact, existing blanks kept', () => {
  assert.equal(F.paragraphs('Сделано А.\nОсталось Б.'), 'Сделано А.\n\nОсталось Б.');
  assert.equal(F.paragraphs('Варианты:\n1. раз\n2. два\n- три\nИтог.'), 'Варианты:\n1. раз\n2. два\n- три\n\nИтог.');
  assert.equal(F.paragraphs('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(F.paragraphs(''), '');
});

test('completionText: summary lines become paragraphs', () => {
  const t = F.completionText('p', 'waiting', 'Сделал X.\nНужно решить Y.\n1. да\n2. нет');
  assert.equal(t, '📁 <b>p</b>\n\nСтатус: ⏸ ждёт решения\n\nСделал X.\n\nНужно решить Y.\n1. да\n2. нет');
});

test('askText: blocks separated by blank lines; options with descriptions spaced, plain options compact', () => {
  const t = F.askText('p', { header: 'H', question: 'Q?', options: [{ label: 'a', description: 'da' }, { label: 'b', description: 'db' }] }, 0, 1);
  assert.equal(t, '📁 <b>p</b>\n\n❓ <b>H</b>\n\nQ?\n\n1. <b>a</b> — da\n\n2. <b>b</b> — db');
  const t2 = F.askText('p', { header: 'H', question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] }, 0, 1);
  assert.ok(t2.endsWith('Q?\n\n1. <b>a</b>\n2. <b>b</b>'));
});

test('permText: blocks separated by blank lines, label stays with its block', () => {
  const t = F.permText('p', 'Edit', { file_path: 'f.js', old_string: 'a', new_string: 'b' });
  assert.equal(t, '📁 <b>p</b>\n\n🔐 Разрешение: <b>Edit</b>\n\n<pre>f.js</pre>\n\nБыло:\n<pre>a</pre>\n\nСтало:\n<pre>b</pre>');
});
