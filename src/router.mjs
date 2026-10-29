// Telegram updates -> Effect[]. Mutates the Store, otherwise pure (no I/O).
import {
  askText, askKeyboard, resolvedSuffix, statusText, sessionPickKeyboard, routePickKeyboard, folderPickKeyboard, esc,
} from './format.mjs';
import { looksLikeDir, newProjectDir, PROJECTS_ROOT } from './dirs.mjs';
import {
  askSequence, planSequence, permissionSequence, instructionSequence, stopSequence, PLAN_FEEDBACK_INDEX,
} from './keys.mjs';

const MAX_EDIT_TEXT = 3900;
const VERIFY_MS = 10000;
const PERM_VERIFY_MS = 120000; // F7: an approved tool may run for a while before PostToolUse
const STOP_DEBOUNCE_MS = 3000; // a second ESC would open the rewind menu

const HELP_TEXT = [
  'Команды:',
  '/status — активные сессии',
  '/stop — остановить сессию (ESC)',
  '/help — эта справка',
  '',
  'Ответьте reply на сообщение проекта, чтобы отправить инструкцию в его сессию.',
  'Сообщение без reply — выбор сессии или «➕ Новая сессия» (откроет терминал в VS Code).',
].join('\n');

const isLive = d => !!d && (d.status === 'open' || d.status === 'injected');
const verifyOf = d => ({ dialogId: d.id, timeoutMs: d.kind === 'perm' ? PERM_VERIFY_MS : VERIFY_MS });
const lastMessageId = d => d.messageIds[d.messageIds.length - 1];

// Mark the dialog's last message as resolved (keyboard removed). kind: 'telegram' | 'stale'.
function resolvedEdit(dialog, chosen, kind = 'telegram') {
  const messageId = lastMessageId(dialog);
  if (messageId == null) return [];
  const suffix = resolvedSuffix(kind, chosen);
  const text = dialog.text ?? '';
  if (text.length > MAX_EDIT_TEXT) {
    return [
      { type: 'edit', messageId, text: null, keyboard: null },
      { type: 'send', text: suffix.trim(), replyTo: messageId, bind: { sessionId: dialog.sessionId } },
    ];
  }
  return [{ type: 'edit', messageId, text: text + suffix, keyboard: null }];
}

function markInjected(store, dialog) {
  dialog.status = 'injected';
  dialog.source = 'telegram';
  if (store.pendingOther === dialog.id) store.pendingOther = null;
}

// After an answer to question `cursor`: show the next question or inject the whole sequence.
function advance(store, dialog, chosenLabel) {
  const questions = dialog.payload?.questions ?? [];
  if (dialog.cursor + 1 < questions.length) {
    const out = resolvedEdit(dialog, chosenLabel);
    if (store.pendingOther === dialog.id) store.pendingOther = null;
    dialog.cursor++;
    dialog.multi = [];
    const q = questions[dialog.cursor];
    dialog.text = askText(store.labelOf(dialog.sessionId), q, dialog.cursor, questions.length);
    out.push({
      type: 'send', text: dialog.text, keyboard: askKeyboard(dialog.id, dialog.cursor, q),
      bind: { sessionId: dialog.sessionId, dialogId: dialog.id },
    });
    return out;
  }
  let steps;
  try {
    steps = askSequence(questions, dialog.answers);
  } catch {
    // Roll back the answer just recorded; the dialog stays open on the same question.
    dialog.answers.splice(dialog.cursor);
    return [{ type: 'send', text: '⚠ Не удалось собрать ответ — ответьте в терминале', bind: { sessionId: dialog.sessionId } }];
  }
  // F3: edits first, inject last — the executor's failure handling (keyboard restore) must run after them.
  const out = [...resolvedEdit(dialog, chosenLabel), { type: 'inject', sessionId: dialog.sessionId, steps, verify: verifyOf(dialog) }];
  markInjected(store, dialog);
  return out;
}

// F2: ESC closes whatever the terminal shows, so live dialogs of the session go stale first.
// Returns null for a repeated stop within STOP_DEBOUNCE_MS (a 2nd ESC opens the rewind menu).
function stopEffects(store, session, now) {
  if (Number.isFinite(now) && session.lastStopAt != null && now - session.lastStopAt < STOP_DEBOUNCE_MS) return null;
  if (Number.isFinite(now)) session.lastStopAt = now;
  const out = [];
  for (const d of [...store.dialogs.values()]) {
    if (d.sessionId !== session.id || !isLive(d)) continue;
    out.push(...resolvedEdit(d, undefined, 'stale'));
    store.closeDialog(d.id, 'stale');
  }
  out.push(
    { type: 'inject', sessionId: session.id, steps: stopSequence() },
    { type: 'send', text: '⏹ Остановлено: ' + esc(store.labelOf(session.id)), bind: { sessionId: session.id } },
  );
  return out;
}
const ALREADY_STOPPED = 'уже остановлено';

// Folder name for messages; works for both separators.
const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p);
const STALE = 'Устарело';

function spawnEffects(route, cwd, pickerId, { create = false } = {}) {
  const out = [];
  const what = (create ? '🆕 Создаю папку и запускаю в ' : '🆕 Запускаю в ') + esc(baseName(cwd)) + '…';
  if (pickerId != null) out.push({ type: 'edit', messageId: pickerId, text: what, keyboard: null });
  const spawn = { type: 'spawn', cwd, text: route.text, replyTo: route.messageId, msgKey: String(route.messageId), pickerId: pickerId ?? null };
  if (create) spawn.create = true;
  out.push(spawn);
  return out;
}

const pickItems = store => store.liveSessions().map(s => ({ label: store.labelOf(s.id), short: s.short }));

// ---------- callbacks ----------

function handleCallback(store, cq, now, ctx) {
  const ack = (text) => (text ? { type: 'answerCallback', callbackId: cq.id, text } : { type: 'answerCallback', callbackId: cq.id });
  const parts = String(cq.data ?? '').split('|');
  const [kind] = parts;

  if (kind === 'x') {
    const s = store.sessionByShort(parts[1]);
    if (!s) return [ack('Сессия завершена')];
    const stop = stopEffects(store, s, now);
    return stop ? [ack(), ...stop] : [ack(ALREADY_STOPPED)];
  }

  if (kind === 'n' || kind === 'f') {
    const route = store.pendingRoute;
    if (!route || String(route.messageId) !== parts[1]) return [ack(STALE)];
    const pickerId = cq.message?.message_id ?? route.pickerId;
    if (kind === 'n') {
      const dirs = ctx.recentDirs ?? [];
      route.folders = dirs.map(d => d.path);
      route.pickerId = pickerId;
      route.awaitingDir = false;
      const out = [ack()];
      if (pickerId != null) {
        out.push({ type: 'edit', messageId: pickerId, text: '📂 Где запустить новую сессию?', keyboard: folderPickKeyboard(dirs, parts[1]) });
      }
      return out;
    }
    if (parts[2] === 'o') {
      route.awaitingDir = true;
      route.pickerId = pickerId;
      return [ack(), { type: 'send', text: `📂 Пришлите полный путь к папке (например ${PROJECTS_ROOT}\\app). Если такой папки в ${PROJECTS_ROOT} нет — создам. Другой текст отменит выбор папки.`, forceReply: true }];
    }
    const cwd = route.folders?.[Number(parts[2])];
    if (cwd == null) return [ack(STALE)];
    store.pendingRoute = null;
    return [ack(), ...spawnEffects(route, cwd, pickerId)];
  }

  if (kind === 'r') {
    const route = store.pendingRoute;
    if (!route || String(route.messageId) !== parts[2]) return [ack(STALE)];
    const s = store.sessionByShort(parts[1]);
    if (!s) return [ack('Сессия завершена')];
    store.pendingRoute = null;
    const out = [ack()];
    const pickerId = cq.message?.message_id;
    if (pickerId != null) out.push({ type: 'edit', messageId: pickerId, text: '➡️ ' + esc(store.labelOf(s.id)), keyboard: null });
    out.push(...deliver(store, s, route.text, { replyTo: route.messageId }));
    return out;
  }

  if (!['a', 't', 's', 'o', 'p'].includes(kind)) return [ack()];

  const d = store.getDialog(parts[1]);
  if (!d || d.status === 'closed') return [ack('Вопрос уже закрыт')];
  if (d.status === 'injected') return [ack('Ответ уже отправлен')];

  if (kind === 'p') {
    const k = Number(parts[2]) - 1;
    if (!Number.isInteger(k) || k < 0 || k >= d.options.length || (d.kind !== 'plan' && d.kind !== 'perm')) return [ack()];
    if (d.kind === 'plan' && k === PLAN_FEEDBACK_INDEX) {
      store.pendingOther = d.id;
      return [ack(), {
        type: 'send', text: '✏️ Напишите, что изменить в плане', forceReply: true,
        bind: { sessionId: d.sessionId, dialogId: d.id, prompt: true },
      }];
    }
    const inj = d.kind === 'plan'
      ? { type: 'inject', sessionId: d.sessionId, steps: planSequence(k), verify: verifyOf(d) }
      : { type: 'inject', sessionId: d.sessionId, steps: permissionSequence(k) };
    const edit = resolvedEdit(d, d.options[k]);
    if (d.kind === 'perm' && k === d.options.length - 1) {
      // F2: "No" produces no hook event at all -> close now instead of leaving it 'injected'.
      store.closeDialog(d.id, 'telegram');
    } else {
      if (d.kind === 'perm') inj.verify = verifyOf(d);
      markInjected(store, d);
    }
    return [ack(), ...edit, inj];
  }

  // ask callbacks: a|dlg|q|opt, t|dlg|q|opt, s|dlg|q, o|dlg|q
  if (d.kind !== 'ask') return [ack()];
  const q = Number(parts[2]);
  if (q !== d.cursor) return [ack('Этот вопрос уже пройден')];
  const question = d.payload?.questions?.[q];
  if (!question) return [ack()];
  const options = question.options ?? [];

  if (kind === 'o') {
    store.pendingOther = d.id;
    return [ack(), {
      type: 'send', text: '✏️ Напишите свой вариант ответа', forceReply: true,
      bind: { sessionId: d.sessionId, dialogId: d.id, prompt: true },
    }];
  }

  if (kind === 's') {
    if (!d.multi.length) return [ack('Выберите хотя бы один вариант')];
    const indexes = [...new Set(d.multi)].sort((x, y) => x - y);
    d.answers[q] = { kind: 'multi', indexes };
    return [ack(), ...advance(store, d, indexes.map(i => options[i]?.label ?? '').join(', '))];
  }

  const i = Number(parts[3]) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= options.length) return [ack()];

  if (kind === 't') {
    d.multi = d.multi.includes(i) ? d.multi.filter(x => x !== i) : [...d.multi, i];
    const messageId = lastMessageId(d);
    const out = [ack()];
    if (messageId != null) out.push({ type: 'edit', messageId, text: d.text ?? null, keyboard: askKeyboard(d.id, q, question, d.multi) });
    return out;
  }

  // kind === 'a'
  d.answers[q] = { kind: 'option', index: i };
  return [ack(), ...advance(store, d, options[i].label)];
}

// ---------- text ----------

// Deliver user text into a session: answer its open dialog or type it as an instruction.
function deliver(store, session, text, { boundDialogId, replyTo } = {}) {
  const bound = boundDialogId ? store.getDialog(boundDialogId) : null;
  const other = store.pendingOther ? store.getDialog(store.pendingOther) : null;
  let d = null;
  if (isLive(bound) && bound.sessionId === session.id) d = bound;
  else if (isLive(other) && other.sessionId === session.id) d = other;
  else d = store.openDialogOf(session.id);

  const bind = { sessionId: session.id };
  if (d) {
    if (d.status === 'injected') {
      return [{ type: 'send', text: '⏳ Предыдущий ответ ещё обрабатывается — повторите через пару секунд', bind }];
    }
    if (d.kind === 'ask') {
      d.answers[d.cursor] = { kind: 'other', text };
      return advance(store, d, text);
    }
    if (d.kind === 'plan') {
      const edit = resolvedEdit(d, 'правки: ' + text);
      markInjected(store, d);
      d.feedbackSent = true; // F6: a later PostToolUse(ExitPlanMode) means the plan got approved instead
      // F3: no verify (rejection emits no event), but dialogId lets a failed inject reopen the dialog.
      return [...edit, { type: 'inject', sessionId: session.id, dialogId: d.id, steps: planSequence(PLAN_FEEDBACK_INDEX, text) }];
    }
    // perm (RF-3): never type free text into a permission prompt.
    return [{ type: 'send', text: '🔐 В сессии открыт запрос разрешения — ответьте кнопками', bind }];
  }

  const sent = { type: 'send', text: '➡️ Отправлено в ' + esc(store.labelOf(session.id)), bind };
  if (replyTo != null) sent.replyTo = replyTo;
  return [{ type: 'inject', sessionId: session.id, steps: instructionSequence(text) }, sent];
}

function handleCommand(store, cmd, now) {
  const live = store.liveSessions();
  if (cmd === '/status') {
    return [{ type: 'send', text: statusText(live.map(s => ({ label: store.labelOf(s.id), session: s })), now) }];
  }
  if (cmd === '/stop') {
    if (!live.length) return [{ type: 'send', text: 'Нет активных сессий' }];
    if (live.length === 1) return stopEffects(store, live[0], now) ?? [{ type: 'send', text: ALREADY_STOPPED }];
    return [{ type: 'send', text: 'Какую сессию остановить?', keyboard: sessionPickKeyboard(pickItems(store), 'x') }];
  }
  return [{ type: 'send', text: HELP_TEXT }]; // /help, /start
}

const COMMANDS = new Set(['/status', '/stop', '/help', '/start']);

function handleMessage(store, msg, now, ctx) {
  if (typeof msg.text !== 'string' || !msg.text.trim()) return [{ type: 'send', text: 'Поддерживается только текст' }];
  const text = msg.text;

  const m = /^(\/[A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(text.trim());
  // Unknown slash commands (e.g. /compact) are passed through to the session as text.
  if (m && COMMANDS.has(m[1].toLowerCase())) return handleCommand(store, m[1].toLowerCase(), now);

  const ended = [{ type: 'send', text: 'Сессия завершена' }];

  // (1) reply to a bound bot message
  const replyId = msg.reply_to_message?.message_id;
  const binding = replyId != null ? store.lookupMessage(replyId) : null;

  // (0) folder path for «Другая папка» (plain text or a reply to the unbound path prompt).
  // Only an absolute path counts; any other text cancels the folder question and is handled normally.
  const route = store.pendingRoute;
  if (route?.awaitingDir && !binding) {
    const dir = text.trim().replace(/^["']+|["']+$/g, '').trim();
    if (looksLikeDir(dir)) {
      if ((ctx.isDir ?? (() => false))(dir)) {
        store.pendingRoute = null;
        return spawnEffects(route, dir, route.pickerId);
      }
      // Missing folder directly inside the projects root → create it; anything else is a typo.
      const created = newProjectDir(dir, ctx.projectsRoot);
      if (created) {
        store.pendingRoute = null;
        return spawnEffects(route, created, route.pickerId, { create: true });
      }
      return [{
        type: 'send', forceReply: true,
        text: `⚠ Папка не найдена — пришлите путь ещё раз (новая папка создаётся только прямо в ${esc(ctx.projectsRoot ?? PROJECTS_ROOT)})`,
      }];
    }
    route.awaitingDir = false;
  }
  if (binding) {
    const s = store.getSession(binding.sessionId);
    if (!s) return ended;
    return deliver(store, s, text, { boundDialogId: binding.dialogId, replyTo: msg.message_id });
  }

  // (2) pending "other" answer
  const other = store.pendingOther ? store.getDialog(store.pendingOther) : null;
  if (isLive(other)) {
    const s = store.getSession(other.sessionId);
    if (!s) return ended;
    return deliver(store, s, text, { replyTo: msg.message_id });
  }

  // (3) always ask: live sessions + «Новая сессия»
  const items = pickItems(store);
  store.pendingRoute = { text, createdAt: now, messageId: msg.message_id };
  return [{
    type: 'send',
    text: items.length ? 'Куда отправить?' : 'Активных сессий нет — запустить новую?',
    keyboard: routePickKeyboard(items, String(msg.message_id)),
  }];
}

// ---------- entry ----------

export function handleUpdate(store, update, { userId, now, ...ctx } = {}) {
  if (userId == null || !update) return [];
  const cq = update.callback_query;
  if (cq) {
    // RF-1: allowlist before anything else.
    if (cq.from?.id !== userId || cq.message?.chat?.type !== 'private') return [];
    return handleCallback(store, cq, now, ctx);
  }
  const msg = update.message;
  if (msg) {
    if (msg.from?.id !== userId || msg.chat?.type !== 'private') return [];
    return handleMessage(store, msg, now, ctx);
  }
  return [];
}
