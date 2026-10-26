import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/sessions.mjs';
import { handleHookEvent } from '../src/events.mjs';
import { handleUpdate } from '../src/router.mjs';
import { PLAN_FEEDBACK_INDEX } from '../src/keys.mjs';

const FIX = new URL('./fixtures/hooks/', import.meta.url);
const fx = (name, patch = {}) => ({ ...JSON.parse(readFileSync(new URL(`${name}.json`, FIX), 'utf8')), ...patch });
const SID = fx('SessionStart').session_id;
const SID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const B = { session_id: SID_B, cwd: 'C:\\Projects\\other' };
const USER = 777;
const STRANGER = 666;
const T0 = 1_000_000;

// Daemon stand-in: runs hook events / updates and "delivers" sends like the executor would.
function harness() {
  const store = new Store();
  let nextMsg = 100;
  let nextUpd = 1;
  const deliver = (effects) => {
    for (const e of effects) {
      if (e.type !== 'send') continue;
      const id = nextMsg++;
      e.messageId = id;
      if (e.bind) {
        // Executor contract: bind.prompt → binding only, never pushed into dialog.messageIds.
        const { prompt, ...binding } = e.bind;
        store.bindMessage(id, binding);
        if (binding.dialogId && !prompt) store.getDialog(binding.dialogId).messageIds.push(id);
      }
    }
    return effects;
  };
  const hook = (name, { at = T0, patch = {}, ...extra } = {}) => {
    const payload = fx(name, patch);
    return deliver(handleHookEvent(store, { event: payload.hook_event_name, payload, ...extra }, at));
  };
  const upd = (update, { userId = USER, now = T0 + 1000 } = {}) => deliver(handleUpdate(store, update, { userId, now }));
  const text = (t, { from = USER, replyTo, chatType = 'private' } = {}) => {
    const message = { message_id: nextMsg++, from: { id: from }, chat: { id: from, type: chatType }, text: t };
    if (replyTo != null) message.reply_to_message = { message_id: replyTo, from: { id: 1 }, chat: { id: from, type: chatType } };
    return { update_id: nextUpd++, message };
  };
  const cb = (data, { from = USER, messageId = 1 } = {}) => ({
    update_id: nextUpd++,
    callback_query: { id: `cb${nextUpd}`, from: { id: from }, message: { message_id: messageId, chat: { id: from, type: 'private' } }, data },
  });
  return { store, hook, upd, text, cb };
}

const started = () => {
  const h = harness();
  h.hook('SessionStart', { claudePid: 4242, branch: 'main' });
  return h;
};
const twoSessions = () => {
  const h = started();
  h.hook('SessionStart', { patch: B, claudePid: 5555, branch: 'dev', at: T0 + 1 });
  return h;
};
const lastDialog = (store) => [...store.dialogs.values()].at(-1);
const ofType = (eff, type) => eff.filter(e => e.type === type);
const injects = (eff) => ofType(eff, 'inject');
const sends = (eff) => ofType(eff, 'send');

// ---------- RF-1 allowlist ----------

test('RF-1: stranger message, button, /status, reply → []', () => {
  const h = started();
  const [ask] = h.hook('PreToolUse-Ask-single');
  const d = lastDialog(h.store);
  assert.deepEqual(h.upd(h.text('hello', { from: STRANGER })), []);
  assert.deepEqual(h.upd(h.text('/status', { from: STRANGER })), []);
  assert.deepEqual(h.upd(h.text('/stop', { from: STRANGER })), []);
  assert.deepEqual(h.upd(h.text('x', { from: STRANGER, replyTo: ask.messageId })), []);
  assert.deepEqual(h.upd(h.cb(`a|${d.id}|0|1`, { from: STRANGER })), []);
  assert.equal(d.status, 'open');
  assert.deepEqual(d.answers, []);
  assert.equal(h.store.pendingRoute, null);
});

test('RF-1: non-private chat, missing userId → []', () => {
  const h = started();
  assert.deepEqual(h.upd(h.text('/status', { chatType: 'group' })), []);
  assert.deepEqual(h.upd(h.text('/status'), { userId: null }), []);
  const u = h.cb('x|abcdefgh');
  u.callback_query.message.chat.type = 'supergroup';
  assert.deepEqual(h.upd(u), []);
  const noMsg = h.cb('x|abcdefgh');
  delete noMsg.callback_query.message;
  assert.deepEqual(h.upd(noMsg), []);
  assert.deepEqual(h.upd({ update_id: 9 }), []);
});

// ---------- RF-2 closed dialog ----------

test('RF-2: button on a dialog closed by terminal → only answerCallback', () => {
  const h = started();
  h.hook('PreToolUse-Ask-single');
  const d = lastDialog(h.store);
  h.hook('PostToolUse-Ask-other', { patch: { tool_use_id: d.toolUseId } });
  assert.equal(d.status, 'closed');
  const u = h.cb(`a|${d.id}|0|1`);
  const eff = h.upd(u);
  assert.deepEqual(eff, [{ type: 'answerCallback', callbackId: u.callback_query.id, text: 'Вопрос уже закрыт' }]);
  assert.deepEqual(h.upd(h.cb('a|zzzzzz|0|1')).map(e => e.type), ['answerCallback']);
});

test('button on already injected dialog → answerCallback "Ответ уже отправлен" only', () => {
  const h = started();
  h.hook('PreToolUse-Ask-single');
  const d = lastDialog(h.store);
  h.upd(h.cb(`a|${d.id}|0|2`));
  assert.equal(d.status, 'injected');
  const eff = h.upd(h.cb(`a|${d.id}|0|1`));
  assert.equal(eff.length, 1);
  assert.equal(eff[0].text, 'Ответ уже отправлен');
});

// ---------- ask flows ----------

test('a|dlg|0|2 on single question → inject [{text:"2"}] with verify, edit ✔', () => {
  const h = started();
  const [send] = h.hook('PreToolUse-Ask-single');
  const d = lastDialog(h.store);
  const u = h.cb(`a|${d.id}|0|2`);
  const eff = h.upd(u);
  assert.deepEqual(eff[0], { type: 'answerCallback', callbackId: u.callback_query.id });
  assert.deepEqual(injects(eff), [{ type: 'inject', sessionId: SID, steps: [{ text: '2' }], verify: { dialogId: d.id, timeoutMs: 10000 } }]);
  const [edit] = ofType(eff, 'edit');
  assert.equal(edit.messageId, send.messageId);
  assert.equal(edit.keyboard, null);
  assert.match(edit.text, /✔ выбрано: /);
  assert.equal(d.status, 'injected');
  assert.equal(d.source, 'telegram');
  assert.deepEqual(d.answers, [{ kind: 'option', index: 1 }]);
});

test('two questions: first answer sends next question, second injects one sequence', () => {
  const h = started();
  const [first] = h.hook('PreToolUse-Ask-two');
  const d = lastDialog(h.store);
  const e1 = h.upd(h.cb(`a|${d.id}|0|3`));
  assert.equal(injects(e1).length, 0);
  const [edit1] = ofType(e1, 'edit');
  assert.equal(edit1.messageId, first.messageId);
  assert.match(edit1.text, /✔ выбрано: Синий/);
  const [next] = sends(e1);
  assert.match(next.text, /\(2\/2\)/);
  assert.match(next.text, /Размер/);
  assert.deepEqual(next.bind, { sessionId: SID, dialogId: d.id });
  assert.equal(next.keyboard[0][0].callback_data, `a|${d.id}|1|1`);
  assert.equal(d.cursor, 1);
  assert.equal(d.text, next.text);
  assert.equal(d.status, 'open');

  // stale button from question 0
  const stale = h.upd(h.cb(`a|${d.id}|0|1`));
  assert.deepEqual(stale.map(e => e.type), ['answerCallback']);
  assert.equal(stale[0].text, 'Этот вопрос уже пройден');

  const e2 = h.upd(h.cb(`a|${d.id}|1|4`));
  assert.equal(sends(e2).length, 0);
  assert.deepEqual(injects(e2), [{
    type: 'inject', sessionId: SID,
    steps: [{ text: '3' }, { sleep: 400 }, { text: '4' }, { sleep: 400 }, { key: 'ENTER' }],
    verify: { dialogId: d.id, timeoutMs: 10000 },
  }]);
  const [edit2] = ofType(e2, 'edit');
  assert.equal(edit2.messageId, next.messageId);
  assert.match(edit2.text, /✔ выбрано: XL/);
  assert.equal(d.status, 'injected');
});

test('multi: toggle edits keyboard, empty submit refused, submit injects', () => {
  const h = started();
  const [send] = h.hook('PreToolUse-Ask-multi');
  const d = lastDialog(h.store);
  const empty = h.upd(h.cb(`s|${d.id}|0`));
  assert.deepEqual(empty.map(e => e.type), ['answerCallback']);
  assert.equal(empty[0].text, 'Выберите хотя бы один вариант');

  const t1 = h.upd(h.cb(`t|${d.id}|0|3`));
  const [ed] = ofType(t1, 'edit');
  assert.equal(ed.messageId, send.messageId);
  assert.equal(ed.text, d.text);
  assert.equal(ed.keyboard[0][2].text, '☑ 3');
  assert.equal(ed.keyboard[0][0].text, '☐ 1');
  h.upd(h.cb(`t|${d.id}|0|1`));
  h.upd(h.cb(`t|${d.id}|0|2`));
  const t4 = h.upd(h.cb(`t|${d.id}|0|2`)); // untoggle
  assert.equal(ofType(t4, 'edit')[0].keyboard[0][1].text, '☐ 2');
  assert.deepEqual([...d.multi].sort(), [0, 2]);

  const eff = h.upd(h.cb(`s|${d.id}|0`));
  assert.deepEqual(d.answers, [{ kind: 'multi', indexes: [0, 2] }]);
  assert.deepEqual(injects(eff)[0].steps, [
    { text: '1' }, { text: '3' }, { key: 'DOWN' }, { key: 'DOWN' }, { key: 'DOWN' }, { key: 'DOWN' }, { key: 'DOWN' },
    { key: 'ENTER' }, { sleep: 400 }, { key: 'ENTER' },
  ]);
  assert.match(ofType(eff, 'edit')[0].text, /✔ выбрано: Python, Rust/);
});

test('"Другое" via force-reply → text injected as other answer', () => {
  const h = started();
  const [question] = h.hook('PreToolUse-Ask-single');
  const d = lastDialog(h.store);
  const eff = h.upd(h.cb(`o|${d.id}|0`));
  const [prompt] = sends(eff);
  assert.equal(prompt.text, '✏️ Напишите свой вариант ответа');
  assert.equal(prompt.forceReply, true);
  assert.deepEqual(prompt.bind, { sessionId: SID, dialogId: d.id, prompt: true });
  assert.deepEqual(d.messageIds, [question.messageId]);
  assert.equal(h.store.pendingOther, d.id);

  const e2 = h.upd(h.text('Фиолетовый', { replyTo: prompt.messageId }));
  assert.deepEqual(d.answers, [{ kind: 'other', text: 'Фиолетовый' }]);
  const n = d.payload.questions[0].options.length;
  assert.deepEqual(injects(e2)[0].steps, [
    ...Array.from({ length: n }, () => ({ key: 'DOWN' })), { text: 'Фиолетовый' }, { sleep: 400 }, { key: 'ENTER' },
  ]);
  assert.deepEqual(injects(e2)[0].verify, { dialogId: d.id, timeoutMs: 10000 });
  assert.equal(h.store.pendingOther, null);
  assert.equal(d.status, 'injected');
  // the ✔ edit targets the original question message, not the force-reply prompt
  const [edit] = ofType(e2, 'edit');
  assert.equal(edit.messageId, question.messageId);
  assert.match(edit.text, /✔ выбрано: Фиолетовый/);
});

test('multi: t| after o| still edits the question message', () => {
  const h = started();
  const [question] = h.hook('PreToolUse-Ask-multi');
  const d = lastDialog(h.store);
  const [prompt] = sends(h.upd(h.cb(`o|${d.id}|0`)));
  assert.notEqual(prompt.messageId, question.messageId);
  const eff = h.upd(h.cb(`t|${d.id}|0|2`));
  const [edit] = ofType(eff, 'edit');
  assert.equal(edit.messageId, question.messageId);
  assert.equal(edit.keyboard[0][1].text, '☑ 2');
});

test('askSequence failure rolls back the answer, dialog stays open', () => {
  const h = started();
  h.hook('PreToolUse-Ask-two');
  const d = lastDialog(h.store);
  h.upd(h.cb(`a|${d.id}|0|1`));
  d.answers[0] = { kind: 'bogus' }; // corrupt earlier answer → askSequence throws
  const eff = h.upd(h.cb(`a|${d.id}|1|2`));
  assert.equal(injects(eff).length, 0);
  assert.match(sends(eff)[0].text, /Не удалось собрать ответ/);
  assert.equal(d.answers.length, 1);
  assert.equal(d.cursor, 1);
  assert.equal(d.status, 'open');
  assert.equal(ofType(eff, 'edit').length, 0);
});

test('plain text (no reply) while ask open → other answer for current question', () => {
  const h = started();
  h.hook('PreToolUse-Ask-two');
  const d = lastDialog(h.store);
  const e1 = h.upd(h.text('Бирюзовый'));
  assert.deepEqual(d.answers, [{ kind: 'other', text: 'Бирюзовый' }]);
  assert.equal(injects(e1).length, 0);
  assert.equal(d.cursor, 1);
  assert.match(sends(e1)[0].text, /\(2\/2\)/);
  const e2 = h.upd(h.cb(`a|${d.id}|1|1`));
  assert.deepEqual(injects(e2)[0].steps, [
    { key: 'DOWN' }, { key: 'DOWN' }, { key: 'DOWN' }, { text: 'Бирюзовый' }, { sleep: 400 }, { key: 'ENTER' },
    { sleep: 400 }, { text: '1' }, { sleep: 400 }, { key: 'ENTER' },
  ]);
});

test('text while ask is injected → "обрабатывается", no inject', () => {
  const h = started();
  h.hook('PreToolUse-Ask-single');
  const d = lastDialog(h.store);
  h.upd(h.cb(`a|${d.id}|0|1`));
  const eff = h.upd(h.text('ещё'));
  assert.equal(injects(eff).length, 0);
  assert.match(sends(eff)[0].text, /обрабатывается/);
});

// ---------- plan / perm ----------

test('plan option 1 → inject planSequence with verify; feedback via force-reply text', () => {
  const h = started();
  const [send] = h.hook('PreToolUse-ExitPlanMode');
  const d = lastDialog(h.store);
  const eff = h.upd(h.cb(`p|${d.id}|1`));
  assert.deepEqual(injects(eff), [{ type: 'inject', sessionId: SID, steps: [{ text: '1' }], verify: { dialogId: d.id, timeoutMs: 10000 } }]);
  const [edit] = ofType(eff, 'edit');
  assert.equal(edit.messageId, send.messageId);
  assert.equal(edit.keyboard, null);
  assert.match(edit.text, /✔ выбрано: ✅ Да, auto mode/);
  assert.equal(d.status, 'injected');
  assert.equal(d.source, 'telegram');
});

test('plan "Изменить план" → force-reply, then text → planSequence(feedback, text) no verify', () => {
  const h = started();
  const [plan] = h.hook('PreToolUse-ExitPlanMode');
  const d = lastDialog(h.store);
  const eff = h.upd(h.cb(`p|${d.id}|${PLAN_FEEDBACK_INDEX + 1}`));
  assert.equal(injects(eff).length, 0);
  const [prompt] = sends(eff);
  assert.equal(prompt.text, '✏️ Напишите, что изменить в плане');
  assert.equal(prompt.forceReply, true);
  assert.equal(prompt.bind.prompt, true);
  assert.equal(h.store.pendingOther, d.id);
  const e2 = h.upd(h.text('добавь тесты', { replyTo: prompt.messageId }));
  assert.deepEqual(injects(e2), [{ type: 'inject', sessionId: SID, steps: [{ text: '3' }, { text: 'добавь тесты' }, { sleep: 400 }, { key: 'ENTER' }] }]);
  assert.equal(ofType(e2, 'edit')[0].messageId, plan.messageId);
  assert.match(ofType(e2, 'edit')[0].text, /✔ выбрано: правки: добавь тесты/);
  assert.equal(d.status, 'injected');
  assert.equal(h.store.pendingOther, null);
});

test('plain text while plan open → plan feedback', () => {
  const h = started();
  h.hook('PreToolUse-ExitPlanMode');
  const d = lastDialog(h.store);
  const eff = h.upd(h.text('короче'));
  assert.deepEqual(injects(eff)[0].steps, [{ text: '3' }, { text: 'короче' }, { sleep: 400 }, { key: 'ENTER' }]);
  assert.equal(injects(eff)[0].verify, undefined);
  assert.equal(d.status, 'injected');
});

test('perm "Да" → verify; perm "Нет" (last option) → no verify', () => {
  const h = started();
  h.hook('PermissionRequest-Write');
  const d = lastDialog(h.store);
  assert.equal(d.options.length, 3);
  const yes = h.upd(h.cb(`p|${d.id}|1`));
  assert.deepEqual(injects(yes)[0], { type: 'inject', sessionId: SID, steps: [{ text: '1' }], verify: { dialogId: d.id, timeoutMs: 10000 } });

  const h2 = started();
  h2.hook('PermissionRequest-Write');
  const d2 = lastDialog(h2.store);
  const no = h2.upd(h2.cb(`p|${d2.id}|3`));
  assert.deepEqual(injects(no), [{ type: 'inject', sessionId: SID, steps: [{ text: '3' }] }]);
  assert.match(ofType(no, 'edit')[0].text, /✔ выбрано: ⛔ Нет/);
  assert.equal(d2.status, 'injected');
});

test('RF-3: text while perm dialog open → no inject, "ответьте кнопками"', () => {
  const h = started();
  const [perm] = h.hook('PermissionRequest-Write');
  for (const u of [h.text('да давай'), h.text('да', { replyTo: perm.messageId })]) {
    const eff = h.upd(u);
    assert.equal(injects(eff).length, 0);
    assert.equal(eff.length, 1);
    assert.match(eff[0].text, /ответьте кнопками/);
  }
  assert.equal(lastDialog(h.store).status, 'open');
});

// ---------- routing ----------

test('one live session, no dialog → instruction inject + "Отправлено" reply', () => {
  const h = started();
  const u = h.text('сделай рефакторинг');
  const eff = h.upd(u);
  assert.deepEqual(injects(eff), [{ type: 'inject', sessionId: SID, steps: [{ text: 'сделай рефакторинг' }, { sleep: 400 }, { key: 'ENTER' }] }]);
  const [s] = sends(eff);
  assert.equal(s.text, '➡️ Отправлено в ' + h.store.labelOf(SID));
  assert.equal(s.replyTo, u.message.message_id);
  assert.deepEqual(s.bind, { sessionId: SID });
});

test('no sessions → "Нет активных сессий"', () => {
  const h = harness();
  const eff = h.upd(h.text('привет'));
  assert.deepEqual(eff.map(e => e.text), ['Нет активных сессий']);
});

test('two sessions + text without reply → pendingRoute + picker; r| injects into chosen', () => {
  const h = twoSessions();
  const u = h.text('запусти тесты');
  const eff = h.upd(u, { now: T0 + 50 });
  assert.equal(injects(eff).length, 0);
  const [pick] = sends(eff);
  assert.equal(pick.text, 'В какую сессию отправить?');
  assert.equal(pick.keyboard.length, 2);
  assert.deepEqual(h.store.pendingRoute?.text, 'запусти тесты');
  assert.equal(h.store.pendingRoute.createdAt, T0 + 50);
  const btnB = pick.keyboard.flat().find(b => b.callback_data === `r|${SID_B.slice(0, 8)}|${u.message.message_id}`);
  assert.ok(btnB);

  const e2 = h.upd(h.cb(btnB.callback_data, { messageId: pick.messageId }));
  assert.equal(e2[0].type, 'answerCallback');
  assert.deepEqual(injects(e2), [{ type: 'inject', sessionId: SID_B, steps: [{ text: 'запусти тесты' }, { sleep: 400 }, { key: 'ENTER' }] }]);
  const [ed] = ofType(e2, 'edit');
  assert.deepEqual(ed, { type: 'edit', messageId: pick.messageId, text: '➡️ ' + h.store.labelOf(SID_B), keyboard: null });
  assert.equal(h.store.pendingRoute, null);
  // second press → stale
  const e3 = h.upd(h.cb(btnB.callback_data));
  assert.deepEqual(e3.map(e => e.type), ['answerCallback']);
  assert.equal(e3[0].text, 'Устарело');
});

test('r| from an older picker (msgKey mismatch) → "Устарело"; current picker routes text2', () => {
  const h = twoSessions();
  const [pick1] = sends(h.upd(h.text('текст 1')));
  const [pick2] = sends(h.upd(h.text('текст 2')));
  const old = pick1.keyboard.flat().find(b => b.callback_data.startsWith(`r|${SID_B.slice(0, 8)}|`));
  const stale = h.upd(h.cb(old.callback_data, { messageId: pick1.messageId }));
  assert.deepEqual(stale.map(e => e.type), ['answerCallback']);
  assert.equal(stale[0].text, 'Устарело');
  assert.equal(h.store.pendingRoute.text, 'текст 2');
  const cur = pick2.keyboard.flat().find(b => b.callback_data.startsWith(`r|${SID_B.slice(0, 8)}|`));
  const eff = h.upd(h.cb(cur.callback_data, { messageId: pick2.messageId }));
  assert.deepEqual(injects(eff), [{ type: 'inject', sessionId: SID_B, steps: [{ text: 'текст 2' }, { sleep: 400 }, { key: 'ENTER' }] }]);
  assert.equal(h.store.pendingRoute, null);
});

test('reply to a message of session B → inject into B', () => {
  const h = twoSessions();
  // a bound message of session B (e.g. completion summary)
  h.store.bindMessage(555, { sessionId: SID_B });
  const eff = h.upd(h.text('продолжай', { replyTo: 555 }));
  assert.equal(injects(eff).length, 1);
  assert.equal(injects(eff)[0].sessionId, SID_B);
  assert.equal(h.store.pendingRoute, null);
});

test('reply to message of a removed session → "Сессия завершена"', () => {
  const h = twoSessions();
  h.store.bindMessage(556, { sessionId: SID_B });
  h.hook('SessionEnd', { patch: B });
  const eff = h.upd(h.text('эй', { replyTo: 556 }));
  assert.deepEqual(eff.map(e => e.text), ['Сессия завершена']);
});

test('plain text with pendingOther targets its session even with two sessions', () => {
  const h = twoSessions();
  h.hook('PreToolUse-Ask-single', { patch: B });
  const d = lastDialog(h.store);
  h.upd(h.cb(`o|${d.id}|0`));
  const eff = h.upd(h.text('свой'));
  assert.equal(injects(eff)[0].sessionId, SID_B);
  assert.deepEqual(d.answers, [{ kind: 'other', text: 'свой' }]);
});

// ---------- commands ----------

test('/status → statusText of live sessions', () => {
  const h = twoSessions();
  const eff = h.upd(h.text('/status@my_bot'));
  assert.equal(eff.length, 1);
  assert.match(eff[0].text, /tg-spike · main/);
  assert.match(eff[0].text, /other · dev/);
});

test('/stop with one session → inject ESC + "Остановлено"', () => {
  const h = started();
  const eff = h.upd(h.text('/stop'));
  assert.deepEqual(injects(eff), [{ type: 'inject', sessionId: SID, steps: [{ key: 'ESC' }] }]);
  assert.equal(sends(eff)[0].text, '⏹ Остановлено: ' + h.store.labelOf(SID));
});

test('/stop with 0 sessions → "Нет активных сессий"', () => {
  const h = harness();
  assert.deepEqual(h.upd(h.text('/stop')).map(e => e.text), ['Нет активных сессий']);
});

test('/stop with two sessions → picker; x| → ESC into chosen', () => {
  const h = twoSessions();
  const eff = h.upd(h.text('/stop'));
  assert.equal(injects(eff).length, 0);
  const [pick] = sends(eff);
  assert.equal(pick.text, 'Какую сессию остановить?');
  const btn = pick.keyboard.flat().find(b => b.callback_data === `x|${SID.slice(0, 8)}`);
  assert.ok(btn);
  const e2 = h.upd(h.cb(btn.callback_data));
  assert.equal(e2[0].type, 'answerCallback');
  assert.deepEqual(injects(e2), [{ type: 'inject', sessionId: SID, steps: [{ key: 'ESC' }] }]);
  assert.equal(sends(e2)[0].text, '⏹ Остановлено: ' + h.store.labelOf(SID));
  const gone = h.upd(h.cb('x|deadbeef'));
  assert.deepEqual(gone.map(e => e.type), ['answerCallback']);
  assert.equal(gone[0].text, 'Сессия завершена');
});

test('/help and /start → help text, no inject', () => {
  const h = started();
  for (const c of ['/help', '/start']) {
    const eff = h.upd(h.text(c));
    assert.equal(eff.length, 1);
    assert.match(eff[0].text, /\/status/);
    assert.match(eff[0].text, /reply/);
  }
});

test('non-text message → "Поддерживается только текст"', () => {
  const h = started();
  const u = h.text('x');
  delete u.message.text;
  u.message.photo = [{ file_id: 'f' }];
  assert.deepEqual(h.upd(u).map(e => e.text), ['Поддерживается только текст']);
});
