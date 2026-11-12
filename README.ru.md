# claude-tg-bridge (по-русски)

Плагин Claude Code, который связывает ваши сессии с личным Telegram-ботом: итоги задач, вопросы с кнопками, запросы разрешений, инструкции и новые сессии — из телефона. Терминал работает как обычно; засчитывается тот ответ, который пришёл первым. Подробное описание — в [README.md](README.md) (на английском).

**Платформа:** только Windows (терминал VS Code или PowerShell), Node.js 22+.

## Установка

1. В Telegram: @BotFather → `/newbot` → токен; свой числовой ID — у @userinfobot; напишите новому боту любое сообщение.
2. В Claude Code:

   ```
   /plugin marketplace add is1ruslan/claude-tg-bridge
   /plugin install claude-tg-bridge@claude-tg-bridge
   /claude-tg-bridge:setup
   ```

3. Впишите сами (не в чат!) в `%USERPROFILE%\.claude\telegram\.env`:

   ```ini
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_USER_ID=...
   CC_TG_LANG=ru                 # язык бота: ru или en (по умолчанию en)
   CC_TG_PROJECTS_DIR=C:\Projects # где «Другая папка» может создать новую папку (по умолчанию %USERPROFILE%\Projects)
   ```

4. `/claude-tg-bridge:tg restart`, затем `/claude-tg-bridge:tg test` — придёт тестовое сообщение. Перезапустите открытые сессии Claude Code, в VS Code один раз выполните **Developer: Reload Window**.

## Команды бота

- `/status` — активные сессии; `/stop` — прервать сессию (Esc); `/help` — справка.
- Сообщение без reply — выбор сессии или «➕ Новая сессия» (недавняя папка или «📂 Другая папка»; вкладка терминала с `claude` откроется в уже запущенном VS Code).
- Reply на сообщение проекта — инструкция сразу в эту сессию.
- Кнопки под сообщениями — ответы на вопросы, планы, разрешения; «✏️ Другое» — свой текст.

## Управление

`/claude-tg-bridge:tg status | restart | start | stop | logs [n] | test | disable | enable | uninstall`

- Обновление: `/plugin update claude-tg-bridge`, затем `/claude-tg-bridge:setup`.
- Временно выключить: `/claude-tg-bridge:tg disable` (обратно — `enable`); одну сессию — переменная `CC_TELEGRAM_DISABLE=1`.
- Удаление: `/claude-tg-bridge:tg uninstall`, затем `/plugin uninstall claude-tg-bridge`; папку `%USERPROFILE%\.claude\telegram` удалить вручную.
