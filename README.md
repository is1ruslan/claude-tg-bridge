# cc-telegram

Мост между Claude Code (терминал VS Code на Windows) и Telegram-ботом: уведомления о событиях сессий (завершение, вопросы, запросы разрешений, планы) приходят в Telegram, а ответы из Telegram вводятся обратно в консоль.

## Что установлено и где

| Что | Где |
| --- | --- |
| Код | папка репозитория (`C:\Projects\cc-telegram`) |
| Настройки и данные | `~/.claude/telegram/` |
| Токен и ID | `~/.claude/telegram/.env` (доступ только вашему пользователю) |
| Состояние демона | `~/.claude/telegram/state/` |
| Логи (токены замаскированы) | `~/.claude/telegram/logs/daemon.log` |
| Лаунчер демона | `~/.claude/telegram/launch.vbs` (генерируется при установке) |
| Флаг выключения | `~/.claude/telegram/disabled` (есть файл — мост выключен) |
| Хуки Claude Code | `~/.claude/settings.json` (перед каждой записью делается копия `settings.json.bak-<дата>`) |
| Автозапуск | задача Планировщика `cc-telegram` (при входе в систему) |

## Первая настройка

1. В Telegram откройте @BotFather, `/newbot`, получите токен.
2. Узнайте свой числовой ID у @userinfobot. Напишите вашему новому боту любое сообщение (иначе он не сможет вам писать).
3. `node src/cli.mjs install` — создаст `~/.claude/telegram/.env`, добавит хуки, зарегистрирует задачу.
4. Впишите `TELEGRAM_BOT_TOKEN` и `TELEGRAM_USER_ID` в `~/.claude/telegram/.env`.
5. `node src/cli.mjs restart` — запуск демона.
6. `node src/cli.mjs test` — в Telegram придёт «🔔 cc-telegram: проверка связи».

## Команды CLI

```
node src/cli.mjs install | uninstall | status | start | stop | restart | logs [n] | test | disable | enable
```

## Команды бота

- `/status` — список активных сессий.
- `/stop` — прервать текущую работу выбранной сессии.
- `/help` — справка.
- Обычный текст — ввод в сессию; reply на сообщение — ввод в ту сессию, на чьё сообщение отвечаете.
- Кнопки под сообщениями — ответы на вопросы, разрешения, планы.
- «Другое» — свой текстовый ответ на вопрос.
- Любые другие `/команды` уходят в сессию как есть.

## Как обновить

```
git pull
node src/cli.mjs install   # идемпотентно: пересоберёт inject.exe, обновит хуки и лаунчер
node src/cli.mjs restart
```

## Как временно выключить

- Всё целиком: `node src/cli.mjs disable`, обратно — `node src/cli.mjs enable`.
- Одна сессия: запустите её с переменной `CC_TELEGRAM_DISABLE=1`.

## Как удалить

```
node src/cli.mjs uninstall
```

Останавливает демон, удаляет задачу Планировщика, хуки из `settings.json` и сгенерированный `launch.vbs`. `.env`, логи и состояние остаются; чтобы убрать совсем, удалите папку `~/.claude/telegram` вручную, затем папку репозитория.

## Ограничения

- Только Windows и терминал VS Code; ответы вводятся в консоль через `native/inject.exe`.
- Не печатайте в терминале одновременно с ответом из Telegram — символы могут перемешаться.
- Уведомления отправляются, если сессия не отвечала дольше порога в одну минуту.
- Нужен Node.js 22+ и .NET Framework 4 (для сборки `inject.exe`).
