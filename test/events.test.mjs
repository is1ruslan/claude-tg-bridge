import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/sessions.mjs';
import { handleHookEvent } from '../src/events.mjs';
import { PLAN_OPTIONS } from '../src/keys.mjs';

const FIX = new URL('./fixtures/hooks/', import.meta.url);
const fx = (name, patch = {}) => ({ ...JSON.parse(readFileSync(new URL(`${name}.json`, FIX), 'utf8')), ...patch });
const SID = fx('SessionStart').session_id;
const T0 = 1_000_000;

// Minimal daemon stand-in: runs handleHookEvent and "delivers" sends that bind a dialog.
function harness() {
  const store = new Store();
  let nextMsg = 100;
  const run = (name, { at = T0, patch = {}, event, ...extra } = {}) => {
    const payload = fx(name, patch);
    const effects = handleHookEvent(store, { event: event ?? payload.hook_event_name, payload, ...extra }, at);
    for (const e of effects) {
      if (e.type === 'send' && e.bind?.dialogId) {
        const id = nextMsg++;
        e.messageId = id;
        store.getDialog(e.bind.dialogId).messageIds.push(id);
      }
    }
    return effects;
  };
  return { store, run };
}

const started = () => {
  const h = harness();
  h.run('SessionStart', { claudePid: 4242, branch: 'main' });
  return h;
};
const dialogs = (store) => [...store.dialogs.values()];

test('SessionStart upserts session idle with pid/project/branch, no effects', () => {
  const h = harness();
  const eff = h.run('SessionStart', { claudePid: 4242, branch: 'main' });
  assert.deepEqual(eff, []);
  const s = h.store.getSession(SID);
  assert.equal(s.pid, 4242);
  assert.equal(s.project, 'tg-spike');
  assert.equal(s.branch, 'main');
  assert.equal(s.cwd, 'C:\\Projects\\tg-spike');
  assert.equal(s.state, 'idle');
  assert.equal(s.lastActivityAt, T0);
});

test('unknown session is created on the fly from payload.cwd', () => {
  const h = harness();
  h.run('UserPromptSubmit', { at: T0 + 5 });
  const s = h.store.getSession(SID);
  assert.ok(s);
  assert.equal(s.project, 'tg-spike');
  assert.equal(s.branch, '—');
  assert.equal(s.pid, null);
  assert.equal(s.state, 'working');
  assert.equal(s.lastPromptAt, T0 + 5);
});

test('bookkeeping updates pid/branch/lastActivityAt on every event', () => {
  const h = started();
  h.run('UserPromptSubmit', { at: T0 + 10, claudePid: 999, branch: 'dev' });
  const s = h.store.getSession(SID);
  assert.equal(s.pid, 999);
  assert.equal(s.branch, 'dev');
  assert.equal(s.lastActivityAt, T0 + 10);
  h.run('Stop', { at: T0 + 20 });
  assert.equal(s.pid, 999);
  assert.equal(h.store.getSession(SID).lastActivityAt, T0 + 20);
});

test('PermissionRequest for AskUserQuestion / ExitPlanMode is ignored', () => {
  const h = started();
  assert.deepEqual(h.run('PermissionRequest-Ask'), []);
  assert.deepEqual(h.run('PermissionRequest-ExitPlanMode'), []);
  assert.equal(h.store.dialogs.size, 0);
});

test('PermissionRequest-Write sends perm dialog with 3 buttons and binds it', () => {
  const h = started();
  const eff = h.run('PermissionRequest-Write');
  assert.equal(eff.length, 1);
  const [send] = eff;
  assert.equal(send.type, 'send');
  const d = h.store.getDialog(send.bind.dialogId);
  assert.deepEqual(send.bind, { sessionId: SID, dialogId: d.id });
  assert.equal(d.kind, 'perm');
  assert.equal(d.toolUseId, null);
  assert.deepEqual(d.options, ['✅ Да', '✅ Да + режим acceptEdits', '⛔ Нет']);
  assert.equal(send.keyboard.flat().length, 3);
  assert.deepEqual(send.keyboard.flat().map(b => b.callback_data), [1, 2, 3].map(k => `p|${d.id}|${k}`));
  assert.match(send.text, /Разрешение: <b>Write<\/b>/);
  assert.match(send.text, /hello\.txt/);
  assert.equal(d.text, send.text);
  assert.equal(h.store.getSession(SID).state, 'waiting');
});

test('perm dialog rejected (No) is closed terminal by a later PreToolUse of another tool', () => {
  const h = started();
  const [send] = h.run('PermissionRequest-Write');
  const eff = h.run('PreToolUse-Ask-single');
  const d = h.store.getDialog(send.bind.dialogId);
  assert.equal(d.status, 'closed');
  assert.equal(d.closedReason, 'terminal');
  const edits = eff.filter(e => e.type === 'edit');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageId, send.messageId);
  assert.equal(edits[0].keyboard, null);
  assert.equal(edits[0].text, send.text + '\n\n✔ отвечено в терминале');
  // and the new ask was still sent
  assert.equal(eff.filter(e => e.type === 'send').length, 1);
});

test('PreToolUse-Write → PermissionRequest-Write → PostToolUse-Write: one perm dialog, closed terminal, one edit', () => {
  const h = started();
  const pre = fx('PreToolUse-Write');
  const perm = fx('PermissionRequest-Write', { tool_input: pre.tool_input });
  const post = fx('PostToolUse-Write');
  const all = [];
  for (const p of [pre, perm, post]) {
    const eff = handleHookEvent(h.store, { event: p.hook_event_name, payload: p }, T0);
    for (const e of eff) if (e.bind?.dialogId) h.store.getDialog(e.bind.dialogId).messageIds.push(777);
    all.push(...eff);
  }
  const ds = dialogs(h.store);
  assert.equal(ds.length, 1);
  assert.equal(ds[0].kind, 'perm');
  assert.equal(ds[0].status, 'closed');
  assert.equal(ds[0].closedReason, 'terminal');
  const edits = all.filter(e => e.type === 'edit');
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /✔ отвечено в терминале$/);
  assert.equal(h.store.getSession(SID).state, 'working');
});

test('async reorder: PermissionRequest before its own PreToolUse does not close the perm dialog', () => {
  const h = started();
  const pre = fx('PreToolUse-Write');
  const perm = fx('PermissionRequest-Write', { tool_input: pre.tool_input });
  handleHookEvent(h.store, { event: 'PermissionRequest', payload: perm }, T0);
  const eff = handleHookEvent(h.store, { event: 'PreToolUse', payload: pre }, T0);
  assert.deepEqual(eff, []);
  assert.equal(dialogs(h.store)[0].status, 'open');
  assert.equal(h.store.getSession(SID).state, 'waiting');
});

test('R2: PreToolUse of a non-dialog tool sets state working (other call closes perm)', () => {
  const h = started();
  h.run('PermissionRequest-Write'); // input differs from PreToolUse-Write fixture
  assert.equal(h.store.getSession(SID).state, 'waiting');
  const eff = h.run('PreToolUse-Write');
  assert.equal(eff.filter(e => e.type === 'edit').length, 1);
  assert.equal(h.store.getSession(SID).state, 'working');
});

test('R3: PostToolUse of a different tool does not close a perm dialog', () => {
  const h = started();
  const [send] = h.run('PermissionRequest-Write');
  const eff = h.run('PostToolUse-Write', { patch: { tool_name: 'Bash', tool_input: { command: 'ls' } } });
  assert.deepEqual(eff, []);
  assert.equal(h.store.getDialog(send.bind.dialogId).status, 'open');
});

test('R3: PostToolUse finds the older perm of its tool even when a newer perm of another tool exists', () => {
  const h = started();
  const [w] = h.run('PermissionRequest-Write');
  const [b] = h.run('PermissionRequest-Write', { patch: { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [] } });
  const eff = h.run('PostToolUse-Write');
  assert.equal(h.store.getDialog(w.bind.dialogId).closedReason, 'terminal');
  assert.equal(h.store.getDialog(b.bind.dialogId).status, 'open');
  assert.equal(eff.length, 1);
  assert.equal(eff[0].messageId, w.messageId);
});

test('R3: injected perm preferred over a newer open perm of the same tool', () => {
  const h = started();
  const [a] = h.run('PermissionRequest-Write');
  const [b] = h.run('PermissionRequest-Write', { patch: { tool_input: { file_path: 'C:\\other.txt', content: '' } } });
  h.store.getDialog(a.bind.dialogId).status = 'injected';
  h.run('PostToolUse-Write');
  assert.equal(h.store.getDialog(a.bind.dialogId).closedReason, 'terminal');
  assert.equal(h.store.getDialog(b.bind.dialogId).status, 'open');
});

test('PreToolUse Ask single → 1 send with 3+Другое buttons and bind', () => {
  const h = started();
  const eff = h.run('PreToolUse-Ask-single');
  assert.equal(eff.length, 1);
  const [send] = eff;
  const d = h.store.getDialog(send.bind.dialogId);
  assert.deepEqual(send.bind, { sessionId: SID, dialogId: d.id });
  assert.equal(d.kind, 'ask');
  assert.equal(d.toolUseId, 'toolu_013bXpq3HWeScuExKtJKeKSP');
  assert.equal(d.payload.questions.length, 1);
  const btns = send.keyboard.flat();
  assert.equal(btns.length, 4);
  assert.deepEqual(btns.map(b => b.callback_data), [`a|${d.id}|0|1`, `a|${d.id}|0|2`, `a|${d.id}|0|3`, `o|${d.id}|0`]);
  assert.match(send.text, /Какой цвет\?/);
  assert.doesNotMatch(send.text, /\(1\/1\)/);
  assert.equal(d.text, send.text);
  assert.equal(h.store.getSession(SID).state, 'waiting');
});

test('PreToolUse Ask two → first question only, numbered (1/2)', () => {
  const h = started();
  const [send] = h.run('PreToolUse-Ask-two');
  assert.match(send.text, /\(1\/2\)/);
  assert.match(send.text, /Какой цвет\?/);
  assert.doesNotMatch(send.text, /Какой размер\?/);
});

test('PreToolUse Ask multi → toggle buttons + Другое + Отправить', () => {
  const h = started();
  const [send] = h.run('PreToolUse-Ask-multi');
  const d = h.store.getDialog(send.bind.dialogId);
  const data = send.keyboard.flat().map(b => b.callback_data);
  assert.deepEqual(data, [1, 2, 3, 4].map(k => `t|${d.id}|0|${k}`).concat([`o|${d.id}|0`, `s|${d.id}|0`]));
});

test('Ask answered in terminal: PostToolUse → closed terminal + edit', () => {
  const h = started();
  const [send] = h.run('PreToolUse-Ask-single');
  const eff = h.run('PostToolUse-Ask-other');
  const d = h.store.getDialog(send.bind.dialogId);
  assert.equal(d.status, 'closed');
  assert.equal(d.closedReason, 'terminal');
  assert.deepEqual(eff, [{ type: 'edit', messageId: send.messageId, text: send.text + '\n\n✔ отвечено в терминале', keyboard: null }]);
  assert.equal(h.store.getSession(SID).state, 'working');
});

test('Ask answered from Telegram, matching answer → closed telegram, no effects', () => {
  const h = started();
  const [send] = h.run('PreToolUse-Ask-two');
  const d = h.store.getDialog(send.bind.dialogId);
  d.source = 'telegram';
  d.answers = [{ kind: 'option', index: 1 }, { kind: 'option', index: 2 }];
  d.status = 'injected';
  const eff = h.run('PostToolUse-Ask-two');
  assert.deepEqual(eff, []);
  assert.equal(d.status, 'closed');
  assert.equal(d.closedReason, 'telegram');
});

test('Ask from Telegram: multi and other answers compared correctly', () => {
  const h = started();
  let [send] = h.run('PreToolUse-Ask-multi');
  let d = h.store.getDialog(send.bind.dialogId);
  Object.assign(d, { source: 'telegram', answers: [{ kind: 'multi', indexes: [2, 0] }] });
  assert.deepEqual(h.run('PostToolUse-Ask-multi'), []);

  [send] = h.run('PreToolUse-Ask-single');
  d = h.store.getDialog(send.bind.dialogId);
  Object.assign(d, { source: 'telegram', answers: [{ kind: 'other', text: 'Фиолетовый из Telegram' }] });
  assert.deepEqual(h.run('PostToolUse-Ask-other'), []);
});

test('Ask from Telegram with mismatching answer → ⚠ send', () => {
  const h = started();
  const [send] = h.run('PreToolUse-Ask-two');
  const d = h.store.getDialog(send.bind.dialogId);
  d.source = 'telegram';
  d.answers = [{ kind: 'option', index: 0 }, { kind: 'option', index: 2 }];
  const eff = h.run('PostToolUse-Ask-two');
  assert.equal(eff.length, 1);
  assert.equal(eff[0].type, 'send');
  assert.deepEqual(eff[0].bind, { sessionId: SID });
  assert.equal(eff[0].text, '📁 <b>tg-spike · main</b>\n⚠ в сессию ушло «Зелёный», а не «Красный» — проверьте терминал');
  assert.equal(d.closedReason, 'telegram');
});

test('Ask from Telegram: tool_response.answers missing the question key → mismatch check skipped', () => {
  const h = started();
  const [send] = h.run('PreToolUse-Ask-two');
  const d = h.store.getDialog(send.bind.dialogId);
  Object.assign(d, { source: 'telegram', answers: [{ kind: 'option', index: 0 }, { kind: 'option', index: 0 }] });
  const post = fx('PostToolUse-Ask-two');
  post.tool_response = { ...post.tool_response, answers: {} };
  const eff = handleHookEvent(h.store, { event: 'PostToolUse', payload: post }, T0);
  assert.deepEqual(eff, []);
  assert.equal(d.closedReason, 'telegram');
});

test('ExitPlanMode PreToolUse → plan dialog with PLAN_OPTIONS; PostToolUse closes terminal', () => {
  const h = started();
  const eff = h.run('PreToolUse-ExitPlanMode');
  assert.equal(eff.length, 1);
  const d = h.store.getDialog(eff[0].bind.dialogId);
  assert.equal(d.kind, 'plan');
  assert.equal(d.toolUseId, 'toolu_01H8zN4Z7tTvCYxZK1GiCL5B');
  assert.deepEqual(d.options, PLAN_OPTIONS);
  assert.match(eff[0].text, /План на подтверждение/);
  assert.deepEqual(eff[0].keyboard.flat().map(b => b.callback_data), [1, 2, 3].map(k => `p|${d.id}|${k}`));
  assert.deepEqual(h.run('PermissionRequest-ExitPlanMode'), []);
  // fixture tool_use_ids differ (separate captures) — fallback by kind still finds the plan
  const post = h.run('PostToolUse-ExitPlanMode');
  assert.equal(d.closedReason, 'terminal');
  assert.equal(post.length, 1);
  assert.equal(post[0].type, 'edit');
});

test('plan rejected (Изменить план) then repeated PreToolUse ExitPlanMode: old closed, new opened', () => {
  const h = started();
  const [first] = h.run('PreToolUse-ExitPlanMode');
  const eff = h.run('PreToolUse-ExitPlanMode', { patch: { tool_use_id: 'toolu_second' } });
  const old = h.store.getDialog(first.bind.dialogId);
  assert.equal(old.closedReason, 'terminal');
  assert.equal(eff.filter(e => e.type === 'edit').length, 1);
  const sends = eff.filter(e => e.type === 'send');
  assert.equal(sends.length, 1);
  assert.equal(h.store.getDialog(sends[0].bind.dialogId).status, 'open');
});

test('plan answered from Telegram closed by later event → telegram, no edit', () => {
  const h = started();
  const [first] = h.run('PreToolUse-ExitPlanMode');
  const d = h.store.getDialog(first.bind.dialogId);
  d.source = 'telegram';
  const eff = h.run('PreToolUse-Write');
  assert.deepEqual(eff, []);
  assert.equal(d.closedReason, 'telegram');
});

test('PostToolUse of another tool closes the open perm dialog as terminal', () => {
  const h = started();
  const [send] = h.run('PermissionRequest-Write');
  const eff = h.run('PostToolUse-Write');
  const d = h.store.getDialog(send.bind.dialogId);
  assert.equal(d.closedReason, 'terminal');
  assert.equal(eff.length, 1);
  assert.equal(eff[0].type, 'edit');
});

test('perm answered from Telegram: PostToolUse closes telegram, no edit', () => {
  const h = started();
  const [send] = h.run('PermissionRequest-Write');
  const d = h.store.getDialog(send.bind.dialogId);
  d.source = 'telegram';
  assert.deepEqual(h.run('PostToolUse-Write'), []);
  assert.equal(d.closedReason, 'telegram');
});

test('PostToolUse does not touch an ask dialog via the perm fallback', () => {
  const h = started();
  const [send] = h.run('PreToolUse-Ask-single');
  assert.deepEqual(h.run('PostToolUse-Write'), []);
  assert.equal(h.store.getDialog(send.bind.dialogId).status, 'open');
});

test('UserPromptSubmit with open ask dialog → stale edit', () => {
  const h = started();
  const [send] = h.run('PreToolUse-Ask-single');
  const eff = h.run('UserPromptSubmit', { at: T0 + 1 });
  const d = h.store.getDialog(send.bind.dialogId);
  assert.equal(d.closedReason, 'stale');
  assert.deepEqual(eff, [{ type: 'edit', messageId: send.messageId, text: send.text + '\n\n⌛ устарело', keyboard: null }]);
});

test('UserPromptSubmit with open perm dialog → terminal edit', () => {
  const h = started();
  h.run('PermissionRequest-Write');
  const eff = h.run('UserPromptSubmit');
  assert.equal(eff.length, 1);
  assert.match(eff[0].text, /✔ отвечено в терминале$/);
});

test('dialog without delivered message → closed but no edit', () => {
  const { store } = harness();
  handleHookEvent(store, { event: 'PreToolUse', payload: fx('PreToolUse-Ask-single') }, T0);
  const eff = handleHookEvent(store, { event: 'UserPromptSubmit', payload: fx('UserPromptSubmit') }, T0);
  assert.deepEqual(eff, []);
  assert.equal(dialogs(store)[0].closedReason, 'stale');
});

test('long dialog text → keyboard-only edit + reply send with suffix', () => {
  const h = started();
  const [send] = h.run('PermissionRequest-Write');
  const d = h.store.getDialog(send.bind.dialogId);
  d.text = 'x'.repeat(3901);
  const eff = h.run('PreToolUse-Ask-single');
  assert.deepEqual(eff[0], { type: 'edit', messageId: send.messageId, text: null, keyboard: null });
  assert.equal(eff[1].type, 'send');
  assert.equal(eff[1].text, '✔ отвечено в терминале');
  assert.equal(eff[1].replyTo, send.messageId);
});

test('Stop 30 s after UserPromptSubmit → no completion; 61 s → completion', () => {
  const h = started();
  h.run('UserPromptSubmit', { at: T0 });
  assert.deepEqual(h.run('Stop', { at: T0 + 30000 }), []);
  assert.equal(h.store.getSession(SID).state, 'idle');
  h.run('UserPromptSubmit', { at: T0 + 100000 });
  const eff = h.run('Stop', { at: T0 + 161000 });
  assert.deepEqual(eff, [{
    type: 'completion', sessionId: SID, lastMessage: fx('Stop').last_assistant_message, failed: false,
  }]);
});

test('Stop exactly at 60000 ms → completion; Stop without prompt → none', () => {
  const h = started();
  assert.deepEqual(h.run('Stop', { at: T0 + 999999 }), []);
  h.run('UserPromptSubmit', { at: T0 });
  assert.equal(h.run('Stop', { at: T0 + 60000 }).length, 1);
});

test('StopFailure → completion failed regardless of threshold', () => {
  const h = started();
  h.run('UserPromptSubmit', { at: T0 });
  const payload = { ...fx('Stop'), hook_event_name: 'StopFailure', error: 'rate_limit' };
  delete payload.last_assistant_message;
  const eff = handleHookEvent(h.store, { event: 'StopFailure', payload }, T0 + 1000);
  assert.deepEqual(eff, [{ type: 'completion', sessionId: SID, lastMessage: 'rate_limit', failed: true }]);
  assert.equal(h.store.getSession(SID).state, 'idle');
});

test('Stop closes hanging ask (stale) and perm (terminal) dialogs', () => {
  const h = started();
  h.run('PermissionRequest-Write');
  h.run('PreToolUse-Ask-single'); // closes perm already
  const [send] = h.run('PreToolUse-Ask-multi');
  const eff = h.run('Stop', { at: T0 + 1 });
  assert.ok(eff.some(e => e.type === 'edit' && e.messageId === send.messageId && /устарело$/.test(e.text)));
  assert.ok(dialogs(h.store).every(d => d.status === 'closed'));
});

test('SessionEnd removes session and edits hanging dialogs stale', () => {
  const h = started();
  const [send] = h.run('PreToolUse-Ask-single');
  const eff = h.run('SessionEnd', { patch: { session_id: SID } });
  assert.equal(h.store.getSession(SID), null);
  assert.deepEqual(eff, [{ type: 'edit', messageId: send.messageId, text: send.text + '\n\n⌛ устарело', keyboard: null }]);
});

test('events of one session do not affect another session', () => {
  const h = started();
  const OTHER = 'aaaaaaaa-0000-0000-0000-000000000000';
  const [send] = h.run('PermissionRequest-Write');
  const eff = h.run('PreToolUse-Ask-single', { patch: { session_id: OTHER } });
  assert.equal(h.store.getDialog(send.bind.dialogId).status, 'open');
  assert.equal(eff.length, 1);
  assert.equal(eff[0].bind.sessionId, OTHER);
  assert.deepEqual(h.run('UserPromptSubmit', { patch: { session_id: OTHER } }).length, 1);
  assert.equal(h.store.getDialog(send.bind.dialogId).status, 'open');
});
