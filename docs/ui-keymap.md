# Раскладка окон Claude Code 2.1.310 (Windows, терминал VS Code)

Проверено вживую 2026-10-26 инъекцией `WriteConsoleInputW` (`spike/inject.ps1`) с подтверждением пользователя. Источник истины для `src/keys.mjs`. Фикстуры хуков — `test/fixtures/hooks/`.

## Общие правила
- Каждый «шаг» — отдельный вызов записи; между шагами пауза (150 мс; перед Enter после текста — 400 мс). Текст и Enter в одной пачке → Claude Code принимает за вставку, Enter не срабатывает.
- Кириллица, «ёлочки», длинное тире передаются корректно (VK=0 + UnicodeChar).
- Курсор при открытии любого окна стоит на пункте 1.

## AskUserQuestion — одиночный выбор (`multiSelect: false`)
Пункты: `1..N` варианты, `N+1` — поле своего ответа («Other»), `N+2` — «Chat about this» (**никогда**).
- Вариант k (1-based): нажать цифру `k` → вариант выбран и ответ отправлен сразу (или переход на следующую вкладку, если вопросов несколько).
- Свой ответ: `DOWN × N` (курсор на N+1) → текст → пауза → `ENTER` → отправлено.
- PostToolUse: `tool_response.answers = { "<question>": "<label или свой текст>" }`.

## AskUserQuestion — множественный выбор (`multiSelect: true`)
Пункты: `1..N`, `N+1` — свой ответ, затем строка `Submit`.
- Цифра `k` переключает галочку на варианте k, **курсор не двигается** (остаётся на пункте 1).
- После галочек: `DOWN × (N+1)` → курсор на `Submit` → `ENTER` → экран «Review your answers» (если вопрос последний).
- Свой ответ в multi: `DOWN × N` → текст (галочка на этом пункте ставится вводом текста — **не проверено**; в эксперименте после текста Enter снял галочку). Безопасный путь: текст → пауза → `DOWN` (на Submit) → `ENTER`. Если подтверждается не так — keymap обновить.
- PostToolUse: метки через запятую с пробелом: `"Python, Rust"`.

## Несколько вопросов в одном вызове (вкладки)
- Вкладки сверху `← ☐ <header> … ✔ Submit →`. Ответ на вкладку (цифра для одиночного) автоматически переводит на следующую.
- После последнего вопроса — экран **Review your answers**: `❯ 1. Submit answers / 2. Cancel` → `ENTER`.
- Для одного вопроса с одиночным выбором экрана Review нет (цифра сразу отправляет). Для одного multi-вопроса Review есть (после Submit).

## ExitPlanMode — подтверждение плана
```
❯ 1. Yes, and use auto mode
  2. Yes, manually approve edits
  3. Tell Claude what to change   (shift+tab to approve with this feedback)
```
- `1` / `2` — одобрить (цифра сразу применяет). PostToolUse ExitPlanMode приходит.
- `3` → курсор в поле текста → текст → пауза → `ENTER` → план отклонён с правками. **PostToolUse не приходит, никакого события об отказе нет**; следом Claude правит план (PreToolUse/PostToolUse Edit) и снова вызывает ExitPlanMode.
- Набор пунктов может зависеть от режима (видели в `permission_mode: "plan"` после default). Тексты для Telegram: «✅ Да, auto mode», «✅ Да, правки вручную», «✏️ Изменить план (текст)».

## Запрос разрешения (PermissionRequest), пример Write
```
❯ 1. Yes
  2. Yes, and switch to accept edits (…)      ← из permission_suggestions[0]
  3. No
Esc to cancel · Tab to amend
```
- Пункты: `1. Yes`, затем по одному на каждый элемент `permission_suggestions`, последний — `No`. Цифра применяет сразу.
- После `Yes`: PostToolUse этого инструмента. После `No`: события нет (диалог закрывается по следующему событию сессии).

## Особенности хуков
- **PermissionRequest срабатывает и для AskUserQuestion и ExitPlanMode** (в режиме default/plan) — дубликат PreToolUse; для этих инструментов его игнорировать.
- Notification `permission_prompt` приходит ~через 6–25 с ожидания — не использовать.
- Payload'ы содержат `session_id`, `cwd`, `prompt_id`, `permission_mode`, `transcript_path`; у PreToolUse/PostToolUse есть `tool_use_id`, у PermissionRequest — нет.
- Stop: `last_assistant_message` есть.
- Хук запускается через промежуточную оболочку: `ppid` хука — процесс оболочки (bash/`sh`), его родитель — `claude.exe`. Цепочку проверять обходом вверх.
- События StopFailure / PostToolUseFailure / PermissionDenied приняты в settings.json без ошибок, но в эксперименте не возникали (отказы и ошибки не порождают их). Закрытие диалогов после отказа — по любому следующему событию той же сессии (PreToolUse/PostToolUse другого инструмента, UserPromptSubmit, Stop, повторный PreToolUse того же инструмента).
