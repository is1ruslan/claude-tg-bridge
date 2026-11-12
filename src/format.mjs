// Pure message formatting (Telegram HTML). User text always goes through esc().
import { t } from './i18n.mjs';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const header = (label) => `📁 <b>${esc(label || t('session'))}</b>`;

const STATUS = { done: 'statusDone', waiting: 'statusWaiting', error: 'statusError' };

// Blocks of a message are separated by a blank line so it reads easily in Telegram.
const blocks = (...parts) => parts.filter((p) => p != null && p !== '').join('\n\n');

const LIST_ITEM = /^\s*([-•*–]|\d+[.)])\s/;

// Free text (summaries): a blank line between prose lines; list items stay together,
// and a list hangs on the line that introduces it. Runs of blank lines collapse to one.
export function paragraphs(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd());
  const out = [];
  let prev = null; // previous non-empty line
  for (const line of lines) {
    if (!line.trim()) { prev = null; continue; }
    if (out.length) {
      out.push(prev != null && LIST_ITEM.test(line) ? '\n' : '\n\n');
    }
    out.push(line);
    prev = line;
  }
  return out.join('');
}

export function completionText(label, status, summary) {
  return blocks(header(label), t('status', t(STATUS[status] ?? STATUS.done)), paragraphs(esc(summary)));
}

export function askText(label, question, qIndex, qTotal) {
  const prefix = qTotal > 1 ? `(${qIndex + 1}/${qTotal}) ` : '';
  const options = question.options ?? [];
  const items = options.map((o, i) => `${i + 1}. <b>${esc(o.label)}</b>${o.description ? ` — ${esc(o.description)}` : ''}`);
  // Options with descriptions are small paragraphs; bare labels read better as a compact list.
  const list = items.join(options.some((o) => o.description) ? '\n\n' : '\n');
  return blocks(
    header(label),
    `❓ ${prefix}<b>${esc(question.header)}</b>`,
    esc(question.question),
    question.multiSelect ? t('multiSelect') : null,
    list,
  );
}

// selected: 0-based option indexes. callback opt is 1-based (same as the number shown).
export function askKeyboard(dlgId, qIndex, question, selected = []) {
  const multi = !!question.multiSelect;
  const btns = (question.options ?? []).map((_, i) => {
    const k = i + 1;
    return multi
      ? { text: `${selected.includes(i) ? '☑' : '☐'} ${k}`, callback_data: `t|${dlgId}|${qIndex}|${k}` }
      : { text: String(k), callback_data: `a|${dlgId}|${qIndex}|${k}` };
  });
  const rows = [];
  for (let i = 0; i < btns.length; i += 5) rows.push(btns.slice(i, i + 5));
  const other = { text: t('other'), callback_data: `o|${dlgId}|${qIndex}` };
  rows.push(multi ? [other, { text: t('submit'), callback_data: `s|${dlgId}|${qIndex}` }] : [other]);
  return rows;
}

export function planText(label, plan) {
  return blocks(header(label), t('planHeader'), esc(plan));
}

// Cut to at most `max` UTF-16 units without splitting a surrogate pair.
function cutSafe(s, max) {
  if (s.length <= max) return s;
  let head = s.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head;
}

// <pre> block, plus a ⚠ note line when the text had to be cut.
function preBlock(text, max, what = t('cut')) {
  const s = String(text ?? '');
  const head = cutSafe(s, max);
  const pre = `<pre>${esc(head)}</pre>`;
  return head.length === s.length ? pre : `${pre}\n${t('cutNote', what, s.length)}`;
}

const BASH_MAX = 3500;
const EDIT_MAX = 800;
const WRITE_MAX = 1200;
const OTHER_MAX = 1500;

export function permText(label, toolName, toolInput) {
  const inp = toolInput ?? {};
  const str = (v) => typeof v === 'string';
  const lines = [header(label), t('permission', esc(toolName))];
  if (toolName === 'Bash' && str(inp.command)) {
    lines.push(preBlock(inp.command, BASH_MAX, t('cmdCut')));
  } else if (toolName === 'Edit' && str(inp.file_path)) {
    lines.push(`<pre>${esc(inp.file_path)}</pre>`);
    if (str(inp.old_string)) lines.push(t('before') + '\n' + preBlock(inp.old_string, EDIT_MAX));
    if (str(inp.new_string)) lines.push(t('after') + '\n' + preBlock(inp.new_string, EDIT_MAX));
  } else if (toolName === 'Write' && str(inp.file_path)) {
    lines.push(`<pre>${esc(inp.file_path)}</pre>`);
    if (str(inp.content)) lines.push(preBlock(inp.content, WRITE_MAX));
  } else {
    lines.push(preBlock(JSON.stringify(inp), OTHER_MAX));
  }
  return blocks(...lines);
}

export function optionsKeyboard(dlgId, options) {
  return options.map((t, i) => [{ text: `${i + 1}. ${t}`, callback_data: `p|${dlgId}|${i + 1}` }]);
}

// Keyboard matching a dialog's current state (restored after a failed inject).
export function dialogKeyboard(dlg) {
  if (dlg.kind === 'ask') {
    const q = dlg.payload?.questions?.[dlg.cursor];
    return q ? askKeyboard(dlg.id, dlg.cursor, q, dlg.multi ?? []) : null;
  }
  return optionsKeyboard(dlg.id, dlg.options ?? []);
}

export function resolvedSuffix(kind, chosen) {
  if (kind === 'telegram') return `\n\n${t('chosen', esc(chosen))}`;
  if (kind === 'terminal') return `\n\n${t('answeredInTerminal')}`;
  return `\n\n${t('stale')}`;
}

// sessions: [{ label, session }]
export function statusText(sessions, now) {
  if (!sessions.length) return t('noSessions');
  const mins = (at) => Math.max(0, Math.floor((now - at) / 60000));
  return sessions.map(({ label, session: s }) => {
    const st = s.state === 'working' ? t('working', mins(s.lastPromptAt))
      : s.state === 'waiting' ? t('waitingAnswer')
      : t('idle', mins(s.lastActivityAt));
    return `• ${esc(label)} — ${st}`;
  }).join('\n');
}

export function sessionPickKeyboard(items, prefix, msgKey) {
  return items.map(({ label, short }) => [{
    text: label,
    callback_data: msgKey ? `${prefix}|${short}|${msgKey}` : `${prefix}|${short}`,
  }]);
}

// Session picker for plain text: live sessions (r|short|key) + «New session» (n|key).
export function routePickKeyboard(items, msgKey) {
  return [...sessionPickKeyboard(items, 'r', msgKey), [{ text: t('newSession'), callback_data: `n|${msgKey}` }]];
}

// dirs: [{ label }] -> f|key|i rows + «Other folder» (f|key|o).
export function folderPickKeyboard(dirs, msgKey) {
  return [
    ...dirs.map(({ label }, i) => [{ text: '📁 ' + label, callback_data: `f|${msgKey}|${i}` }]),
    [{ text: t('otherFolder'), callback_data: `f|${msgKey}|o` }],
  ];
}
