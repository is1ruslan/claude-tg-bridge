// Bot UI language (CC_TG_LANG in .env): 'en' (default) or 'ru'. Set once by the daemon at startup.
let lang = 'en';

export const LANGS = ['en', 'ru'];
export const normLang = (l) => (LANGS.includes(String(l ?? '').trim().toLowerCase()) ? String(l).trim().toLowerCase() : 'en');
export const setLang = (l) => { lang = normLang(l); };
export const getLang = () => lang;

const EN = {
  help: [
    'Commands:',
    '/status — active sessions',
    '/stop — stop a session (ESC)',
    '/help — this help',
    '',
    'Reply to a project message to send an instruction to its session.',
    '',
    'A message without reply — pick a session or «➕ New session» (opens a terminal in VS Code).',
  ].join('\n'),
  session: 'session',
  status: (s) => `Status: ${s}`,
  statusDone: '✅ done',
  statusWaiting: '⏸ waiting for you',
  statusError: '❌ error',
  multiSelect: 'You can pick several.',
  other: '✏️ Other',
  submit: '✅ Submit',
  planHeader: '📝 Plan for approval',
  cut: 'cut',
  cmdCut: 'command cut',
  cutNote: (what, n) => `⚠ ${what} (${n} chars total) — full text in the terminal`,
  permission: (tool) => `🔐 Permission: <b>${tool}</b>`,
  before: 'Before:',
  after: 'After:',
  chosen: (c) => `✔ chosen: ${c}`,
  answeredInTerminal: '✔ answered in the terminal',
  stale: '⌛ stale',
  noSessions: 'No active sessions',
  working: (m) => `working ${m} min`,
  waitingAnswer: 'waiting for an answer',
  idle: (m) => `idle ${m} min`,
  newSession: '➕ New session',
  otherFolder: '📂 Other folder',
  planOptions: ['✅ Yes, auto mode', '✅ Yes, manual edits', '✏️ Change the plan'],
  permYes: '✅ Yes',
  permNo: '⛔ No',
  permMode: (m) => `✅ Yes + mode ${m}`,
  permRule: (r) => `✅ Yes + don't ask again: ${r}`,
  permRemember: '✅ Yes + remember',
  answerFailed: '⚠ Could not build the answer — answer in the terminal',
  stopped: (l) => `⏹ Stopped: ${l}`,
  alreadyStopped: 'already stopped',
  staleAck: 'Stale',
  spawning: (n) => `🆕 Starting in ${n}…`,
  spawningCreate: (n) => `🆕 Creating the folder and starting in ${n}…`,
  sessionEnded: 'Session ended',
  whereNewSession: '📂 Where to start the new session?',
  askPath: (root) => `📂 Send the full path to the folder (e.g. ${root}\\app). If there is no such folder in ${root}, I will create it. Any other text cancels the folder choice.`,
  questionClosed: 'The question is already closed',
  answerSent: 'Answer already sent',
  planEditPrompt: '✏️ Write what to change in the plan',
  questionPassed: 'This question is already past',
  otherPrompt: '✏️ Write your own answer',
  pickOne: 'Pick at least one option',
  busy: '⏳ The previous answer is still being processed — retry in a couple of seconds',
  planEdits: (t) => `edits: ${t}`,
  permOpen: '🔐 A permission request is open in the session — answer with the buttons',
  sentTo: (l) => `➡️ Sent to ${l}`,
  whichStop: 'Which session to stop?',
  textOnly: 'Only text is supported',
  folderNotFound: (root) => `⚠ Folder not found — send the path again (a new folder is created only directly inside ${root})`,
  whereSend: 'Where to send it?',
  noSessionsStart: 'No active sessions — start a new one?',
  retryNote: '⚠ could not type it in — choose again',
  procCheckFailed: '⚠ could not check the session process, answer in the terminal',
  sessionEndedLabel: (l) => `Session ended: ${l}`,
  injectFailed: (e) => `⚠ could not type into the terminal: ${e}`,
  unknownError: 'unknown error',
  permNotConfirmed: '⚠ the permission answer was not confirmed within 2 min — check the terminal',
  answerNotConfirmed: '⚠ could not confirm the answer — check the terminal',
  mkdirFailed: (d, e) => `⚠ Could not create the folder ${d}: ${e}`,
  started: (n) => `🆕 Started: ${n}`,
  notStarted: (n) => `⚠ Not started: ${n}`,
  vscodeDown: '⚠ VS Code is not responding — the session was not created',
  spawnFailed: (e) => `⚠ Could not start the session: ${e}`,
  error: 'error',
  retry: '🔁 Retry',
  emptyReply: '(empty reply)',
  mismatch: (a, e) => `⚠ the session got «${a}», not «${e}» — check the terminal`,
  planApprovedInstead: '⚠ the plan was approved instead of sending the edits — check the terminal',
  summaryPrompt:
    'You summarize an assistant report for a Telegram message. Reply with JSON ONLY, no markdown: ' +
    '{"status":"done|waiting|error","summary":"..."}. ' +
    'status=waiting if the assistant waits for a decision or asked a question, error if it reports a failure, otherwise done. ' +
    'summary — in English, plain text without markdown, separate paragraphs with a blank line (\\n\\n). ' +
    'If status=waiting: the person has to decide without reading the original report, so do not over-compress — ' +
    'up to ~700 characters, 3–4 paragraphs: (1) what is already done and the state of the work; ' +
    '(2) what the question is and why it came up; (3) the options — each on its own line starting with "- ", with its consequence in a few words, ' +
    "and the assistant's recommendation if there is one; (4) what exactly to answer. " +
    'Keep specifics: file names, numbers, option names. ' +
    'Otherwise: 2–5 short lines — what is done, what is left, what is needed from the user (if anything); each thought its own paragraph. ' +
    'No filler, no preamble.',
};

const RU = {
  help: [
    'Команды:',
    '/status — активные сессии',
    '/stop — остановить сессию (ESC)',
    '/help — эта справка',
    '',
    'Ответьте reply на сообщение проекта, чтобы отправить инструкцию в его сессию.',
    '',
    'Сообщение без reply — выбор сессии или «➕ Новая сессия» (откроет терминал в VS Code).',
  ].join('\n'),
  session: 'сессия',
  status: (s) => `Статус: ${s}`,
  statusDone: '✅ завершено',
  statusWaiting: '⏸ ждёт решения',
  statusError: '❌ ошибка',
  multiSelect: 'Можно выбрать несколько.',
  other: '✏️ Другое',
  submit: '✅ Отправить',
  planHeader: '📝 План на подтверждение',
  cut: 'обрезано',
  cmdCut: 'команда обрезана',
  cutNote: (what, n) => `⚠ ${what} (всего ${n} символов) — полностью в терминале`,
  permission: (tool) => `🔐 Разрешение: <b>${tool}</b>`,
  before: 'Было:',
  after: 'Стало:',
  chosen: (c) => `✔ выбрано: ${c}`,
  answeredInTerminal: '✔ отвечено в терминале',
  stale: '⌛ устарело',
  noSessions: 'Активных сессий нет',
  working: (m) => `работает ${m} мин`,
  waitingAnswer: 'ждёт ответа',
  idle: (m) => `простаивает ${m} мин`,
  newSession: '➕ Новая сессия',
  otherFolder: '📂 Другая папка',
  planOptions: ['✅ Да, auto mode', '✅ Да, правки вручную', '✏️ Изменить план'],
  permYes: '✅ Да',
  permNo: '⛔ Нет',
  permMode: (m) => `✅ Да + режим ${m}`,
  permRule: (r) => `✅ Да + не спрашивать: ${r}`,
  permRemember: '✅ Да + запомнить',
  answerFailed: '⚠ Не удалось собрать ответ — ответьте в терминале',
  stopped: (l) => `⏹ Остановлено: ${l}`,
  alreadyStopped: 'уже остановлено',
  staleAck: 'Устарело',
  spawning: (n) => `🆕 Запускаю в ${n}…`,
  spawningCreate: (n) => `🆕 Создаю папку и запускаю в ${n}…`,
  sessionEnded: 'Сессия завершена',
  whereNewSession: '📂 Где запустить новую сессию?',
  askPath: (root) => `📂 Пришлите полный путь к папке (например ${root}\\app). Если такой папки в ${root} нет — создам. Другой текст отменит выбор папки.`,
  questionClosed: 'Вопрос уже закрыт',
  answerSent: 'Ответ уже отправлен',
  planEditPrompt: '✏️ Напишите, что изменить в плане',
  questionPassed: 'Этот вопрос уже пройден',
  otherPrompt: '✏️ Напишите свой вариант ответа',
  pickOne: 'Выберите хотя бы один вариант',
  busy: '⏳ Предыдущий ответ ещё обрабатывается — повторите через пару секунд',
  planEdits: (t) => `правки: ${t}`,
  permOpen: '🔐 В сессии открыт запрос разрешения — ответьте кнопками',
  sentTo: (l) => `➡️ Отправлено в ${l}`,
  whichStop: 'Какую сессию остановить?',
  textOnly: 'Поддерживается только текст',
  folderNotFound: (root) => `⚠ Папка не найдена — пришлите путь ещё раз (новая папка создаётся только прямо в ${root})`,
  whereSend: 'Куда отправить?',
  noSessionsStart: 'Активных сессий нет — запустить новую?',
  retryNote: '⚠ не удалось ввести — выберите снова',
  procCheckFailed: '⚠ не удалось проверить процесс сессии, ответьте в терминале',
  sessionEndedLabel: (l) => `Сессия завершена: ${l}`,
  injectFailed: (e) => `⚠ не удалось ввести в терминал: ${e}`,
  unknownError: 'неизвестная ошибка',
  permNotConfirmed: '⚠ ответ на разрешение не подтверждён за 2 мин — проверьте терминал',
  answerNotConfirmed: '⚠ не удалось подтвердить ответ — проверьте терминал',
  mkdirFailed: (d, e) => `⚠ Не удалось создать папку ${d}: ${e}`,
  started: (n) => `🆕 Запущено: ${n}`,
  notStarted: (n) => `⚠ Не запущено: ${n}`,
  vscodeDown: '⚠ VS Code не отвечает — сессия не создана',
  spawnFailed: (e) => `⚠ Не удалось запустить сессию: ${e}`,
  error: 'ошибка',
  retry: '🔁 Повторить',
  emptyReply: '(пустой ответ)',
  mismatch: (a, e) => `⚠ в сессию ушло «${a}», а не «${e}» — проверьте терминал`,
  planApprovedInstead: '⚠ план был одобрен вместо отправки правок — проверьте терминал',
  summaryPrompt:
    'Ты пересказываешь отчёт ассистента для сообщения в Telegram. Ответь ТОЛЬКО JSON без markdown: ' +
    '{"status":"done|waiting|error","summary":"..."}. ' +
    'status=waiting если ассистент ждёт решения или задал вопрос, error если сообщает о неудаче, иначе done. ' +
    'summary — по-русски, простым текстом без markdown, абзацы разделяй пустой строкой (\\n\\n). ' +
    'Если status=waiting: человеку нужно принять решение, не читая исходный отчёт, поэтому не пережимай — ' +
    'до ~700 символов, 3–4 абзаца: (1) что уже сделано и в каком состоянии работа; ' +
    '(2) в чём вопрос и почему он возник; (3) варианты — каждый с новой строки через "- ", с последствием в несколько слов, ' +
    'и рекомендация ассистента, если она есть; (4) что именно нужно ответить. ' +
    'Сохраняй конкретику: имена файлов, числа, названия вариантов. ' +
    'Иначе: 2–5 коротких строк — что сделано, что осталось, что нужно от пользователя (если нужно); каждая мысль отдельным абзацем. ' +
    'Без воды и вступлений.',
};

export const STRINGS = { en: EN, ru: RU };

// t('key', ...args): a string, or the result of calling the entry with args.
export function t(key, ...args) {
  const v = STRINGS[lang][key] ?? EN[key];
  if (v === undefined) throw new Error(`i18n: unknown key ${key}`);
  return typeof v === 'function' ? v(...args) : v;
}
