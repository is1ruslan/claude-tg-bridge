// Keystroke sequences for Claude Code dialogs. Source of truth: docs/ui-keymap.md.
// Pure module: every function returns Step[] ({text}|{key}|{sleep}).
import { t } from './i18n.mjs';

const DOWN = { key: 'DOWN' };
const ENTER = { key: 'ENTER' };
const TAB_SLEEP = () => ({ sleep: 400 });

export const planOptions = () => [...t('planOptions')];
export const PLAN_FEEDBACK_INDEX = 2;

const downs = (n) => Array.from({ length: n }, () => DOWN);

function ruleLabel(s) {
  const r = Array.isArray(s?.rules) ? s.rules[0] : undefined;
  if (!r) return null;
  const base = r.toolName ?? '';
  const txt = r.ruleContent ? `${base}(${r.ruleContent})` : base;
  if (!txt) return null;
  return txt.length > 40 ? txt.slice(0, 39) + '…' : txt;
}

export function describeSuggestion(s) {
  if (s && s.type === 'setMode' && s.mode) return t('permMode', s.mode);
  const label = ruleLabel(s);
  if (label) return t('permRule', label);
  return t('permRemember');
}

export function permissionOptions(permission_suggestions = []) {
  return [t('permYes'), ...permission_suggestions.map(describeSuggestion), t('permNo')];
}

export const permissionSequence = (k) => [{ text: String(k + 1) }];

export function planSequence(k, text) {
  if (text === undefined) return [{ text: String(k + 1) }];
  return [{ text: String(k + 1) }, { text }, { sleep: 400 }, ENTER];
}

export const instructionSequence = (text) => [{ text }, { sleep: 400 }, ENTER];
export const stopSequence = () => [{ key: 'ESC' }];

// Unverified path (keymap: "не проверено"): custom answer inside a multiSelect question.
// Typing text ticks the row; Enter would untick it, so move to Submit with DOWN instead.
function multiOtherSteps(n, text) {
  return [...downs(n), { text }, { sleep: 400 }, DOWN, ENTER];
}

function checkIndex(i, n, what) {
  if (!Number.isInteger(i) || i < 0 || i >= n) throw new RangeError(`${what}: option index ${i} out of range [0, ${n})`);
}

function questionSteps(q, a, qi) {
  const n = q.options.length;
  const what = `question ${qi}`;
  if (a.kind === 'other') {
    return q.multiSelect ? multiOtherSteps(n, a.text) : [...downs(n), { text: a.text }, { sleep: 400 }, ENTER];
  }
  if (a.kind === 'option') {
    checkIndex(a.index, n, what);
    if (q.multiSelect) return [{ text: String(a.index + 1) }, ...downs(n + 1), ENTER];
    return [{ text: String(a.index + 1) }];
  }
  if (a.kind === 'multi') {
    for (const i of a.indexes) checkIndex(i, n, what);
    const sorted = [...new Set(a.indexes)].sort((x, y) => x - y);
    return [...sorted.map((i) => ({ text: String(i + 1) })), ...downs(n + 1), ENTER];
  }
  throw new RangeError(`${what}: unknown answer kind ${a.kind}`);
}

export function askSequence(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    throw new RangeError(`answers.length (${answers?.length}) !== questions.length (${questions.length})`);
  }
  const steps = [];
  questions.forEach((q, i) => {
    if (i > 0) steps.push(TAB_SLEEP());
    steps.push(...questionSteps(q, answers[i], i));
  });
  const hasReview = questions.length > 1 || questions[0]?.multiSelect === true;
  if (hasReview) steps.push({ sleep: 400 }, ENTER);
  return steps;
}
