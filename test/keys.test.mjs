import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  askSequence, planSequence, permissionSequence, instructionSequence, stopSequence,
  PLAN_OPTIONS, PLAN_FEEDBACK_INDEX, permissionOptions, describeSuggestion,
} from '../src/keys.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/hooks/${n}.json`, import.meta.url), 'utf8'));
const qs = (n) => fx(n).tool_input.questions;
const D = { key: 'DOWN' };
const E = { key: 'ENTER' };
const S = { sleep: 400 };
const downs = (n) => Array(n).fill(D);
const opts = (n, multiSelect = false) => ({ question: 'q', header: 'h', multiSelect, options: Array.from({ length: n }, (_, i) => ({ label: 'o' + i })) });

test('single: option 2 of 3 -> digit', () => {
  assert.deepEqual(askSequence(qs('PreToolUse-Ask-single'), [{ kind: 'option', index: 1 }]), [{ text: '2' }]);
});
test('single: other with 4 options', () => {
  assert.deepEqual(askSequence([opts(4)], [{ kind: 'other', text: 'Ананас' }]),
    [...downs(4), { text: 'Ананас' }, S, E]);
});
test('multi [0,2] of 4 (fixture): digits, N+1 DOWN, ENTER, Review', () => {
  assert.deepEqual(askSequence(qs('PreToolUse-Ask-multi'), [{ kind: 'multi', indexes: [0, 2] }]),
    [{ text: '1' }, { text: '3' }, ...downs(5), E, S, E]);
});
test('multi: other path isolated', () => {
  assert.deepEqual(askSequence([opts(4, true)], [{ kind: 'other', text: 'x' }]),
    [...downs(4), { text: 'x' }, S, D, E, S, E]);
});
test('two questions (fixture): option 1 + other', () => {
  const q = qs('PreToolUse-Ask-two');
  assert.equal(q.length, 2);
  assert.deepEqual(askSequence(q, [{ kind: 'option', index: 0 }, { kind: 'other', text: 'XXL' }]),
    [{ text: '1' }, S, ...downs(4), { text: 'XXL' }, S, E, S, E]);
});
test('errors', () => {
  assert.throws(() => askSequence([opts(3)], [{ kind: 'option', index: 3 }]), RangeError);
  assert.throws(() => askSequence([opts(3)], [{ kind: 'option', index: -1 }]), RangeError);
  assert.throws(() => askSequence([opts(3, true)], [{ kind: 'multi', indexes: [3] }]), RangeError);
  assert.throws(() => askSequence([opts(3)], []), RangeError);
});

// cursor simulation: never reaches row N+2 (single) / beyond Submit (multi)
function maxCursor(steps) {
  let pos = 0, max = 0;
  for (const s of steps) {
    if (s.key === 'DOWN') pos++;
    else if (s.key === 'UP') pos--;
    max = Math.max(max, pos);
  }
  return max;
}
test('cursor never exceeds N (single) / N+1 (multi) per question', () => {
  for (const n of [2, 3, 4]) {
    const single = askSequence([opts(n)], [{ kind: 'other', text: 't' }]);
    assert.ok(maxCursor(single) <= n);
    const multi = askSequence([opts(n, true)], [{ kind: 'multi', indexes: [0] }]);
    assert.ok(maxCursor(multi) <= n + 1);
    const multiOther = askSequence([opts(n, true)], [{ kind: 'other', text: 't' }]);
    assert.ok(maxCursor(multiOther) <= n + 1);
    // Review screen: no DOWN after the last question's own keys
    const two = askSequence([opts(n), opts(n)], [{ kind: 'other', text: 'a' }, { kind: 'other', text: 'b' }]);
    // split by tab switch: per-question max
    const parts = []; let cur = [];
    for (const s of two) { if (s.sleep === 400 && cur.length && cur.at(-1).key === 'ENTER') { parts.push(cur); cur = []; } else cur.push(s); }
    parts.push(cur);
    for (const p of parts) assert.ok(maxCursor(p) <= n);
  }
});

test('instruction / stop', () => {
  assert.deepEqual(instructionSequence('привет'), [{ text: 'привет' }, S, E]);
  assert.deepEqual(stopSequence(), [{ key: 'ESC' }]);
});
test('plan', () => {
  assert.deepEqual(PLAN_OPTIONS, ['✅ Да, auto mode', '✅ Да, правки вручную', '✏️ Изменить план']);
  assert.equal(PLAN_FEEDBACK_INDEX, 2);
  assert.deepEqual(planSequence(0), [{ text: '1' }]);
  assert.deepEqual(planSequence(1), [{ text: '2' }]);
  assert.deepEqual(planSequence(2, 'проще'), [{ text: '3' }, { text: 'проще' }, S, E]);
});
test('permission', () => {
  assert.deepEqual(permissionSequence(2), [{ text: '3' }]);
  const sug = fx('PermissionRequest-Write').permission_suggestions;
  assert.deepEqual(permissionOptions(sug), ['✅ Да', '✅ Да + режим acceptEdits', '⛔ Нет']);
  assert.deepEqual(permissionOptions(), ['✅ Да', '⛔ Нет']);
});
test('describeSuggestion', () => {
  assert.equal(describeSuggestion({ type: 'setMode', mode: 'acceptEdits' }), '✅ Да + режим acceptEdits');
  assert.equal(describeSuggestion({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }),
    '✅ Да + не спрашивать: Bash(npm test:*)');
  assert.equal(describeSuggestion({ type: 'addRules', rules: [{ toolName: 'Read' }] }), '✅ Да + не спрашивать: Read');
  const long = describeSuggestion({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'x'.repeat(100) }] });
  assert.ok(long.length <= '✅ Да + не спрашивать: '.length + 40);
  assert.equal(describeSuggestion({ type: 'weird' }), '✅ Да + запомнить');
  assert.equal(describeSuggestion(null), '✅ Да + запомнить');
});
