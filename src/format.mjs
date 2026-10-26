// Pure message formatting (Telegram HTML). User text always goes through esc().

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const header = (label) => `📁 <b>${esc(label)}</b>`;

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

export function permText(label, toolName, toolInput) {
  const inp = toolInput ?? {};
  let body;
  if (toolName === 'Bash' && typeof inp.command === 'string') body = inp.command;
  else if ((toolName === 'Edit' || toolName === 'Write') && typeof inp.file_path === 'string') body = inp.file_path;
  else body = JSON.stringify(inp);
  if (body.length > 1500) body = body.slice(0, 1500) + '…';
  return `${header(label)}\n🔐 Разрешение: <b>${esc(toolName)}</b>\n<pre>${esc(body)}</pre>`;
}

export function optionsKeyboard(dlgId, options) {
  return options.map((t, i) => [{ text: `${i + 1}. ${t}`, callback_data: `p|${dlgId}|${i + 1}` }]);
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
