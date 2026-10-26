// Pure message formatting (Telegram HTML). User text always goes through esc().

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const header = (label) => `📁 <b>${esc(label || 'сессия')}</b>`;

const STATUS = { done: '✅ завершено', waiting: '⏸ ждёт решения', error: '❌ ошибка' };

export function completionText(label, status, summary) {
  return `${header(label)}\nСтатус: ${STATUS[status] ?? STATUS.done}\n${esc(summary)}`;
}

export function askText(label, question, qIndex, qTotal) {
  const prefix = qTotal > 1 ? `(${qIndex + 1}/${qTotal}) ` : '';
  const lines = [header(label), `❓ ${prefix}<b>${esc(question.header)}</b>`, esc(question.question)];
  if (question.multiSelect) lines.push('Можно выбрать несколько.');
  (question.options ?? []).forEach((o, i) => {
    lines.push(`${i + 1}. <b>${esc(o.label)}</b>${o.description ? ` — ${esc(o.description)}` : ''}`);
  });
  return lines.join('\n');
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
  const other = { text: '✏️ Другое', callback_data: `o|${dlgId}|${qIndex}` };
  rows.push(multi ? [other, { text: '✅ Отправить', callback_data: `s|${dlgId}|${qIndex}` }] : [other]);
  return rows;
}

export function planText(label, plan) {
  return `${header(label)}\n📝 План на подтверждение\n${esc(plan)}`;
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
function preBlock(text, max, what = 'обрезано') {
  const s = String(text ?? '');
  const head = cutSafe(s, max);
  const pre = `<pre>${esc(head)}</pre>`;
  return head.length === s.length ? pre : `${pre}\n⚠ ${what} (всего ${s.length} символов) — полностью в терминале`;
}

const BASH_MAX = 3500;
const EDIT_MAX = 800;
const WRITE_MAX = 1200;
const OTHER_MAX = 1500;

export function permText(label, toolName, toolInput) {
  const inp = toolInput ?? {};
  const str = (v) => typeof v === 'string';
  const lines = [header(label), `🔐 Разрешение: <b>${esc(toolName)}</b>`];
  if (toolName === 'Bash' && str(inp.command)) {
    lines.push(preBlock(inp.command, BASH_MAX, 'команда обрезана'));
  } else if (toolName === 'Edit' && str(inp.file_path)) {
    lines.push(`<pre>${esc(inp.file_path)}</pre>`);
    if (str(inp.old_string)) lines.push('Было:', preBlock(inp.old_string, EDIT_MAX));
    if (str(inp.new_string)) lines.push('Стало:', preBlock(inp.new_string, EDIT_MAX));
  } else if (toolName === 'Write' && str(inp.file_path)) {
    lines.push(`<pre>${esc(inp.file_path)}</pre>`);
    if (str(inp.content)) lines.push(preBlock(inp.content, WRITE_MAX));
  } else {
    lines.push(preBlock(JSON.stringify(inp), OTHER_MAX));
  }
  return lines.join('\n');
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
  if (kind === 'telegram') return `\n\n✔ выбрано: ${esc(chosen)}`;
  if (kind === 'terminal') return '\n\n✔ отвечено в терминале';
  return '\n\n⌛ устарело';
}

// sessions: [{ label, session }]
export function statusText(sessions, now) {
  if (!sessions.length) return 'Активных сессий нет';
  const mins = (t) => Math.max(0, Math.floor((now - t) / 60000));
  return sessions.map(({ label, session: s }) => {
    const st = s.state === 'working' ? `работает ${mins(s.lastPromptAt)} мин`
      : s.state === 'waiting' ? 'ждёт ответа'
      : `простаивает ${mins(s.lastActivityAt)} мин`;
    return `• ${esc(label)} — ${st}`;
  }).join('\n');
}

export function sessionPickKeyboard(items, prefix, msgKey) {
  return items.map(({ label, short }) => [{
    text: label,
    callback_data: msgKey ? `${prefix}|${short}|${msgKey}` : `${prefix}|${short}`,
  }]);
}
