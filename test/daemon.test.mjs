import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startDaemon } from '../src/daemon.mjs';
import { runSupervisor } from '../src/supervisor.mjs';
import { restrictToUser } from '../src/acl.mjs';
import { paths as mkPaths } from '../src/config.mjs';
import { TelegramError } from '../src/telegram.mjs';
import { PLAN_FEEDBACK_INDEX } from '../src/keys.mjs';
import { isClaudeAlive as realIsClaudeAlive } from '../src/procs.mjs';

const FIX = new URL('./fixtures/hooks/', import.meta.url);
const fx = (name, patch = {}) => ({ ...JSON.parse(fs.readFileSync(new URL(`${name}.json`, FIX), 'utf8')), ...patch });
const SID = fx('SessionStart').session_id;
const USER = 777;
const STRANGER = 666;
const CLAUDE_PID = 4242;

const silent = { info() {}, warn() {}, error() {} };

function recLog() {
  const lines = [];
  const w = (level) => (msg, data) => lines.push({ level, msg: String(msg), data });
  return { lines, info: w('info'), warn: w('warn'), error: w('error') };
}

async function waitFor(cond, ms = 3000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fakeTelegram() {
  let nextId = 100;
  const queue = [];
  const tg = {
    sent: [], edits: [], markups: [], answers: [], getUpdatesCalls: 0, failures: [],
    push(...u) { queue.push(...u); },
    async getUpdates(offset) {
      tg.getUpdatesCalls++;
      tg.lastOffset = offset;
      if (tg.failures.length) throw tg.failures.shift();
      if (queue.length) return queue.splice(0);
      await new Promise((r) => setTimeout(r, 15));
      return [];
    },
    async sendMessage(m) { const id = nextId++; tg.sent.push({ ...m, id }); return id; },
    async editMessage(m) { tg.edits.push(m); },
    async editMarkup(m) { tg.markups.push(m); },
    async answerCallback(id, text) { tg.answers.push({ id, text }); },
  };
  return tg;
}

function fakeProcs({ alive = () => true } = {}) {
  const p = {
    ancestorCalls: [], aliveCalls: [],
    async findAncestor(ppid) { p.ancestorCalls.push(ppid); return CLAUDE_PID; },
    async isClaudeAlive(pid) { p.aliveCalls.push(pid); return alive(pid); },
    async gitBranch() { return 'main'; },
  };
  return p;
}

function fakeInject(result = { ok: true }) {
  const i = { calls: [], async injectSteps(pid, steps) { i.calls.push({ pid, steps }); return result; } };
  return i;
}

async function setup(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-daemon-'));
  const paths = mkPaths(home);
  const telegram = opts.telegram ?? fakeTelegram();
  const procs = opts.procs ?? fakeProcs();
  const inject = opts.inject ?? fakeInject();
  const log = opts.log ?? silent;
  const d = await startDaemon({
    config: { token: '123:TOKENxyz', userId: USER, port: 0, ...opts.config },
    paths, telegram, inject, procs, log,
    summarize: opts.summarize ?? (async (t) => ({ status: 'done', summary: t })),
    port: 0,
    backoffBaseMs: 5,
    restrictToUser: async () => {},
    claudeVersion: async () => '2.1.310 (Claude Code)',
    pruneIntervalMs: 60_000,
    ...opts.extra,
  });
  const dj = d ? JSON.parse(fs.readFileSync(paths.daemonJson, 'utf8')) : null;
  const post = (body, secret = dj.secret) => fetch(`http://127.0.0.1:${d.port}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-cc-secret': secret } : {}) },
    body: JSON.stringify(body),
  });
  const hook = async (name, patch) => {
    const payload = fx(name, patch);
    const r = await post({ event: payload.hook_event_name, payload, ppid: 999 });
    assert.equal(r.status, 204);
  };
  return { home, paths, telegram, procs, inject, log, d, dj, post, hook };
}

const cb = (data, id = 'cb1', from = USER) => ({
  update_id: Math.floor(Math.random() * 1e6) + 10,
  callback_query: { id, from: { id: from }, data, message: { message_id: 100, chat: { id: from, type: 'private' } } },
});
const msg = (text, from = USER, extra = {}) => ({
  update_id: Math.floor(Math.random() * 1e6) + 10,
  message: { message_id: 500, from: { id: from }, chat: { id: from, type: 'private' }, text, ...extra },
});
const dlgOf = (send) => send.keyboard[0][0].callback_data.split('|')[1];
// Plain text always shows the session picker now: send it, then press the session's button.
async function pickSession(s, text) {
  const before = s.telegram.sent.filter((m) => m.text === 'Куда отправить?').length;
  s.telegram.push(msg(text));
  await waitFor(() => s.telegram.sent.filter((m) => m.text === 'Куда отправить?').length > before);
  s.telegram.push(cb(`r|${SID.slice(0, 8)}|500`, 'cbpick' + before));
}

test('daemon.json written with port, secret (32 hex), pid', async () => {
  const s = await setup();
  try {
    assert.equal(s.dj.port, s.d.port);
    assert.match(s.dj.secret, /^[0-9a-f]{32}$/);
    assert.equal(s.dj.pid, process.pid);
  } finally { await s.d.close(); }
});

test('POST /event without or with wrong secret -> 403; /health needs secret', async () => {
  const s = await setup();
  try {
    assert.equal((await s.post({ event: 'Stop', payload: {} }, null)).status, 403);
    assert.equal((await s.post({ event: 'Stop', payload: {} }, 'nope')).status, 403);
    const h0 = await fetch(`http://127.0.0.1:${s.d.port}/health`);
    assert.equal(h0.status, 403);
    const h = await fetch(`http://127.0.0.1:${s.d.port}/health`, { headers: { 'x-cc-secret': s.dj.secret } });
    assert.deepEqual(await h.json(), { ok: true, sessions: 0 });
    assert.equal(s.telegram.sent.length, 0);
  } finally { await s.d.close(); }
});

test('PreToolUse-Ask-single -> one sendMessage; callback a| -> injectSteps with pid from findAncestor', async () => {
  const s = await setup();
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-Ask-single');
    await waitFor(() => s.telegram.sent.length === 1);
    await s.d.idle();
    assert.equal(s.telegram.sent.length, 1);
    const sent = s.telegram.sent[0];
    assert.equal(sent.chatId, USER);
    assert.deepEqual(s.procs.ancestorCalls, [999]); // only once: pid stored after SessionStart
    const dlg = dlgOf(sent);
    s.telegram.push(cb(`a|${dlg}|0|2`));
    await waitFor(() => s.inject.calls.length === 1);
    assert.equal(s.inject.calls[0].pid, CLAUDE_PID);
    assert.ok(s.telegram.answers.some((a) => a.id === 'cb1'));
    await waitFor(() => s.telegram.edits.length === 1);
    assert.equal(s.telegram.edits[0].messageId, sent.id);
    const h = await fetch(`http://127.0.0.1:${s.d.port}/health`, { headers: { 'x-cc-secret': s.dj.secret } });
    assert.deepEqual(await h.json(), { ok: true, sessions: 1 });
  } finally { await s.d.close(); }
});

test('RF-1: updates from a stranger -> no Telegram calls, no inject, logged without text', async () => {
  const log = recLog();
  const s = await setup({ log });
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-Ask-single');
    await waitFor(() => s.telegram.sent.length === 1);
    await s.d.idle();
    const dlg = dlgOf(s.telegram.sent[0]);
    const aliveBefore = s.procs.aliveCalls.length;
    s.telegram.push(cb(`a|${dlg}|0|1`, 'cbX', STRANGER), msg('rm -rf secret-text', STRANGER), msg('/stop', STRANGER),
      msg('reply-secret-text', STRANGER, { reply_to_message: { message_id: s.telegram.sent[0].id } }));
    await waitFor(() => log.lines.filter((l) => l.msg === `ignored update from ${STRANGER}`).length === 4);
    await s.d.idle();
    assert.equal(s.telegram.sent.length, 1);
    assert.equal(s.telegram.answers.length, 0);
    assert.equal(s.telegram.edits.length + s.telegram.markups.length, 0);
    assert.equal(s.inject.calls.length, 0);
    assert.equal(s.procs.aliveCalls.length, aliveBefore);
    assert.ok(!JSON.stringify(log.lines).includes('secret-text'));
    assert.equal(s.d.store.getDialog(dlg).status, 'open');
  } finally { await s.d.close(); }
});

test('RF-5: isClaudeAlive false at inject time -> no inject, "Сессия завершена" sent', async () => {
  let n = 0;
  // alive for the pre-update prune, dead at the inject check (pid reused / process died meanwhile)
  const procs = fakeProcs({ alive: () => n++ === 0 });
  const s = await setup({ procs });
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-Ask-single');
    await waitFor(() => s.telegram.sent.length === 1);
    s.telegram.push(cb(`a|${dlgOf(s.telegram.sent[0])}|0|1`));
    await waitFor(() => s.telegram.sent.some((m) => m.text.startsWith('Сессия завершена: ')));
    await s.d.idle();
    assert.equal(s.inject.calls.length, 0);
    assert.equal(s.d.store.getDialog(dlgOf(s.telegram.sent[0])).status, 'open');
  } finally { await s.d.close(); }
});

test('dead pid is pruned before a Telegram update: session removed, nothing injected', async () => {
  const s = await setup({ procs: fakeProcs({ alive: () => false }) });
  try {
    await s.hook('SessionStart');
    await s.d.idle();
    s.telegram.push(msg('сделай что-нибудь'));
    await waitFor(() => s.telegram.sent.some((m) => m.text === 'Активных сессий нет — запустить новую?'));
    assert.equal(s.inject.calls.length, 0);
    const h = await fetch(`http://127.0.0.1:${s.d.port}/health`, { headers: { 'x-cc-secret': s.dj.secret } });
    assert.deepEqual(await h.json(), { ok: true, sessions: 0 });
  } finally { await s.d.close(); }
});

test('inject {ok:false} on a dialog answer -> warning, dialog reopened for retry', async () => {
  const s = await setup({ inject: fakeInject({ ok: false, error: 'boom' }) });
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-Ask-single');
    await waitFor(() => s.telegram.sent.length === 1);
    const dlg = dlgOf(s.telegram.sent[0]);
    s.telegram.push(cb(`a|${dlg}|0|1`));
    await waitFor(() => s.telegram.sent.some((m) => m.text.includes('⚠ не удалось ввести в терминал: boom')));
    await s.d.idle();
    const d = s.d.store.getDialog(dlg);
    assert.equal(d.status, 'open');
    assert.equal(d.source, null);
    // retry from Telegram is accepted again (not «Ответ уже отправлен»)
    s.telegram.push(cb(`a|${dlg}|0|1`, 'cbRetry'));
    await waitFor(() => s.inject.calls.length === 2);
  } finally { await s.d.close(); }
});

function unknownProcs() {
  const p = fakeProcs();
  p.listCalls = 0;
  p.listProcs = async () => { p.listCalls++; return new Map(); }; // PowerShell failed/timed out
  p.isClaudeAlive = realIsClaudeAlive;
  return p;
}

test('process list unavailable (empty Map) -> prune skipped, sessions survive', async () => {
  const procs = unknownProcs();
  const s = await setup({ procs, extra: { pruneIntervalMs: 20 } });
  try {
    await s.hook('SessionStart');
    await waitFor(() => procs.listCalls >= 3); // several prune passes, empty map never cached
    await s.d.idle();
    assert.equal(s.d.store.sessions.size, 1);
    assert.equal(s.telegram.sent.length + s.telegram.edits.length, 0);
  } finally { await s.d.close(); }
});

test('process list unavailable at inject time -> no inject, "cannot verify" warning, dialog reopened', async () => {
  const procs = unknownProcs();
  const s = await setup({ procs });
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-Ask-single');
    await waitFor(() => s.telegram.sent.length === 1);
    const dlg = dlgOf(s.telegram.sent[0]);
    s.telegram.push(cb(`a|${dlg}|0|1`));
    await waitFor(() => s.telegram.sent.some((m) => m.text.includes('⚠ не удалось проверить процесс сессии, ответьте в терминале')));
    await s.d.idle();
    assert.equal(s.inject.calls.length, 0);
    assert.ok(!s.telegram.sent.some((m) => m.text.startsWith('Сессия завершена')));
    assert.equal(s.d.store.getDialog(dlg).status, 'open');
    assert.equal(s.d.store.sessions.size, 1);
  } finally { await s.d.close(); }
});

test('inject {ok:false} -> warning sent', async () => {
  const s = await setup({ inject: fakeInject({ ok: false, error: 'boom' }) });
  try {
    await s.hook('SessionStart');
    await pickSession(s, 'привет');
    await waitFor(() => s.telegram.sent.some((m) => m.text.includes('⚠ не удалось ввести в терминал: boom')));
  } finally { await s.d.close(); }
});

test('verify: dialog not closed within timeoutMs -> warning; closed -> no warning', async () => {
  const s = await setup({ extra: { verifyTimeoutMs: 150 } });
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-Ask-single');
    await waitFor(() => s.telegram.sent.length === 1);
    s.telegram.push(cb(`a|${dlgOf(s.telegram.sent[0])}|0|1`));
    await waitFor(() => s.telegram.sent.some((m) => m.text.includes('⚠ не удалось подтвердить ответ — проверьте терминал')));
    // second dialog: PostToolUse arrives in time
    const before = s.telegram.sent.length;
    await s.hook('PreToolUse-Ask-single', { tool_use_id: 'toolu_second' });
    await waitFor(() => s.telegram.sent.length === before + 1);
    const send2 = s.telegram.sent.at(-1);
    s.telegram.push(cb(`a|${dlgOf(send2)}|0|1`, 'cb2'));
    await waitFor(() => s.inject.calls.length === 2);
    const r = await s.post({ event: 'PostToolUse', ppid: 999, payload: {
      session_id: SID, cwd: 'C:\\Projects\\tg-spike', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_second',
      tool_response: { answers: { 'Какой цвет?': 'Красный' } },
    } });
    assert.equal(r.status, 204);
    await new Promise((r) => setTimeout(r, 300));
    await s.d.idle();
    const warns = s.telegram.sent.filter((m) => m.text.includes('не удалось подтвердить'));
    assert.equal(warns.length, 1);
  } finally { await s.d.close(); }
});

test('bind contract: prompt binds only; dialog sends push to messageIds; edit text:null -> editMarkup', async () => {
  const s = await setup();
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-ExitPlanMode');
    await waitFor(() => s.telegram.sent.length === 1);
    const planMsg = s.telegram.sent[0];
    const dlg = dlgOf(planMsg);
    // plan feedback option -> force-reply prompt (bind.prompt)
    s.telegram.push(cb(`p|${dlg}|${PLAN_FEEDBACK_INDEX + 1}`));
    await waitFor(() => s.telegram.sent.length === 2);
    const prompt = s.telegram.sent[1];
    assert.equal(prompt.forceReply, true);
    await s.d.idle();
    const st = s.d.store;
    assert.deepEqual(st.lookupMessage(prompt.id), { sessionId: SID, dialogId: dlg });
    assert.deepEqual(st.getDialog(dlg).messageIds, [planMsg.id]);
    assert.deepEqual(st.lookupMessage(planMsg.id), { sessionId: SID, dialogId: dlg });

    // text:null edit -> editMarkup
    st.getDialog(dlg).text = 'x'.repeat(5000);
    s.telegram.push(msg('поправь план', USER, { reply_to_message: { message_id: prompt.id } }));
    await waitFor(() => s.telegram.markups.length === 1);
    assert.deepEqual(s.telegram.markups[0], { chatId: USER, messageId: planMsg.id, keyboard: null });
    await waitFor(() => s.inject.calls.length === 1);
  } finally { await s.d.close(); }
});

test('completion -> summarize -> completionText sent and bound to session', async () => {
  const calls = [];
  const s = await setup({ summarize: async (t, o) => { calls.push({ t, o }); return { status: 'error', summary: '' }; } });
  try {
    await s.hook('SessionStart');
    await s.post({ event: 'StopFailure', payload: { session_id: SID, cwd: 'C:\\Projects\\tg-spike', error: 'oops' }, ppid: 999 });
    await waitFor(() => s.telegram.sent.length === 1);
    assert.deepEqual(calls, [{ t: 'oops', o: { failed: true } }]);
    assert.match(s.telegram.sent[0].text, /❌ ошибка/);
    assert.match(s.telegram.sent[0].text, /\(пустой ответ\)/);
    await s.d.idle();
    assert.deepEqual(s.d.store.lookupMessage(s.telegram.sent[0].id), { sessionId: SID });
  } finally { await s.d.close(); }
});

test('effect error is logged and does not stop the following effects', async () => {
  const log = recLog();
  const telegram = fakeTelegram();
  telegram.answerCallback = async () => { throw new Error('answer failed'); };
  const s = await setup({ telegram, log });
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-Ask-single');
    await waitFor(() => telegram.sent.length === 1);
    s.telegram.push(cb(`a|${dlgOf(telegram.sent[0])}|0|1`));
    await waitFor(() => s.inject.calls.length === 1);
    assert.ok(log.lines.some((l) => l.level === 'error' && /answer failed/.test(JSON.stringify(l))));
  } finally { await s.d.close(); }
});

test('RF-4: getUpdates throws twice -> third call happens with exponential backoff', async () => {
  const telegram = fakeTelegram();
  telegram.failures.push(new Error('net down'), new Error('net down'));
  const waits = [];
  const s = await setup({ telegram, extra: { sleep: async (ms) => { waits.push(ms); } } });
  try {
    await waitFor(() => telegram.getUpdatesCalls >= 3);
    assert.deepEqual(waits.slice(0, 2), [5, 10]);
  } finally { await s.d.close(); }
});

test('429 -> waits retry_after seconds', async () => {
  const telegram = fakeTelegram();
  telegram.failures.push(new TelegramError('getUpdates', 429, 'Too Many Requests', 3));
  const waits = [];
  const s = await setup({ telegram, extra: { sleep: async (ms) => { waits.push(ms); } } });
  try {
    await waitFor(() => telegram.getUpdatesCalls >= 2);
    assert.equal(waits[0], 3000);
  } finally { await s.d.close(); }
});

test('offset persisted to state/offset and reused on restart', async () => {
  const s = await setup();
  try {
    s.telegram.push({ update_id: 41, message: { message_id: 1, from: { id: STRANGER }, chat: { id: STRANGER, type: 'private' }, text: 'x' } });
    await waitFor(() => fs.existsSync(path.join(s.paths.stateDir, 'offset')) && fs.readFileSync(path.join(s.paths.stateDir, 'offset'), 'utf8').trim() === '42');
  } finally { await s.d.close(); }
  const telegram = fakeTelegram();
  const d2 = await startDaemon({
    config: { token: '123:TOKENxyz', userId: USER }, paths: s.paths, telegram, inject: fakeInject(), procs: fakeProcs(),
    summarize: async () => ({}), log: silent, port: 0, restrictToUser: async () => {}, claudeVersion: async () => 'v',
  });
  try {
    await waitFor(() => telegram.getUpdatesCalls >= 1);
    assert.equal(telegram.lastOffset, 42);
  } finally { await d2.close(); }
});

test('snapshot saved (debounced) and loaded at start; corrupt snapshot -> empty store', async () => {
  const s = await setup({ extra: { snapshotDebounceMs: 20 } });
  try {
    await s.hook('SessionStart');
    await waitFor(() => fs.existsSync(s.paths.snapshot));
    const snap = JSON.parse(fs.readFileSync(s.paths.snapshot, 'utf8'));
    assert.equal(snap.sessions[0].id, SID);
    assert.equal(snap.sessions[0].pid, CLAUDE_PID);
  } finally { await s.d.close(); }
  const mk = (log) => startDaemon({
    config: { token: '123:TOKENxyz', userId: USER }, paths: s.paths, telegram: fakeTelegram(), inject: fakeInject(), procs: fakeProcs(),
    summarize: async () => ({}), log, port: 0, restrictToUser: async () => {}, claudeVersion: async () => 'v',
  });
  const d2 = await mk(silent);
  try { assert.equal(d2.store.getSession(SID).pid, CLAUDE_PID); } finally { await d2.close(); }
  fs.writeFileSync(s.paths.snapshot, '{not json');
  const log = recLog();
  const d3 = await mk(log);
  try {
    assert.equal(d3.store.sessions.size, 0);
    assert.ok(log.lines.some((l) => /snapshot/.test(l.msg)));
  } finally { await d3.close(); }
});

test('prune timer: dead session gets SessionEnd treatment (dialog message edited stale)', async () => {
  let alive = true;
  const s = await setup({ procs: fakeProcs({ alive: () => alive }), extra: { pruneIntervalMs: 30 } });
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-Ask-single');
    await waitFor(() => s.telegram.sent.length === 1);
    alive = false;
    await waitFor(() => s.d.store.sessions.size === 0);
    await waitFor(() => s.telegram.edits.length === 1);
    assert.equal(s.telegram.edits[0].messageId, s.telegram.sent[0].id);
  } finally { await s.d.close(); }
});

test('missing token or userId -> exit(3)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-daemon-'));
  const codes = [];
  const r = await startDaemon({
    config: { token: '', userId: null }, paths: mkPaths(home), telegram: fakeTelegram(), inject: fakeInject(), procs: fakeProcs(),
    summarize: async () => ({}), log: silent, port: 0, exit: (c) => codes.push(c), restrictToUser: async () => {}, claudeVersion: async () => 'v',
  });
  assert.equal(r, null);
  assert.deepEqual(codes, [3]);
});

test('port in use -> log + exit(1)', async () => {
  const s = await setup();
  const codes = [];
  const log = recLog();
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-daemon-'));
    const r = await startDaemon({
      config: { token: '123:TOKENxyz', userId: USER }, paths: mkPaths(home), telegram: fakeTelegram(), inject: fakeInject(), procs: fakeProcs(),
      summarize: async () => ({}), log, port: s.d.port, exit: (c) => codes.push(c), restrictToUser: async () => {}, claudeVersion: async () => 'v',
    });
    assert.equal(r, null);
    assert.deepEqual(codes, [1]);
    assert.ok(log.lines.some((l) => l.level === 'error' && /port/i.test(l.msg)));
  } finally { await s.d.close(); }
});

test('logs Claude Code version at start', async () => {
  const log = recLog();
  const s = await setup({ log });
  try {
    await waitFor(() => log.lines.some((l) => l.msg.includes('2.1.310')));
  } finally { await s.d.close(); }
});

// ---------- supervisor ----------

function fakeSpawner(codes) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    const code = codes.shift();
    setImmediate(() => child.emit('exit', code ?? 3, null));
    return child;
  };
  return { calls, spawn };
}

test('supervisor: restarts on crash with backoff, stops on exit 3', async () => {
  const { calls, spawn } = fakeSpawner([2, 2, 3]);
  const waits = [];
  const code = await runSupervisor({ spawn, sleep: async (ms) => { waits.push(ms); }, log: silent, daemonPath: 'D:\\x\\daemon.mjs' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, ['D:\\x\\daemon.mjs']);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.deepEqual(waits, [2000, 4000]);
  assert.equal(code, 0);
});

test('supervisor: crash exit 4 is restartable and resets the port-in-use streak', async () => {
  const { calls, spawn } = fakeSpawner([1, 1, 4, 1, 1, 3]);
  await runSupervisor({ spawn, sleep: async () => {}, log: silent, daemonPath: 'd.mjs' });
  assert.equal(calls.length, 6);
});

test('supervisor: exit 1 three times in a row -> stop (another instance running)', async () => {
  const { calls, spawn } = fakeSpawner([1, 1, 1, 1]);
  await runSupervisor({ spawn, sleep: async () => {}, log: silent, daemonPath: 'd.mjs' });
  assert.equal(calls.length, 3);
});

test('supervisor: backoff capped at 60s and reset after 5 min uptime', async () => {
  const { spawn } = fakeSpawner([2, 2, 2, 2, 2, 2, 2, 2, 3]);
  const waits = [];
  const ups = [0, 0, 0, 0, 0, 0, 0, 6 * 60_000, 0];
  let t = 0, i = 0, phase = 0;
  const now = () => { if (phase === 0) { phase = 1; return t; } phase = 0; t += ups[i++] ?? 0; return t; };
  await runSupervisor({ spawn, sleep: async (ms) => { waits.push(ms); }, log: silent, daemonPath: 'd.mjs', now });
  assert.ok(waits.every((w) => w <= 60_000));
  assert.ok(waits.includes(60_000));
  assert.equal(waits.at(-1), 2000);
});

test('restrictToUser runs icacls with inheritance removed and logs errors without throwing', async () => {
  const calls = [];
  await restrictToUser('C:\\x\\daemon.json', {
    user: 'bob', log: silent,
    execFile: (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); cb(null, '', ''); },
  });
  assert.equal(calls[0].cmd, 'icacls');
  assert.deepEqual(calls[0].args, ['C:\\x\\daemon.json', '/inheritance:r', '/grant:r', 'bob:F']);
  assert.equal(calls[0].opts.windowsHide, true);
  const log = recLog();
  await restrictToUser('p', { user: 'bob', log, execFile: (c, a, o, cb) => cb(new Error('denied')) });
  assert.ok(log.lines.some((l) => l.level === 'error'));
});

// ---------- final-fix wave ----------

test('F1: body.claudePid/claudeStartedAt -> session pid set without findAncestor', async () => {
  const s = await setup();
  try {
    const payload = fx('SessionStart');
    await s.post({ event: 'SessionStart', payload, ppid: 999, claudePid: 31337, claudeStartedAt: 1_700_000_000_000 });
    await waitFor(() => s.d.store.getSession(SID));
    await s.d.idle();
    assert.equal(s.d.store.getSession(SID).pid, 31337);
    assert.equal(s.d.store.getSession(SID).pidStartedAt, 1_700_000_000_000);
    assert.deepEqual(s.procs.ancestorCalls, []);
    // a later body pid wins over the stored one (e.g. resumed in another claude.exe)
    await s.post({ event: 'UserPromptSubmit', payload: fx('UserPromptSubmit'), ppid: 999, claudePid: 4040 });
    await waitFor(() => s.d.store.getSession(SID).pid === 4040);
    assert.equal(s.d.store.getSession(SID).pidStartedAt, null);
    assert.deepEqual(s.procs.ancestorCalls, []);
  } finally { await s.d.close(); }
});

test('F1: findAncestor fallback is negative-cached per session for 60 s', async () => {
  let t = 1_000_000;
  const procs = fakeProcs();
  procs.findAncestor = async (ppid) => { procs.ancestorCalls.push(ppid); return null; };
  const s = await setup({ procs, extra: { now: () => t } });
  try {
    await s.hook('SessionStart');
    await s.hook('UserPromptSubmit');
    t += 59_000;
    await s.hook('UserPromptSubmit');
    await s.d.idle();
    assert.equal(procs.ancestorCalls.length, 1);
    t += 1_000;
    await s.hook('UserPromptSubmit');
    await s.d.idle();
    assert.equal(procs.ancestorCalls.length, 2);
    assert.equal(s.d.store.getSession(SID).pid, null);
  } finally { await s.d.close(); }
});

test('F1b: inject refuses a pid whose creation time does not match (reused pid)', async () => {
  const procs = fakeProcs();
  procs.listProcs = async () => new Map([[31337, { name: 'claude.exe', ppid: 1, startedAt: 1_700_000_009_000 }]]);
  procs.isClaudeAlive = realIsClaudeAlive;
  const s = await setup({ procs });
  try {
    await s.post({ event: 'SessionStart', payload: fx('SessionStart'), ppid: 999, claudePid: 31337, claudeStartedAt: 1_700_000_000_000 });
    await waitFor(() => s.d.store.getSession(SID));
    s.telegram.push(msg('сделай'));
    await waitFor(() => s.telegram.sent.length >= 1);
    await s.d.idle();
    assert.equal(s.inject.calls.length, 0);
    assert.equal(s.d.store.sessions.size, 0, 'pruned as dead');
  } finally { await s.d.close(); }
});

test('F2: verify timeout closes the dialog (telegram) + ⚠; instructions are not blocked afterwards', async () => {
  const s = await setup({ extra: { verifyTimeoutMs: 100 } });
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-Ask-single');
    await waitFor(() => s.telegram.sent.length === 1);
    const dlg = dlgOf(s.telegram.sent[0]);
    s.telegram.push(cb(`a|${dlg}|0|1`));
    await waitFor(() => s.telegram.sent.some((m) => m.text.includes('⚠ не удалось подтвердить ответ — проверьте терминал')));
    await s.d.idle();
    assert.equal(s.d.store.getDialog(dlg).status, 'closed');
    assert.equal(s.d.store.getDialog(dlg).closedReason, 'telegram');
    await pickSession(s, 'следующая задача');
    await waitFor(() => s.inject.calls.length === 2);
    assert.deepEqual(s.inject.calls[1].steps[0], { text: 'следующая задача' });
    assert.ok(!s.telegram.sent.some((m) => m.text.includes('обрабатывается')));
  } finally { await s.d.close(); }
});

test('F7: permission approve unconfirmed -> 2-min ⚠ text', async () => {
  const s = await setup({ extra: { verifyTimeoutMs: 100 } });
  try {
    await s.hook('SessionStart');
    await s.hook('PermissionRequest-Write');
    await waitFor(() => s.telegram.sent.length === 1);
    s.telegram.push(cb(`p|${dlgOf(s.telegram.sent[0])}|1`));
    await waitFor(() => s.telegram.sent.some((m) => m.text.includes('⚠ ответ на разрешение не подтверждён за 2 мин — проверьте терминал')));
    assert.ok(!s.telegram.sent.some((m) => m.text.includes('не удалось подтвердить ответ')));
  } finally { await s.d.close(); }
});

const RETRY = '⚠ не удалось ввести — выберите снова';

test('F3: failed inject -> final edit restores the keyboard; pressing again injects again', async () => {
  const s = await setup({ inject: fakeInject({ ok: false, error: 'boom' }) });
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-Ask-single');
    await waitFor(() => s.telegram.sent.length === 1);
    const askMsg = s.telegram.sent[0];
    const dlg = dlgOf(askMsg);
    s.telegram.push(cb(`a|${dlg}|0|1`));
    await waitFor(() => s.telegram.edits.length === 2);
    await s.d.idle();
    const [resolved, restored] = s.telegram.edits;
    assert.equal(resolved.keyboard, null);
    assert.equal(restored.messageId, askMsg.id);
    assert.deepEqual(restored.keyboard, askMsg.keyboard);
    assert.ok(restored.text.endsWith(`\n\n${RETRY}`));
    assert.ok(!restored.text.includes('✔ выбрано'));
    const d = s.d.store.getDialog(dlg);
    assert.equal(d.status, 'open');
    assert.deepEqual(d.answers, [], 'current question is re-asked');
    s.telegram.push(cb(`a|${dlg}|0|2`, 'cbRetry'));
    await waitFor(() => s.inject.calls.length === 2);
    assert.deepEqual(s.inject.calls[1].steps, [{ text: '2' }]);
  } finally { await s.d.close(); }
});

test('F3: dead session on a plan-feedback inject also reopens + restores the keyboard', async () => {
  let n = 0;
  const s = await setup({ procs: fakeProcs({ alive: () => n++ === 0 }) }); // alive for prune, dead at inject
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-ExitPlanMode');
    await waitFor(() => s.telegram.sent.length === 1);
    const planMsg = s.telegram.sent[0];
    const dlg = dlgOf(planMsg);
    s.telegram.push(msg('поправь шаг 2', USER, { reply_to_message: { message_id: planMsg.id } }));
    await waitFor(() => s.telegram.edits.length === 2);
    await s.d.idle();
    const restored = s.telegram.edits[1];
    assert.deepEqual(restored.keyboard, planMsg.keyboard);
    assert.ok(restored.text.endsWith(RETRY));
    const d = s.d.store.getDialog(dlg);
    assert.equal(d.status, 'open');
    assert.equal(d.feedbackSent, false);
    assert.equal(s.inject.calls.length, 0);
  } finally { await s.d.close(); }
});

test('F3: unknown process list on an ask inject reopens + restores the keyboard', async () => {
  const procs = unknownProcs();
  const s = await setup({ procs });
  try {
    await s.hook('SessionStart');
    await s.hook('PreToolUse-Ask-single');
    await waitFor(() => s.telegram.sent.length === 1);
    const askMsg = s.telegram.sent[0];
    s.telegram.push(cb(`a|${dlgOf(askMsg)}|0|1`));
    await waitFor(() => s.telegram.edits.length === 2);
    assert.deepEqual(s.telegram.edits[1].keyboard, askMsg.keyboard);
  } finally { await s.d.close(); }
});

test('F4: a slow summarize does not delay the effects of a subsequent update', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await setup({ summarize: async (t) => { await gate; return { status: 'done', summary: t }; } });
  try {
    await s.hook('SessionStart');
    await s.post({ event: 'StopFailure', payload: { session_id: SID, cwd: 'C:/Projects/tg-spike', error: 'oops' }, ppid: 999 });
    s.telegram.push(msg('/status'));
    await waitFor(() => s.telegram.sent.length === 1);
    assert.match(s.telegram.sent[0].text, /tg-spike/);
    release();
    await waitFor(() => s.telegram.sent.length === 2);
    assert.match(s.telegram.sent[1].text, /Статус: ✅ завершено\noops$/);
    await s.d.idle();
    assert.deepEqual(s.d.store.lookupMessage(s.telegram.sent[1].id), { sessionId: SID });
  } finally { await s.d.close(); }
});

test('F9: periodic prune drops closed dialogs older than 1 h; closed dialogs lose their payload', async () => {
  const t = Date.now();
  const s = await setup({ extra: { now: () => t, pruneIntervalMs: 30 } });
  try {
    await s.hook('SessionStart');
    await s.hook('PermissionRequest-Write');
    await waitFor(() => s.telegram.sent.length === 1);
    const dlg = dlgOf(s.telegram.sent[0]);
    await s.hook('PostToolUse-Write'); // answered in the terminal
    await waitFor(() => s.d.store.getDialog(dlg)?.status === 'closed');
    assert.equal(s.d.store.getDialog(dlg).payload, null);
    s.d.store.getDialog(dlg).closedAt = t - 3_600_001;
    await waitFor(() => !s.d.store.getDialog(dlg));
    assert.equal(s.d.store.sessions.size, 1);
  } finally { await s.d.close(); }
});

test('minor: uncaughtException -> logged + exit(EXIT_CRASH)', async () => {
  const { installProcessHandlers, EXIT_CRASH } = await import('../src/daemon.mjs');
  const proc = new EventEmitter();
  const log = recLog();
  const codes = [];
  installProcessHandlers(proc, log, (c) => codes.push(c));
  proc.emit('unhandledRejection', new Error('rej'));
  assert.deepEqual(codes, []);
  proc.emit('uncaughtException', new Error('kaboom'));
  assert.deepEqual(codes, [EXIT_CRASH]);
  assert.ok(log.lines.some((l) => l.level === 'error' && /kaboom/.test(JSON.stringify(l))));
});

// ---------- new session via VS Code ----------

const vpost = (s, url, body) => fetch(`http://127.0.0.1:${s.d.port}${url}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-secret': s.dj.secret }, body: JSON.stringify(body),
});
const DIRS = [{ path: 'C:\\Projects\\alpha', label: 'alpha' }, { path: 'C:\\Projects\\beta', label: 'beta' }];

async function toFolderPicker(s, text) {
  s.telegram.push(msg(text));
  await waitFor(() => s.telegram.sent.some((m) => m.text === 'Активных сессий нет — запустить новую?'));
  s.telegram.push(cb('n|500', 'cbn'));
  await waitFor(() => s.telegram.edits.some((e) => e.text === '📂 Где запустить новую сессию?'));
}

test('vscode: /vscode/* need the secret', async () => {
  const s = await setup();
  try {
    const r = await fetch(`http://127.0.0.1:${s.d.port}/vscode/poll`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 403);
  } finally { await s.d.close(); }
});

test('vscode: text → n| (recentDirs) → f| → job to the polling window with prompt file; ack ok → «Запущено»', async () => {
  const s = await setup({ extra: { recentDirs: async () => DIRS, spawnTimeoutMs: 3000 } });
  try {
    const poll = vpost(s, '/vscode/poll', { id: 'win1', folders: ['C:\\Projects\\beta'], focusedAt: 1 });
    await toFolderPicker(s, 'напиши "README" $HOME\nвторая строка');
    const folderEdit = s.telegram.edits.find((e) => e.text === '📂 Где запустить новую сессию?');
    assert.deepEqual(folderEdit.keyboard.flat().map((b) => b.callback_data), ['f|500|0', 'f|500|1', 'f|500|o']);
    s.telegram.push(cb('f|500|1', 'cbf'));
    const r = await poll;
    assert.equal(r.status, 200);
    const job = await r.json();
    assert.equal(job.cwd, 'C:\\Projects\\beta');
    assert.equal(job.title, '🤖 beta');
    assert.equal(job.node, process.execPath);
    assert.match(job.script, /newsession\.mjs$/);
    assert.equal(fs.readFileSync(job.promptFile, 'utf8'), 'напиши "README" $HOME\nвторая строка');
    assert.equal((await vpost(s, '/vscode/ack', { jobId: job.id, ok: true })).status, 204);
    await waitFor(() => s.telegram.edits.some((e) => e.text === '🆕 Запущено: beta'));
    assert.equal(s.d.store.pendingRoute, null);
  } finally { await s.d.close(); }
});

test('vscode: no window → «VS Code не отвечает» + retry button; route restored, retry works', async () => {
  const s = await setup({ extra: { recentDirs: async () => DIRS, spawnTimeoutMs: 200 } });
  try {
    await toFolderPicker(s, 'задача');
    s.telegram.push(cb('f|500|0', 'cbf'));
    await waitFor(() => s.telegram.sent.some((m) => /VS Code не отвечает/.test(m.text)));
    const warn = s.telegram.sent.find((m) => /VS Code не отвечает/.test(m.text));
    assert.deepEqual(warn.keyboard, [[{ text: '🔁 Повторить', callback_data: 'f|500|0' }]]);
    assert.deepEqual(s.d.store.pendingRoute.folders, ['C:\\Projects\\alpha']);
    const spawnDir = path.join(s.paths.stateDir, 'spawn');
    assert.deepEqual(fs.existsSync(spawnDir) ? fs.readdirSync(spawnDir) : [], []);
    // the window shows up; retry delivers the job
    const poll = vpost(s, '/vscode/poll', { id: 'w', folders: [] });
    await new Promise((r) => setTimeout(r, 30));
    s.telegram.push(cb('f|500|0', 'cbr'));
    const job = await (await poll).json();
    assert.equal(job.cwd, 'C:\\Projects\\alpha');
    await vpost(s, '/vscode/ack', { jobId: job.id, ok: true });
    await waitFor(() => s.telegram.edits.some((e) => e.text === '🆕 Запущено: alpha'));
  } finally { await s.d.close(); }
});

test('vscode: a slow spawn does not block other updates', async () => {
  const s = await setup({ extra: { recentDirs: async () => DIRS, spawnTimeoutMs: 1500 } });
  try {
    const poll = vpost(s, '/vscode/poll', { id: 'w', folders: [] });
    await toFolderPicker(s, 'задача');
    s.telegram.push(cb('f|500|0', 'cbf'));
    await poll; // job delivered, never acked
    s.telegram.push(msg('/status'));
    await waitFor(() => s.telegram.sent.some((m) => m.text === 'Активных сессий нет'), 1000);
  } finally { await s.d.close(); }
});
