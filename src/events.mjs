// Hook events -> Effect[]. Mutates the Store, otherwise pure (no I/O).
import { askText, askKeyboard, planText, permText, optionsKeyboard, resolvedSuffix, header, esc } from './format.mjs';
import { PLAN_OPTIONS, permissionOptions } from './keys.mjs';
import { projectName } from './procs.mjs';

const MAX_EDIT_TEXT = 3900;
const COMPLETION_THRESHOLD_MS = 60000;
const DIALOG_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

const isLive = d => d.status === 'open' || d.status === 'injected';

// Edit that marks a dialog message as resolved (keyboard removed).
function resolutionEffects(dialog, kind) {
  const messageId = dialog.messageIds[dialog.messageIds.length - 1];
  if (messageId == null) return [];
  const suffix = resolvedSuffix(kind);
  const text = dialog.text ?? '';
  if (text.length > MAX_EDIT_TEXT) {
    return [
      { type: 'edit', messageId, text: null, keyboard: null },
      { type: 'send', text: suffix.trim(), replyTo: messageId, bind: { sessionId: dialog.sessionId } },
    ];
  }
  return [{ type: 'edit', messageId, text: text + suffix, keyboard: null }];
}

// Close a dialog that ended outside Telegram (or was answered from Telegram).
// otherKind: 'terminal' | 'stale' — used when the answer did not come from Telegram.
function closeResolved(store, dialog, otherKind) {
  if (dialog.source === 'telegram') {
    store.closeDialog(dialog.id, 'telegram');
    return [];
  }
  store.closeDialog(dialog.id, otherKind);
  return resolutionEffects(dialog, otherKind);
}

function liveDialogsOf(store, sessionId) {
  return [...store.dialogs.values()].filter(d => d.sessionId === sessionId && isLive(d));
}

// "Any later event" rule: rejections (No / edit plan) emit no events, so a plan/perm dialog
// still open when the session moves on is resolved. `keep(d)` exempts specific dialogs.
function closeStalePlanPerm(store, sessionId, keep = () => false) {
  const out = [];
  for (const d of liveDialogsOf(store, sessionId)) {
    if ((d.kind === 'plan' || d.kind === 'perm') && !keep(d)) out.push(...closeResolved(store, d, 'terminal'));
  }
  return out;
}

function closeStaleAsk(store, sessionId) {
  const out = [];
  for (const d of liveDialogsOf(store, sessionId)) {
    if (d.kind === 'ask') out.push(...closeResolved(store, d, 'stale'));
  }
  return out;
}

function expectedLabel(question, answer) {
  const opts = question.options ?? [];
  if (answer.kind === 'option') return opts[answer.index]?.label ?? '';
  if (answer.kind === 'multi') return [...answer.indexes].sort((a, b) => a - b).map(i => opts[i]?.label ?? '').join(', ');
  if (answer.kind === 'other') return answer.text ?? '';
  return '';
}

function mismatchEffects(store, dialog, payload) {
  const questions = dialog.payload?.questions ?? [];
  const actualMap = payload.tool_response?.answers ?? {};
  const out = [];
  questions.forEach((q, i) => {
    const ans = dialog.answers[i];
    if (!ans) return;
    const expected = expectedLabel(q, ans);
    const actual = actualMap[q.question];
    if (actual === undefined || actual === expected) return;
    out.push({
      type: 'send',
      text: `${header(store.labelOf(dialog.sessionId))}\n⚠ в сессию ушло «${esc(actual)}», а не «${esc(expected)}» — проверьте терминал`,
      bind: { sessionId: dialog.sessionId },
    });
  });
  return out;
}

function sameToolCall(dialog, payload) {
  return dialog.toolName === payload.tool_name
    && JSON.stringify(dialog.payload ?? null) === JSON.stringify(payload.tool_input ?? null);
}

function openWithMessage(store, sid, now, { kind, toolUseId, toolName, input, options, text, keyboard }) {
  const d = store.openDialog({ sessionId: sid, kind, toolUseId, payload: input, options });
  d.createdAt = now;
  d.toolName = toolName;
  d.text = text;
  return [{ type: 'send', text, keyboard: keyboard(d.id), bind: { sessionId: sid, dialogId: d.id } }];
}

function bookkeeping(store, sid, ev, payload, now) {
  const prev = store.getSession(sid);
  if (!prev) {
    const cwd = payload.cwd ?? '';
    return store.upsertSession({
      id: sid, cwd, project: projectName(cwd),
      branch: ev.branch ?? '—', pid: ev.claudePid ?? null, lastActivityAt: now,
    });
  }
  return store.upsertSession({
    id: sid,
    pid: ev.claudePid ?? undefined,
    branch: ev.branch ?? undefined,
    lastActivityAt: now,
  });
}

export function handleHookEvent(store, ev, now) {
  const payload = ev?.payload ?? {};
  const sid = payload.session_id;
  if (!sid) return [];
  const event = ev.event ?? payload.hook_event_name;
  const session = bookkeeping(store, sid, ev, payload, now);
  const label = () => store.labelOf(sid);
  const tool = payload.tool_name;

  switch (event) {
    case 'SessionStart': {
      const cwd = payload.cwd ?? session.cwd;
      store.upsertSession({ id: sid, cwd, project: projectName(cwd), state: 'idle', lastActivityAt: now });
      return [];
    }

    case 'UserPromptSubmit': {
      const out = [...closeStaleAsk(store, sid), ...closeStalePlanPerm(store, sid)];
      session.state = 'working';
      session.lastPromptAt = now;
      return out;
    }

    case 'PreToolUse': {
      // Don't close the perm dialog of this very call (async hooks may deliver PermissionRequest first).
      const out = closeStalePlanPerm(store, sid, d => d.kind === 'perm' && sameToolCall(d, payload));
      if (tool === 'AskUserQuestion') {
        const input = payload.tool_input ?? {};
        const questions = input.questions ?? [];
        if (!questions.length) return out;
        session.state = 'waiting';
        out.push(...openWithMessage(store, sid, now, {
          kind: 'ask', toolUseId: payload.tool_use_id ?? null, toolName: tool, input, options: [],
          text: askText(label(), questions[0], 0, questions.length),
          keyboard: id => askKeyboard(id, 0, questions[0]),
        }));
      } else if (tool === 'ExitPlanMode') {
        session.state = 'waiting';
        const input = payload.tool_input ?? {};
        out.push(...openWithMessage(store, sid, now, {
          kind: 'plan', toolUseId: payload.tool_use_id ?? null, toolName: tool, input,
          options: [...PLAN_OPTIONS], text: planText(label(), input.plan ?? ''),
          keyboard: id => optionsKeyboard(id, PLAN_OPTIONS),
        }));
      }
      return out;
    }

    case 'PermissionRequest': {
      if (DIALOG_TOOLS.has(tool)) return [];
      session.state = 'waiting';
      const options = permissionOptions(payload.permission_suggestions ?? []);
      return openWithMessage(store, sid, now, {
        kind: 'perm', toolUseId: null, toolName: tool, input: payload.tool_input ?? {},
        options, text: permText(label(), tool, payload.tool_input),
        keyboard: id => optionsKeyboard(id, options),
      });
    }

    case 'PostToolUse': {
      session.state = 'working';
      const d = store.findDialogForTool(sid, tool, payload.tool_use_id);
      if (!d || !isLive(d)) return [];
      if (!DIALOG_TOOLS.has(tool) && d.kind !== 'perm') return [];
      if (d.source === 'telegram') {
        store.closeDialog(d.id, 'telegram');
        return d.kind === 'ask' ? mismatchEffects(store, d, payload) : [];
      }
      store.closeDialog(d.id, 'terminal');
      return resolutionEffects(d, 'terminal');
    }

    case 'Stop':
    case 'StopFailure': {
      const out = [...closeStaleAsk(store, sid), ...closeStalePlanPerm(store, sid)];
      session.state = 'idle';
      if (event === 'StopFailure') {
        out.push({ type: 'completion', sessionId: sid, lastMessage: payload.last_assistant_message ?? payload.error ?? '', failed: true });
      } else if (session.lastPromptAt != null && now - session.lastPromptAt >= COMPLETION_THRESHOLD_MS) {
        out.push({ type: 'completion', sessionId: sid, lastMessage: payload.last_assistant_message ?? '', failed: false });
      }
      return out;
    }

    case 'SessionEnd': {
      const out = [];
      for (const d of store.removeSession(sid)) {
        if (d.source !== 'telegram') out.push(...resolutionEffects(d, 'stale'));
      }
      return out;
    }

    default:
      return [];
  }
}
