# cc-telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Глобальный мост Claude Code ↔ Telegram для Windows: уведомления о завершении, вопросы/планы/разрешения с кнопками («первый ответ побеждает» между терминалом и Telegram), инструкции и `/status` `/stop` из бота, несколько сессий.

**Architecture:** Async-хуки Claude Code (`node src/hook.js <Event>`) шлют события в один долгоживущий демон на `127.0.0.1`. Демон — единственный поллер Telegram (long polling), хранит сессии/диалоги, а ответы и инструкции доставляет в живую сессию вводом в её консоль (`inject.exe`: AttachConsole + WriteConsoleInputW). Логика — чистые функции «состояние + событие → список эффектов», исполнитель эффектов в демоне.

**Tech Stack:** Node 22 (ESM `.mjs`, **ноль npm-зависимостей**), `node:test`, встроенный `fetch`, C# (`csc.exe` из .NET Framework 4.x) для `inject.exe`, Планировщик заданий Windows.

**Spec:** `docs/superpowers/specs/2026-10-26-telegram-bridge-design.md` — читать вместе с планом.

## Global Constraints

- Только Windows 10, Node ≥ 22, Claude Code 2.1.310; терминал VS Code / PowerShell.
- Никаких npm-зависимостей и postinstall. Сеть — только `https://api.telegram.org`.
- Рантайм-данные: `%USERPROFILE%\.claude\telegram\` → `.env`, `state\`, `logs\`, `disabled` (флаг). Код: `C:\Projects\cc-telegram`.
- `.env` ключи: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`, опционально `CC_TG_PORT` (по умолчанию `47833`). Создаётся с пустыми значениями; ACL только текущему пользователю (`icacls /inheritance:r /grant:r "%USERNAME%:F"`). В git — никогда (`.gitignore`).
- Токен никогда не пишется в логи: любой лог-вывод проходит `maskSecrets`.
- Хук всегда exit 0, никогда не пишет в stdout, суммарно ≤ 2 с; все хуки в settings.json с `"async": true`.
- `CC_TELEGRAM_DISABLE=1` в env или файл `disabled` → хук ничего не делает.
- Порог уведомления о завершении: `60000` мс от последнего UserPromptSubmit. StopFailure → ❌ всегда.
- Пункт «Chat about this» (N+2) не нажимается никогда.
- Enter после текста — отдельной записью, пауза перед ним `400` мс.
- Язык всех текстов бота — русский.

## Review Focus

1. Апдейт от чужого `from.id` (сообщение, кнопка, reply, команда) → ноль исходящих запросов к Telegram и ноль инъекций.
2. Кнопка нажата по диалогу, который уже закрыт терминалом (PostToolUse пришёл раньше) → только `answerCallbackQuery` с «вопрос уже закрыт», никакой инъекции.
3. Текст в бота, когда у целевой сессии открыт диалог разрешения/плана без поля для текста → ничего не вводится, ответ «ответьте кнопками».
4. Демон не запущен / порт занят чужим / Telegram недоступен → хук завершается < 2 с с exit 0; демон продолжает поллинг с backoff.
5. Сессия, чей `claude.exe` умер без SessionEnd (закрыли вкладку терминала) → исчезает из `/status`, инструкция в неё не вводится (вводить в чужой переиспользованный PID нельзя — сверять имя процесса `claude.exe`).

Тесты на каждую строку добавлены в задачи-владельцы (помечены «RF-n»).

---

## Структура файлов

```
package.json            # "type":"module", scripts.test = "node --test test/"
.gitignore              # .env, *.exe, node_modules, state/
native/inject.cs        # консольный ввод (C#)
native/build.mjs        # компиляция csc.exe → native/inject.exe
src/config.mjs          # пути, загрузка .env, daemon.json
src/log.mjs             # логгер с ротацией + maskSecrets
src/telegram.mjs        # клиент Bot API (fetch инжектируется)
src/keys.mjs            # последовательности клавиш для окон Claude Code
src/inject.mjs          # запуск inject.exe, очередь на pid
src/procs.mjs           # поиск pid claude.exe, жив ли pid, git-ветка
src/sessions.mjs        # Store: сессии, диалоги, message→session, снимок
src/format.mjs          # тексты сообщений и клавиатуры
src/events.mjs          # хук-события → эффекты (чисто)
src/router.mjs          # Telegram-апдейты → эффекты (чисто)
src/summary.mjs         # сжатие через claude -p --model haiku
src/daemon.mjs          # HTTP + поллинг + исполнитель эффектов
src/supervisor.mjs      # перезапуск демона при падении
src/hook.mjs            # клиент хука
src/settings.mjs        # слияние/удаление хуков в ~/.claude/settings.json
src/cli.mjs             # install/uninstall/status/logs/test/enable/disable
scripts/launch.vbs      # скрытый запуск supervisor (для Планировщика)
docs/ui-keymap.md       # раскладки окон Claude Code (из Task 0)
test/fixtures/hooks/*.json
test/*.test.mjs
README.md               # шпаргалка
```

## Общие типы (используются всеми задачами)

```js
// Step — шаг ввода в консоль
{ key: 'DOWN'|'UP'|'ENTER'|'ESC'|'TAB'|'LEFT'|'RIGHT' } | { text: string } | { sleep: number }
// (цифра — это { text: '3' })

// Effect — результат чистой логики, исполняется демоном
{ type: 'send', text, keyboard?, replyTo?, forceReply?, bind?: { sessionId, dialogId? } }
{ type: 'edit', messageId, text, keyboard: null | InlineKeyboard }
{ type: 'answerCallback', callbackId, text? }
{ type: 'inject', sessionId, steps: Step[], verify?: { dialogId, timeoutMs: 10000 } }
{ type: 'completion', sessionId, lastMessage: string, failed: boolean }   // демон → summary → send

// InlineKeyboard = Array<Array<{ text, callback_data }>>
```

callback_data (≤ 64 байт): `a|<dlg>|<q>|<opt>` выбор, `t|<dlg>|<q>|<opt>` переключатель multi, `s|<dlg>|<q>` отправить multi, `o|<dlg>|<q>` «Другое», `p|<dlg>|<opt>` пункт окна плана/разрешения, `x|<sid8>` stop-выбор, `r|<sid8>|<msgKey>` выбор сессии для инструкции. `<dlg>` — 6 символов base36, `<sid8>` — первые 8 символов session_id.

---

### Task 0: Разведка (выполняет контроллер вместе с пользователем, не субагент)

**Files:**
- Create: `test/fixtures/hooks/*.json`, `docs/ui-keymap.md`, `spike/inject.ps1` (перенос из scratchpad как референс)

- [ ] **Step 1:** В `C:\Projects\tg-spike\.claude\settings.json` (только проектный scope) поставить временный хук-логгер на события SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop, StopFailure, SessionEnd, Notification: `node -e` дописывает stdin + `process.ppid` в `C:\Projects\tg-spike\payloads.jsonl`.
- [ ] **Step 2:** С пользователем вызвать: AskUserQuestion одиночный (3 варианта) с ответом цифрой; одиночный с «Другое»; multiSelect; 2 вопроса в одном вызове; план (ExitPlanMode) — одобрить и отклонить с текстом; запрос разрешения (в обычном режиме разрешений, напр. `default`); ошибка не обязательна.
- [ ] **Step 3:** Для каждого окна подобрать и проверить последовательности клавиш через `spike/inject.ps1`, пользователь подтверждает результат. Зафиксировать в `docs/ui-keymap.md`: для каждого типа окна — точный текст пунктов, работает ли цифра, что делает Enter, как попасть в «Другое»/поле текста, экран Review. Особо: (а) отправляет ли Enter текст «Другое» в одиночном вопросе; (б) переключают ли цифры галочки в multiSelect; (в) куда переходит курсор после ответа на вкладку k; (г) пункты окна плана и окна разрешения, есть ли поле для текста; (д) срабатывает ли PermissionRequest в auto mode.
- [ ] **Step 4:** Разложить payload'ы в `test/fixtures/hooks/` (по одному на файл): `SessionStart.json`, `UserPromptSubmit.json`, `PreToolUse-Ask-single.json`, `PreToolUse-Ask-multi.json`, `PreToolUse-Ask-two.json`, `PostToolUse-Ask-single.json`, `PostToolUse-Ask-other.json`, `PreToolUse-ExitPlanMode.json`, `PostToolUse-ExitPlanMode.json`, `PermissionRequest.json`, `PostToolUse-Bash.json`, `Stop.json`, `SessionEnd.json` (+ `StopFailure.json`, если событие существует). Каждый добавлен с полем `"ppid"`. Убрать личные данные кроме путей.
- [ ] **Step 5:** Удалить временный хук из tg-spike. Commit `chore: hook payload fixtures and UI keymap`.

Если какое-то допущение спеки не подтвердилось (например, StopFailure нет, PermissionRequest не срабатывает) — контроллер правит план (Interfaces задач 3, 8) до старта Task 1.

---

### Task 1: Каркас, конфиг, логгер

**Files:**
- Create: `package.json`, `.gitignore`, `src/config.mjs`, `src/log.mjs`
- Test: `test/config.test.mjs`, `test/log.test.mjs`

**Interfaces:**
- Produces:
  - `paths(home = os.homedir()) → { root, env, stateDir, logsDir, disabledFlag, daemonJson, snapshot }` (root = `<home>/.claude/telegram`)
  - `parseEnv(text: string) → Record<string,string>` (строки `K=V`, `#`-комментарии, кавычки снимаются)
  - `loadConfig(home?) → { token, userId: number|null, port: number }` (env процесса перекрывает файл; port по умолчанию 47833)
  - `isDisabled(env = process.env, home?) → boolean`
  - `maskSecrets(s: string, secrets: string[]) → string` (каждый секрет длиной ≥ 6 → `***`; также маскирует `bot<digits>:<token>` в URL)
  - `createLogger({ dir, secrets, maxBytes = 1_000_000, keep = 3 }) → { info(msg, obj?), warn, error }` — JSON-строки в `<dir>/daemon.log`, ротация `daemon.log.1..keep`

- [ ] **Step 1: Failing tests**
  - `parseEnv` : `"A=1\n# c\nB=\"x y\"\nC="` → `{A:'1',B:'x y',C:''}`
  - `loadConfig` с временным home и `.env` `TELEGRAM_USER_ID=42` → `userId === 42`, `port === 47833`; пустой `TELEGRAM_USER_ID=` → `userId === null`
  - `isDisabled({CC_TELEGRAM_DISABLE:'1'})` → true; существует файл `disabled` → true
  - `maskSecrets('url https://api.telegram.org/bot123456:ABCdef_ghijk/getMe', ['123456:ABCdef_ghijk'])` не содержит `ABCdef`
  - логгер: записать `info('t', {token:'123456:ABCdef_ghijk'})` → в файле нет `ABCdef`; при `maxBytes=200` после 20 записей существуют `daemon.log.1`, нет `daemon.log.4`
- [ ] **Step 2:** `npm test` → FAIL (модули не найдены)
- [ ] **Step 3:** Реализовать. `package.json`: `{"name":"cc-telegram","private":true,"type":"module","engines":{"node":">=22"},"scripts":{"test":"node --test test/"}}`, без dependencies. `.gitignore`: `.env`, `*.exe`, `node_modules/`, `state/`, `logs/`.
- [ ] **Step 4:** `npm test` → PASS
- [ ] **Step 5:** Commit `feat: config, env loading, masked rotating logger`

---

### Task 2: Клиент Telegram Bot API

**Files:**
- Create: `src/telegram.mjs`
- Test: `test/telegram.test.mjs`

**Interfaces:**
- Consumes: `maskSecrets` (Task 1)
- Produces: `createTelegram({ token, fetch = globalThis.fetch, log }) → { getUpdates(offset, timeoutSec = 50), sendMessage({chatId, text, keyboard?, replyTo?, forceReply?}) → message_id, editMessage({chatId, messageId, text, keyboard}) , answerCallback(callbackId, text?), getMe() }`
  - Все запросы POST JSON на `https://api.telegram.org/bot<token>/<method>`, `parse_mode: 'HTML'`, `disable_web_page_preview: true`.
  - `keyboard` → `reply_markup: { inline_keyboard }`; `keyboard: null` в edit → `reply_markup: { inline_keyboard: [] }`.
  - `forceReply` → `reply_markup: { force_reply: true }`.
  - Текст > 4096 символов в `sendMessage` режется по границам строк на части; клавиатура — только у последней; возвращается id последней.
  - `getUpdates` шлёт `allowed_updates: ['message','callback_query']`.
  - Ошибка `ok:false` → throw `TelegramError(method, error_code, description)`; текст ошибки без токена. Ошибка edit «message is not modified» глотается.

- [ ] **Step 1: Failing tests** (fetch-заглушка записывает вызовы):
  - `sendMessage({chatId:1,text:'x',keyboard:[[{text:'1',callback_data:'a|abc|0|0'}]]})` → URL оканчивается `/sendMessage`, body.reply_markup.inline_keyboard[0][0].text === '1', возвращает `result.message_id`
  - текст 9000 символов из строк по 100 → 3 вызова, клавиатура только в третьем
  - заглушка вернула `{ok:false,error_code:400,description:'Bad'}` → reject `TelegramError`, `String(err)` не содержит токен
  - edit с description `Bad Request: message is not modified` → resolve
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** Реализовать
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: telegram bot api client`

---

### Task 3: Последовательности клавиш

**Files:**
- Create: `src/keys.mjs`
- Test: `test/keys.test.mjs`

**Interfaces:**
- Consumes: `docs/ui-keymap.md` (Task 0) — **источник истины**; где он расходится с описанным ниже, следовать keymap и поправить тесты.
- Produces (все → `Step[]`):
  - `askSequence(questions, answers) ` — `questions` как в `tool_input.questions`; `answers[i]` = `{ kind:'option', index }` | `{ kind:'multi', indexes:number[] }` | `{ kind:'other', text }`. Строит ввод для всего мастера (все вкладки; экран Review, если он есть по keymap).
  - `planSequence(optionIndex, text?)`
  - `permissionSequence(optionIndex)`
  - `instructionSequence(text)` → `[{text}, {sleep:400}, {key:'ENTER'}]`
  - `stopSequence()` → `[{key:'ESC'}]`
- Ожидаемое по эксперименту (подтвердить keymap'ом): одиночный выбор k (0-based) → `[{text:String(k+1)}]`; «Другое» при N вариантах → `N × DOWN`, `{text}`, `{sleep:400}`, `ENTER`; multi `[i…]` → для каждого `i` по возрастанию DOWN до i и `ENTER`, затем DOWN до строки `Submit` и `ENTER`; экран Review → `ENTER`. Между шагами без явного `sleep` исполнитель сам ставит 150 мс (Task 4).

- [ ] **Step 1: Failing tests** по таблице keymap, минимум: одиночный 2 из 3 → `[{text:'2'}]`; 4 варианта, «Другое» «Ананас» → 4×DOWN, text, sleep 400, ENTER; multi [0,2] из 4; два вопроса (option 1 + other); `instructionSequence('привет')`; ни одна последовательность не доходит курсором до строки N+2 (проверка: максимальная позиция курсора в одиночном вопросе ≤ N, считая с 0).
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** Реализовать
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: keystroke sequences for Claude Code dialogs`

---

### Task 4: inject.exe и обёртка

**Files:**
- Create: `native/inject.cs`, `native/build.mjs`, `src/inject.mjs`
- Test: `test/inject.test.mjs` (интеграционный, Windows)

**Interfaces:**
- Produces:
  - `inject.exe` : читает из stdin JSON `{ "pid": number, "steps": Step[], "gapMs": 150 }`; FreeConsole → AttachConsole(pid) → CreateFile `CONIN$` → для каждого шага WriteConsoleInputW (key down+up; текст — посимвольно, VK=0, UnicodeChar), между шагами `gapMs`, `sleep` — явная пауза. Выход 0 и stdout `ok N`; ошибки — код 2 и `err <stage> <win32code>`. P/Invoke-структуры — как в `spike/inject.ps1`.
  - `build.mjs`: ищет `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, компилирует `/target:exe /out:native/inject.exe /optimize native/inject.cs`; нет csc → понятная ошибка.
  - `injectSteps(pid, steps, { exe = 'native/inject.exe', timeoutMs = 15000 }) → Promise<{ok:true}|{ok:false, error}>` — `spawn` с `windowsHide:true`; вызовы для одного pid строго последовательны (очередь-промис на pid).

- [ ] **Step 1: Failing test** (`{ skip: process.platform !== 'win32' }`): запустить `powershell -NoProfile -Command "$x = Read-Host; Set-Content -Encoding utf8 <tmp>\out.txt $x"` с `detached: true` (свой консольный буфер), подождать 1500 мс, `injectSteps(child.pid, [{text:'привет — ok'},{sleep:400},{key:'ENTER'}])`, дождаться выхода → файл содержит `привет — ok`. Второй тест: `injectSteps(999999, …)` → `{ok:false}`.
- [ ] **Step 2:** `node native/build.mjs && npm test` → FAIL (нет inject.cs)
- [ ] **Step 3:** Реализовать
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: console input injector`

---

### Task 5: Процессы и git

**Files:**
- Create: `src/procs.mjs`
- Test: `test/procs.test.mjs`

**Interfaces:**
- Produces:
  - `findAncestor(pid, name = 'claude.exe', { listProcs }) → Promise<number|null>` — идёт вверх по `ParentProcessId` (≤ 10 уровней), возвращает первый с `Name` == name (без учёта регистра).
  - `listProcs() → Promise<Map<pid, {name, ppid}>>` — один вызов `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"`.
  - `isClaudeAlive(pid, { listProcs }) → Promise<boolean>` — pid существует **и** имя `claude.exe` (RF-5).
  - `gitBranch(cwd) → Promise<string>` — `git -C <cwd> branch --show-current`, пусто/ошибка → `'—'`; detached HEAD → короткий sha.
  - `projectName(cwd) → string` — basename.

- [ ] **Step 1: Failing tests** с заглушкой `listProcs`: цепочка 300(node)→200(bash.exe)→100(claude.exe) → `findAncestor(300)===100`; цикл/обрыв → null; `isClaudeAlive(100)` true, после замены имени pid 100 на `notepad.exe` → false (RF-5); `gitBranch` на временном git-репо с веткой `feat/x` → `'feat/x'`, на не-репо → `'—'`.
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** Реализовать
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: process ancestry and git helpers`

---

### Task 6: Store — сессии и диалоги

**Files:**
- Create: `src/sessions.mjs`
- Test: `test/sessions.test.mjs`

**Interfaces:**
- Produces: `class Store` (in-memory + `toJSON()`/`static fromJSON()`; сохранение файлом делает демон):
  - `Session = { id, short /*8*/, pid|null, cwd, project, branch, state:'working'|'idle'|'waiting', lastPromptAt:number|null, lastActivityAt }`
  - `Dialog = { id /*6 base36*/, sessionId, kind:'ask'|'plan'|'perm', toolUseId|null, payload /*tool_input*/, options /*для plan/perm: string[]*/, answers: [], cursor /*индекс текущего вопроса*/, multi: Set→Array, awaitingOther: boolean, status:'open'|'injected'|'closed', messageIds: number[], source: 'telegram'|'terminal'|null, createdAt }`
  - `upsertSession(partial & {id})`, `getSession(id)`, `sessionByShort(short)`, `removeSession(id)` (закрывает её диалоги), `liveSessions()`
  - `openDialog({sessionId, kind, toolUseId, payload, options}) → Dialog`, `getDialog(id)`, `openDialogOf(sessionId) → Dialog|null` (последний open/injected), `closeDialog(id, source)`, `closeOpenDialogsOf(sessionId, source)`
  - `findDialogForTool(sessionId, toolName, toolUseId)` — по toolUseId, иначе последний open того же kind
  - `bindMessage(messageId, {sessionId, dialogId?})`, `lookupMessage(messageId)`
  - `labelOf(sessionId) → string` — `'<project> · <branch>'` + `' #<short4>'`, если у проекта > 1 живой сессии
  - `pendingRoute` — `{ text, createdAt } | null` (текст, ждущий выбора сессии), `pendingOther` — `dialogId | null`
- Ограничение: хранить ≤ 500 последних message-привязок.

- [ ] **Step 1: Failing tests:** две сессии одного проекта → `labelOf` содержит `#`; одна → нет; `openDialog` даёт id длиной 6; `closeDialog` → `openDialogOf` null; `findDialogForTool` по toolUseId; `removeSession` закрывает диалоги; `fromJSON(toJSON())` сохраняет всё (multi как массив); 600 bindMessage → первые 100 забыты.
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** Реализовать
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: session and dialog store`

---

### Task 7: Форматирование сообщений

**Files:**
- Create: `src/format.mjs`
- Test: `test/format.test.mjs`

**Interfaces:**
- Produces (все тексты — HTML, пользовательский текст через `esc()`):
  - `esc(s)` — `& < >`
  - `header(label)` → `📁 <b>${esc(label)}</b>`
  - `completionText(label, status /*'done'|'waiting'|'error'*/, summary)` → `header\nСтатус: ✅ завершено|⏸ ждёт решения|❌ ошибка\n${esc(summary)}`
  - `askText(label, question, qIndex, qTotal)` → header, `❓ ` + header вопроса (если qTotal>1: `(k/n)`), текст, пронумерованные варианты с описаниями `1. <b>label</b> — description`
  - `askKeyboard(dlgId, qIndex, question, selected:number[] = [])` → одиночный: строка кнопок `1..N` (по ≤ 5 в ряд) + ряд `[✏️ Другое]`; multi: кнопки `☐ k`/`☑ k`, ряд `[✏️ Другое] [✅ Отправить]`
  - `planText(label, plan)` → header + `📝 План на подтверждение` + текст плана (обрезка не здесь — Task 2 режет)
  - `permText(label, toolName, toolInput)` → header + `🔐 Разрешение: <b>tool</b>` + `<pre>` команда/путь (для Bash — `command` целиком; Edit/Write — `file_path`; иное — JSON ≤ 1500 символов)
  - `optionsKeyboard(dlgId, options:string[])` → по кнопке на пункт `k. текст` (по одной в ряд), callback `p|dlg|k`
  - `resolvedSuffix(kind: 'telegram'|'terminal'|'stale', chosen?)` → `\n\n✔ выбрано: …` | `\n\n✔ отвечено в терминале` | `\n\n⌛ устарело`
  - `statusText(sessions, now)` → по строке на сессию: `label — работает 3 мин | ждёт ответа | простаивает 12 мин`; пусто → `Активных сессий нет`
  - `sessionPickKeyboard(sessions, prefix /*'x'|'r'*/, msgKey?)`
- Все callback_data ≤ 64 байт (тест).

- [ ] **Step 1: Failing tests:** `completionText('p · main','done','a<b')` === `'📁 <b>p · main</b>\nСтатус: ✅ завершено\na&lt;b'`; 3 варианта → 3 кнопки + «Другое»; 7 вариантов → 2 ряда (5+2); multi selected [1] → вторая кнопка `☑ 2`; permText Bash содержит команду целиком; statusText пустой; все callback_data в клавиатурах ≤ 64 байт для `dlgId` длины 6.
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** Реализовать
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: message formatting`

---

### Task 8: Обработка хук-событий

**Files:**
- Create: `src/events.mjs`
- Test: `test/events.test.mjs` (на фикстурах Task 0)

**Interfaces:**
- Consumes: Store (6), format (7), keys (3 — только для сверки ответа)
- Produces: `handleHookEvent(store, ev, now) → Effect[]`, где `ev = { event, payload, ppid, claudePid }` (claudePid уже найден демоном). Поведение:
  - `SessionStart` → upsert (pid, cwd, project, branch из ev.branch), state idle. Эффектов нет.
  - `UserPromptSubmit` → state working, lastPromptAt=now; открытые диалоги сессии → closed('stale'), для каждого `edit` с `resolvedSuffix('stale')`, keyboard null.
  - `PreToolUse` + `AskUserQuestion` → openDialog kind ask; state waiting; `send` askText/askKeyboard первого вопроса, `bind {sessionId, dialogId}`.
  - `PreToolUse` + `ExitPlanMode` → dialog plan, options из keymap (константа `PLAN_OPTIONS` в `keys.mjs`), `send` planText + optionsKeyboard.
  - `PermissionRequest` → dialog perm, options `PERMISSION_OPTIONS` из `keys.mjs`, `send`.
  - `PostToolUse` для tool диалога (findDialogForTool): если dialog.source ≠ 'telegram' → closed('terminal'), `edit` всех messageIds с `resolvedSuffix('terminal')`; если 'telegram' → сравнить `tool_response` (формат из фикстуры) с dialog.answers; расхождение → `send` `⚠ в сессию ушло «X», а не «Y» — проверьте терминал`. В обоих случаях state working.
  - `PostToolUse` любого другого инструмента → закрыть открытый perm-диалог сессии как 'terminal' (если он не 'telegram').
  - `Stop` → state idle; если `lastPromptAt` и `now - lastPromptAt ≥ 60000` → `completion {lastMessage: payload.last_assistant_message, failed:false}`; закрыть висящие диалоги 'stale'.
  - `StopFailure` → `completion {failed:true}` без порога.
  - `SessionEnd` → removeSession, edit висящих диалогов 'stale'.
  - Неизвестная сессия (нет SessionStart, демон перезапускался) → создать её из payload.cwd на лету.

- [ ] **Step 1: Failing tests** (фикстуры): Pre Ask single → 1 send с 4 кнопками (3+Другое) и bind; затем Post без ответа из Telegram → edit с «отвечено в терминале» (RF-2 подготовка); Stop через 30 с после UserPromptSubmit → нет completion; через 61 с → completion; StopFailure → completion failed; UserPromptSubmit при открытом диалоге → edit «устарело»; Post с ответом, не совпавшим с dialog.answers при source telegram → send ⚠; событие от неизвестной сессии → сессия создана.
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** Реализовать
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: hook event handling`

---

### Task 9: Маршрутизация Telegram

**Files:**
- Create: `src/router.mjs`
- Test: `test/router.test.mjs`

**Interfaces:**
- Consumes: Store, format, keys
- Produces: `handleUpdate(store, update, { userId, now }) → Effect[]`
  - **Allowlist первым:** `from.id !== userId` или чат не private → `[]` (RF-1). Вызывающий логирует факт.
  - `callback_query`:
    - диалог не найден/closed → `[answerCallback 'Вопрос уже закрыт']` (RF-2).
    - `a|dlg|q|opt` → записать ответ `{kind:'option', index}`; если есть следующий вопрос → `edit` текущего сообщения (✔ выбрано) + `send` следующего; иначе `inject askSequence(...)` с `verify`, dialog.status injected, source telegram, `edit` ✔ выбрано.
    - `t|…` → переключить в multi, `edit` клавиатуры; `s|dlg|q` → ответ `{kind:'multi'}` → как выше.
    - `o|dlg|q` → `pendingOther = dlg`, `send` «Напишите свой вариант» с `forceReply`, bind.
    - `p|dlg|k` → `inject planSequence/permissionSequence(k)` + verify, edit.
    - `x|sid8` → `inject stopSequence` + `send` «⏹ Остановлено: label».
    - `r|sid8|key` → взять `pendingRoute.text` → инструкция в эту сессию.
    - Всегда добавлять `answerCallback`.
  - `message.text`:
    - `/status` → `send statusText`.
    - `/stop` → 0 сессий → «Нет активных сессий»; 1 → сразу stop; >1 → `send` sessionPickKeyboard('x').
    - `/help` → краткая справка.
    - reply на сообщение бота → сессия из `lookupMessage`; иначе если `pendingOther` → его сессия; иначе 1 живая сессия → она; иначе `pendingRoute = text` + `send` «В какую сессию?» sessionPickKeyboard('r').
    - Доставка в выбранную сессию: если `pendingOther` этой сессии (или у сессии открыт ask-диалог) → ответ `{kind:'other', text}` текущему вопросу (далее как `a|`); открыт plan-диалог и keymap говорит, что у плана есть поле текста → `planSequence(feedbackIndex, text)`; открыт иной диалог → `send` «В сессии открыт вопрос — ответьте кнопками» и ничего не вводить (RF-3); иначе `inject instructionSequence(text)` + `send` «➡️ отправлено в label» (reply на исходное).
    - Сессия не жива (нет в liveSessions) → «Сессия завершена».

- [ ] **Step 1: Failing tests:** чужой from.id на сообщение, кнопку, /status → `[]` (RF-1); кнопка по закрытому диалогу → только answerCallback (RF-2); `a|…|1` по одиночному вопросу → inject `[{text:'2'}]` с verify; два вопроса → первый ответ даёт send следующего, второй — inject одной последовательностью; «Другое» → forceReply, затем текст → inject с other; текст при открытом perm-диалоге → нет inject, есть send «ответьте кнопками» (RF-3); две сессии + текст без reply → pendingRoute и клавиатура выбора; затем `r|` → inject instruction в выбранную; reply на сообщение сессии B → inject в B; `/stop` с одной сессией → inject ESC.
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** Реализовать
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: telegram update routing`

---

### Task 10: Сводка через haiku

**Files:**
- Create: `src/summary.mjs`
- Test: `test/summary.test.mjs`

**Interfaces:**
- Produces: `summarize(lastMessage, { failed, run = runClaude }) → Promise<{ status:'done'|'waiting'|'error', summary }>`
  - `failed` → status error.
  - Короткое (≤ 5 строк и ≤ 500 символов) и не failed → `run` не вызывается; status: `waiting`, если последняя непустая строка оканчивается `?`, иначе `done`.
  - Иначе `run(prompt)`; prompt просит JSON `{"status":"done|waiting|error","summary":"2–5 строк по-русски: что сделано, что осталось, что нужно от пользователя"}`; ответ парсится (первый `{…}` в тексте). Ошибка/таймаут/мусор → `{status: failed?'error':'done', summary: первые 5 строк, ≤ 500 символов + '…'}`.
  - `runClaude(prompt, { timeoutMs = 60000 })` — `spawn('claude', ['-p', '--model', 'haiku'], { env: {...process.env, CC_TELEGRAM_DISABLE:'1'}, windowsHide:true, shell:false })`, prompt в stdin, stdout → строка. На Windows разрешить путь к `claude.exe` через `where claude` один раз.

- [ ] **Step 1: Failing tests:** короткий текст «Готово. Тесты зелёные.» → run не вызван, done; «…какой вариант?» → waiting; длинный текст + run возвращает `bla {"status":"waiting","summary":"x"} bla` → waiting/x; run бросает → done + обрезка ≤ 501 символа; failed → error.
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** Реализовать
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: completion summary via haiku`

---

### Task 11: Демон, супервизор, клиент хука

**Files:**
- Create: `src/daemon.mjs`, `src/supervisor.mjs`, `src/hook.mjs`, `scripts/launch.vbs`
- Test: `test/daemon.test.mjs`, `test/hook.test.mjs`

**Interfaces:**
- Consumes: всё из задач 1–10
- Produces:
  - `startDaemon({ config, paths, telegram, inject, procs, summarize, log, now = Date.now }) → { port, close() }`:
    - HTTP `127.0.0.1:<port>`; при старте генерирует `secret` (32 hex), пишет `daemon.json {port, secret, pid}` (ACL как у .env). `POST /event` с заголовком `x-cc-secret` — иначе 403. Отвечает 204 сразу, обработка — после ответа. `GET /health` (с секретом) → `{ok, sessions}`. Порт занят → лог + exit 1 (второй экземпляр).
    - На `/event`: если нет `claudePid` для сессии → `procs.findAncestor(ppid)`; для SessionStart также `gitBranch`. Затем `handleHookEvent` → исполнение эффектов.
    - Поллинг: цикл `getUpdates(offset)`, offset в `state/offset`; ошибки → backoff 1,2,4…30 с (RF-4); апдейт с чужим id → лог `ignored update from <id>` без текста.
    - Исполнитель эффектов: `send` → `sendMessage` (chatId = userId) + `bindMessage` + `dialog.messageIds.push`; `edit`; `answerCallback`; `inject` → `isClaudeAlive(pid)` (нет → `send` «Сессия завершена», RF-5) → `injectSteps`; ошибка → `send` «⚠ не удалось ввести в терминал: …»; `verify` → таймер: диалог не closed за timeoutMs → `send` «⚠ не удалось подтвердить ответ, проверьте терминал»; `completion` → `summarize` → `send completionText`.
    - Каждые 30 с: сессии с мёртвым pid → removeSession. Снимок Store в `state/snapshot.json` после каждого изменения (debounce 500 мс), загрузка при старте.
    - При старте логирует версию Claude Code (`claude --version`, через тот же резолв пути, что в summary).
    - Ошибки отдельного эффекта логируются и не роняют процесс; `unhandledRejection`/`uncaughtException` → лог.
  - `supervisor.mjs`: запускает `daemon.mjs` дочерним процессом (`windowsHide`), при выходе с кодом ≠ 0 перезапуск с backoff 2→60 с; код 1 из-за занятого порта 3 раза подряд → выход (уже работает другой).
  - `hook.mjs <Event>`: если `isDisabled()` → exit 0. Читает stdin (≤ 1 МБ, таймаут 1 с), читает `daemon.json`; POST `{event, payload, ppid: process.ppid}` с `AbortSignal.timeout(1500)`; любые ошибки → дописать строку в `logs/hook-errors.log` (без payload) и exit 0. Ничего не пишет в stdout.
  - `launch.vbs`: `CreateObject("WScript.Shell").Run "node ""<repo>\src\supervisor.mjs""", 0, True` (путь подставляет install).

- [ ] **Step 1: Failing tests:**
  - daemon с заглушками (telegram, inject, procs, summarize): POST без секрета → 403; с секретом PreToolUse-Ask-single → `sendMessage` вызван 1 раз; затем симулированный callback-апдейт `a|…` → `injectSteps` вызван с pid из `findAncestor`; апдейт от чужого id → ни sendMessage, ни inject (RF-1, сквозной); `isClaudeAlive` false → inject не вызван, отправлено «Сессия завершена» (RF-5); `getUpdates` дважды бросает → третий вызов происходит (backoff ускорить через опцию `backoffBaseMs`).
  - hook: нет `daemon.json` → exit 0 < 2000 мс, stdout пуст (RF-4); daemon.json указывает на закрытый порт → exit 0 < 2000 мс; `CC_TELEGRAM_DISABLE=1` → запрос не отправлен (тестовый сервер не получил).
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** Реализовать
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: daemon, supervisor and hook client`

---

### Task 12: Установка, settings.json, CLI, шпаргалка

**Files:**
- Create: `src/settings.mjs`, `src/cli.mjs`, `README.md`
- Test: `test/settings.test.mjs`

**Interfaces:**
- Produces:
  - `HOOK_EVENTS = [['SessionStart',null],['UserPromptSubmit',null],['PreToolUse','AskUserQuestion|ExitPlanMode'],['PermissionRequest',null],['PostToolUse',null],['Stop',null],['StopFailure',null],['SessionEnd',null]]` (StopFailure — только если подтверждён в Task 0)
  - `hookCommand(repo, event)` → `node "<repo>/src/hook.mjs" <event>` (прямые слэши)
  - `mergeHooks(settings, repo) → settings` — добавляет для каждого события группу `{ matcher?, hooks:[{type:'command', command, async:true, timeout:5}] }`; идемпотентно (повторный вызов не дублирует); все прочие ключи и чужие хуки нетронуты.
  - `removeHooks(settings) → settings` — удаляет только записи, чья command содержит `cc-telegram/src/hook.mjs`; пустые группы/события удаляются.
  - CLI `node src/cli.mjs <cmd>`:
    - `install`: проверка Node ≥ 22; `native/build.mjs`; создать `~/.claude/telegram/{state,logs}`; `.env` — только если нет, с пустыми `TELEGRAM_BOT_TOKEN=` `TELEGRAM_USER_ID=` и комментарием; icacls на `.env`; бэкап `settings.json` → `settings.json.bak-<ts>`, `mergeHooks`, запись; `launch.vbs` с путём; задача Планировщика `cc-telegram` (`schtasks /Create /TN cc-telegram /SC ONLOGON /RL LIMITED /TR "wscript.exe \"<repo>\scripts\launch.vbs\"" /F`); запуск задачи. Если `.env` пустой → напечатать, куда вписать значения, и не стартовать.
    - `uninstall`: остановить демон (pid из daemon.json, проверить имя `node.exe`), `schtasks /Delete /TN cc-telegram /F`, `removeHooks` с бэкапом. `.env` и логи не удаляет (печатает путь).
    - `status` (демон жив? `/health`, сессии), `logs` (хвост 50 строк), `test` (sendMessage «🔔 cc-telegram: проверка связи»), `disable`/`enable` (файл-флаг), `restart`.
  - README: шпаргалка — что и где установлено, команды бота, обновление (`git pull && node src/cli.mjs restart`), временное выключение, удаление.

- [ ] **Step 1: Failing tests:** `mergeHooks` на копии реальной структуры пользователя (`{enabledPlugins:{…}, autoMode:{…}, hooks:{Stop:[{hooks:[{type:'command',command:'other'}]}]}}`) → чужой Stop-хук на месте, наш добавлен, `autoMode` идентичен; двойной merge → без дублей; `removeHooks(mergeHooks(x))` deepEqual `x`; PreToolUse-группа имеет matcher `AskUserQuestion|ExitPlanMode`; все наши хуки `async:true`.
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** Реализовать
- [ ] **Step 4:** PASS, затем `npm test` целиком → PASS
- [ ] **Step 5:** Commit `feat: installer, settings merge, CLI and README`

---

### Task 13: Установка и приёмка (контроллер + пользователь)

- [ ] **Step 1:** `node src/cli.mjs install`; пользователь вписывает токен и ID в `.env` сам; `node src/cli.mjs restart`; `node src/cli.mjs test` → сообщение пришло.
- [ ] **Step 2:** Приёмка по спеке (все 6 + ответ в терминале + `/status` `/stop`), каждый пункт — реальный вывод/лог или подтверждение пользователя. Перезагрузку пользователь делает сам, после — `/status` из Telegram.
- [ ] **Step 3:** Найденные баги — через superpowers:systematic-debugging, с тестом на каждый.
- [ ] **Step 4:** Commit, шпаргалка пользователю.
