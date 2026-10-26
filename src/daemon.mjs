// Daemon: local HTTP intake for hook events, Telegram long polling, effect executor.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths as getPaths, loadConfig } from './config.mjs';
import { createLogger } from './log.mjs';
import { createTelegram } from './telegram.mjs';
import { injectSteps } from './inject.mjs';
import * as procsModule from './procs.mjs';
import { Store } from './sessions.mjs';
import { handleHookEvent } from './events.mjs';
import { handleUpdate } from './router.mjs';
import { summarize as summarizeDefault, resolveClaude } from './summary.mjs';
import { completionText, header, esc, dialogKeyboard } from './format.mjs';
import { restrictToUser as restrictDefault } from './acl.mjs';

export const EXIT_PORT_IN_USE = 1;
export const EXIT_FATAL = 2;
export const EXIT_CONFIG = 3;
export const EXIT_CRASH = 4; // unexpected failure in main(): supervisor restarts with backoff

const MAX_BODY = 2 * 1024 * 1024;
const BACKOFF_CAP_MS = 30_000;
const PROCS_CACHE_MS = 2000;
const BRANCH_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const ANCESTOR_RETRY_MS = 60_000;
const MAX_EDIT_TEXT = 3900;
const RETRY_NOTE = '⚠ не удалось ввести — выберите снова';

const errText = (e) => String(e?.message ?? e);

function defaultClaudeVersion() {
  return new Promise((resolve, reject) => {
    const { cmd, shell } = resolveClaude();
    execFile(shell ? `"${cmd}"` : cmd, ['--version'], {
      windowsHide: true, timeout: 10_000, shell, env: { ...process.env, CC_TELEGRAM_DISABLE: '1' },
    }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });
}

function secretOk(given, secret) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startDaemon({
  config, paths, telegram, inject, procs = procsModule, summarize = summarizeDefault, log,
  now = Date.now,
  port,
  secret = randomBytes(16).toString('hex'),
  exit = (code) => process.exit(code),
  backoffBaseMs = 1000,
  sleep,
  restrictToUser = restrictDefault,
  claudeVersion = defaultClaudeVersion,
  pruneIntervalMs = 30_000,
  snapshotDebounceMs = 500,
  verifyTimeoutMs, // test override for verify.timeoutMs
} = {}) {
  log = log ?? createLogger({ dir: paths.logsDir, secrets: [config?.token, secret] });

  if (!config?.token || config.userId == null) {
    log.error('missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID in .env — daemon not started');
    exit(EXIT_CONFIG);
    return null;
  }

  telegram = telegram ?? createTelegram({ token: config.token, log });
  inject = inject ?? { injectSteps };
  const offsetFile = path.join(paths.stateDir, 'offset');

  let stopped = false;
  const timers = new Set();
  const sleepers = new Set();
  const doSleep = sleep ?? ((ms) => new Promise((resolve) => {
    const s = { resolve };
    s.t = setTimeout(() => { sleepers.delete(s); resolve(); }, ms);
    sleepers.add(s);
  }));
  const later = (ms, fn) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };

  // ---------- store + snapshot ----------
  let store = new Store();
  try {
    if (fs.existsSync(paths.snapshot)) store = Store.fromJSON(JSON.parse(fs.readFileSync(paths.snapshot, 'utf8')));
  } catch (e) {
    log.warn('snapshot unreadable, starting empty', { error: errText(e) });
    store = new Store();
  }

  let snapTimer = null;
  function writeSnapshot() {
    snapTimer = null;
    try {
      fs.mkdirSync(paths.stateDir, { recursive: true });
      const tmp = paths.snapshot + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store.toJSON()));
      fs.renameSync(tmp, paths.snapshot);
    } catch (e) { log.error('snapshot write failed', { error: errText(e) }); }
  }
  function scheduleSnapshot() {
    if (snapTimer || stopped) return;
    snapTimer = setTimeout(writeSnapshot, snapshotDebounceMs);
  }

  // ---------- serial queue ----------
  let chain = Promise.resolve();
  function enqueue(name, fn) {
    if (stopped) return chain;
    chain = chain.then(fn).catch((e) => log.error(`${name} failed`, { error: errText(e) })).then(scheduleSnapshot);
    return chain;
  }
  // Work running outside the serial queue (summaries); idle() waits for it too.
  const background = new Set();
  function inBackground(p) {
    background.add(p);
    p.finally(() => background.delete(p));
  }
  async function idle() {
    let c;
    do {
      c = chain;
      await c;
      while (background.size) await Promise.allSettled([...background]);
    } while (c !== chain || background.size);
  }

  // ---------- process helpers ----------
  // listProcs() resolves an empty Map when PowerShell fails/times out: that means "unknown",
  // never "everything is dead" — it is not cached and callers must not act on it.
  let procCache = null;
  const ancestorMiss = new Map(); // sessionId -> time of the last fruitless findAncestor
  const cachedList = async () => {
    if (procCache && Date.now() - procCache.at <= PROCS_CACHE_MS) return procCache.map;
    const map = await procs.listProcs();
    if (!(map instanceof Map) || map.size === 0) return null;
    procCache = { at: Date.now(), map };
    return map;
  };
  // -> 'alive' | 'dead' | 'unknown'. startedAt (Unix ms, optional) guards against a reused pid.
  async function aliveState(pid, startedAt) {
    const opts = Number.isFinite(startedAt) ? { startedAt } : {};
    if (!procs.listProcs) return (await procs.isClaudeAlive(pid, opts)) ? 'alive' : 'dead';
    const map = await cachedList();
    if (!map) return 'unknown';
    return (await procs.isClaudeAlive(pid, { ...opts, listProcs: async () => map })) ? 'alive' : 'dead';
  }

  // F3: a failed/dropped inject leaves the dialog answerable again from Telegram: reopen it and
  // put its keyboard back on the last message (the router already removed it).
  async function reopenDialog(e) {
    const id = e.verify?.dialogId ?? e.dialogId;
    const d = id ? store.getDialog(id) : null;
    if (!d || d.status !== 'injected') return;
    d.status = 'open';
    d.source = null;
    d.feedbackSent = false;
    if (d.kind === 'ask') d.answers.length = d.cursor; // re-ask the current question
    const messageId = d.messageIds[d.messageIds.length - 1];
    const keyboard = dialogKeyboard(d);
    if (messageId == null || !keyboard) return;
    const text = `${d.text ?? ''}\n\n${RETRY_NOTE}`;
    await runEffect({ type: 'edit', messageId, text: text.length > MAX_EDIT_TEXT ? null : text, keyboard });
  }

  // ---------- effect executor ----------
  const chatId = config.userId;
  const labelOf = (sid) => store.labelOf(sid);

  async function send(e) {
    const messageId = await telegram.sendMessage({
      chatId, text: e.text, keyboard: e.keyboard, replyTo: e.replyTo, forceReply: e.forceReply,
    });
    if (e.bind && messageId != null) {
      const binding = {};
      if (e.bind.sessionId !== undefined) binding.sessionId = e.bind.sessionId;
      if (e.bind.dialogId !== undefined) binding.dialogId = e.bind.dialogId;
      store.bindMessage(messageId, binding);
      if (e.bind.dialogId && !e.bind.prompt) store.getDialog(e.bind.dialogId)?.messageIds.push(messageId);
    }
    return messageId;
  }

  async function doInject(e) {
    const session = store.getSession(e.sessionId);
    const pid = session?.pid;
    const state = !session || pid == null ? 'dead' : await aliveState(pid, session.pidStartedAt);
    if (state === 'unknown') {
      log.warn('inject dropped: process list unavailable', { session: session.short, pid });
      await reopenDialog(e);
      await send({
        text: `${header(labelOf(e.sessionId))}
⚠ не удалось проверить процесс сессии, ответьте в терминале`,
        bind: { sessionId: e.sessionId },
      });
      return;
    }
    if (state === 'dead') {
      log.warn('inject dropped: session process not alive', { session: String(e.sessionId).slice(0, 8), pid });
      await reopenDialog(e);
      await send({ text: 'Сессия завершена: ' + esc(labelOf(e.sessionId)), bind: session ? { sessionId: e.sessionId } : undefined });
      return;
    }
    const r = await inject.injectSteps(pid, e.steps);
    if (!r?.ok) {
      log.warn('inject failed', { session: session.short, error: r?.error });
      await reopenDialog(e);
      await send({
        text: `${header(labelOf(e.sessionId))}\n⚠ не удалось ввести в терминал: ${esc(r?.error ?? 'неизвестная ошибка')}`,
        bind: { sessionId: e.sessionId },
      });
      return;
    }
    if (e.verify?.dialogId) {
      const { dialogId } = e.verify;
      const label = labelOf(e.sessionId);
      later(verifyTimeoutMs ?? e.verify.timeoutMs ?? 10_000, () => enqueue('verify', async () => {
        const d = store.getDialog(dialogId);
        if (!d || d.status !== 'injected') return;
        // F2: unconfirmed -> close (source telegram) so the session's instructions are not blocked.
        store.closeDialog(dialogId, 'telegram');
        const warn = d.kind === 'perm'
          ? '⚠ ответ на разрешение не подтверждён за 2 мин — проверьте терминал'
          : '⚠ не удалось подтвердить ответ — проверьте терминал';
        await send({
          text: `${header(labelOf(e.sessionId) || label)}\n${warn}`,
          bind: store.getSession(e.sessionId) ? { sessionId: e.sessionId } : undefined,
        });
      }));
    }
  }

  async function runEffect(e) {
    switch (e.type) {
      case 'send': await send(e); return;
      case 'edit':
        if (e.text === null) await telegram.editMarkup({ chatId, messageId: e.messageId, keyboard: e.keyboard });
        else await telegram.editMessage({ chatId, messageId: e.messageId, text: e.text, keyboard: e.keyboard });
        return;
      case 'answerCallback': await telegram.answerCallback(e.callbackId, e.text); return;
      case 'inject': await doInject(e); return;
      case 'completion': {
        // F4: summarize (claude -p, up to a minute) runs outside the serial queue; only the send is queued.
        inBackground(Promise.resolve()
          .then(() => summarize(e.lastMessage, { failed: e.failed }))
          .catch((err) => { log.error('summarize failed', { error: errText(err) }); return { status: e.failed ? 'error' : 'done' }; })
          .then((r) => enqueue('completion', () => send({
            text: completionText(labelOf(e.sessionId), r?.status, r?.summary || '(пустой ответ)'),
            bind: { sessionId: e.sessionId },
          }))));
        return;
      }
      default: log.warn('unknown effect', { type: e.type });
    }
  }

  async function runEffects(effects) {
    for (const e of effects ?? []) {
      try { await runEffect(e); } catch (err) { log.error(`effect ${e?.type} failed`, { error: errText(err) }); }
    }
  }

  // ---------- hook events ----------
  async function onHookEvent(body) {
    const event = body?.event;
    const payload = body?.payload;
    const sid = payload?.session_id;
    if (!sid || typeof payload !== 'object') { log.warn('hook event without session_id', { event }); return; }
    // F1: the hook resolves claude.exe synchronously (body.claudePid); findAncestor(ppid) is only a
    // fallback, at most once per session per 60 s (by then the hook's parent chain may be gone).
    let claudePid;
    let claudeStartedAt;
    if (Number.isInteger(body.claudePid) && body.claudePid > 0) {
      claudePid = body.claudePid;
      if (Number.isFinite(body.claudeStartedAt) && body.claudeStartedAt > 0) claudeStartedAt = body.claudeStartedAt;
      ancestorMiss.delete(sid);
    } else if (store.getSession(sid)?.pid == null && Number.isInteger(body.ppid)) {
      const last = ancestorMiss.get(sid);
      if (last == null || now() - last >= ANCESTOR_RETRY_MS) {
        claudePid = (await procs.findAncestor(body.ppid)) ?? undefined;
        if (claudePid == null) ancestorMiss.set(sid, now());
        else ancestorMiss.delete(sid);
      }
    }
    let branch;
    if (BRANCH_EVENTS.has(event) && payload.cwd) branch = await procs.gitBranch(payload.cwd);
    await runEffects(handleHookEvent(store, { event, payload, claudePid, claudeStartedAt, branch }, now()));
    if (event === 'SessionEnd') ancestorMiss.delete(sid);
  }

  // ---------- pruning dead sessions ----------
  async function pruneDead() {
    for (const s of [...store.sessions.values()]) {
      if (s.pid == null) continue;
      const state = await aliveState(s.pid, s.pidStartedAt);
      if (state === 'unknown') { log.warn('process list unavailable, prune skipped'); return; }
      if (state === 'alive') continue;
      log.info('session process gone, removing', { session: s.short, pid: s.pid });
      await runEffects(handleHookEvent(store, { event: 'SessionEnd', payload: { session_id: s.id, cwd: s.cwd } }, now()));
    }
  }

  // ---------- telegram updates ----------
  function senderOf(u) {
    if (u?.callback_query) return { id: u.callback_query.from?.id, chat: u.callback_query.message?.chat?.type };
    if (u?.message) return { id: u.message.from?.id, chat: u.message.chat?.type };
    return null;
  }

  async function onUpdate(u) {
    const from = senderOf(u);
    if (!from) return;
    // RF-1: never act (not even prune/edit) on an update from someone else.
    if (from.id !== config.userId || from.chat !== 'private') {
      log.info(`ignored update from ${from.id}`);
      return;
    }
    await pruneDead();
    await runEffects(handleUpdate(store, u, { userId: config.userId, now: now() }));
  }

  let offset = 0;
  try { offset = Number(fs.readFileSync(offsetFile, 'utf8').trim()) || 0; } catch { /* first run */ }

  async function pollLoop() {
    let fails = 0;
    while (!stopped) {
      let updates;
      try {
        updates = await telegram.getUpdates(offset, 50);
        fails = 0;
      } catch (e) {
        if (stopped) break;
        const wait = e?.errorCode === 429 && Number.isFinite(e.retryAfter)
          ? e.retryAfter * 1000
          : Math.min(backoffBaseMs * 2 ** fails, BACKOFF_CAP_MS);
        fails++;
        log.warn('getUpdates failed, backing off', { error: errText(e), waitMs: wait });
        await doSleep(wait);
        continue;
      }
      if (stopped) break;
      if (!Array.isArray(updates) || !updates.length) continue;
      for (const u of updates) {
        if (Number.isInteger(u?.update_id)) offset = Math.max(offset, u.update_id + 1);
        enqueue('update', () => onUpdate(u));
      }
      try {
        fs.mkdirSync(paths.stateDir, { recursive: true });
        fs.writeFileSync(offsetFile, String(offset));
      } catch (e) { log.error('offset write failed', { error: errText(e) }); }
    }
  }

  // ---------- HTTP ----------
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (!secretOk(req.headers['x-cc-secret'], secret)) {
      res.statusCode = 403;
      res.end();
      req.resume();
      return;
    }
    if (req.method === 'GET' && url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, sessions: store.sessions.size }));
      return;
    }
    if (req.method !== 'POST' || url !== '/event') {
      res.statusCode = 404;
      res.end();
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(d);
    });
    req.on('end', () => {
      if (tooBig) { res.statusCode = 413; res.end(); log.warn('hook event too large', { size }); return; }
      res.statusCode = 204;
      res.end();
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        log.warn('hook event: invalid JSON');
        return;
      }
      enqueue(`hook ${body?.event}`, () => onHookEvent(body));
    });
    req.on('error', (e) => log.warn('hook request error', { error: errText(e) }));
  });

  const listenPort = port ?? config.port;
  const listenErr = await new Promise((resolve) => {
    server.once('error', resolve);
    server.listen(listenPort, '127.0.0.1', () => { server.off('error', resolve); resolve(null); });
  });
  if (listenErr) {
    if (listenErr.code === 'EADDRINUSE') {
      log.error(`port ${listenPort} is in use — another daemon is probably running`);
      exit(EXIT_PORT_IN_USE);
    } else {
      log.error('http listen failed', { error: errText(listenErr) });
      exit(EXIT_FATAL);
    }
    return null;
  }
  server.on('error', (e) => log.error('http server error', { error: errText(e) }));
  const actualPort = server.address().port;

  // daemon.json: write to temp, restrict ACL, then rename into place.
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const tmp = paths.daemonJson + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ port: actualPort, secret, pid: process.pid }));
    await restrictToUser(tmp, { log });
    fs.renameSync(tmp, paths.daemonJson);
  } catch (e) { log.error('daemon.json write failed', { error: errText(e) }); }

  log.info(`daemon listening on 127.0.0.1:${actualPort}`, { pid: process.pid, sessions: store.sessions.size });
  Promise.resolve()
    .then(() => claudeVersion())
    .then((v) => log.info(`Claude Code version: ${v}`), (e) => log.warn('claude --version failed', { error: errText(e) }));

  // F9: the periodic pass also bounds the store (old closed dialogs, dialogs of removed sessions).
  const pruneTimer = setInterval(() => enqueue('prune', async () => {
    await pruneDead();
    store.pruneDialogs(now());
    for (const sid of ancestorMiss.keys()) if (!store.getSession(sid)) ancestorMiss.delete(sid);
  }), pruneIntervalMs);
  pruneTimer.unref?.();

  pollLoop().catch((e) => log.error('poll loop crashed', { error: errText(e) }));

  return {
    port: actualPort,
    store,
    idle,
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(pruneTimer);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of sleepers) { clearTimeout(s.t); s.resolve(); }
      sleepers.clear();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      if (snapTimer) { clearTimeout(snapTimer); writeSnapshot(); }
      try {
        const cur = JSON.parse(fs.readFileSync(paths.daemonJson, 'utf8'));
        if (cur.secret === secret) fs.rmSync(paths.daemonJson, { force: true });
      } catch { /* already gone */ }
    },
  };
}

// ---------- entry point ----------
// Handlers are installed before anything else runs, so an early failure is logged and
// ends with EXIT_CRASH (restartable) instead of Node's default exit 1 (= "port in use").
async function main(log, secrets) {
  const p = getPaths();
  const config = loadConfig();
  const secret = randomBytes(16).toString('hex');
  secrets.push(config.token, secret);
  const d = await startDaemon({ config, paths: p, log, secret });
  if (!d) return;
  const stop = () => { d.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// An uncaught exception leaves the daemon in an unknown state: log it and exit with EXIT_CRASH so the
// supervisor restarts it. Unhandled rejections are only logged.
export function installProcessHandlers(proc, log, exit = (code) => process.exit(code)) {
  proc.on('unhandledRejection', (e) => log.error('unhandledRejection', { error: String(e?.stack ?? e) }));
  proc.on('uncaughtException', (e) => {
    try { log.error('uncaughtException', { error: String(e?.stack ?? e) }); } finally { exit(EXIT_CRASH); }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const secrets = []; // filled in main(); maskSecrets reads it at write time
  let log = { info() {}, warn() {}, error() {} };
  try { log = createLogger({ dir: getPaths().logsDir, secrets }); } catch { /* keep no-op */ }
  installProcessHandlers(process, log);
  main(log, secrets).catch((e) => {
    log.error('daemon crashed during startup', { error: String(e?.stack ?? e) });
    process.exit(EXIT_CRASH);
  });
}
