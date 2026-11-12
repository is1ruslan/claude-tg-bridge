---
description: Manage the Telegram bridge — status, restart, logs, test, disable, enable, uninstall
argument-hint: status | restart | start | stop | logs [n] | test | disable | enable | uninstall
allowed-tools: Bash(node:*)
---

Run the claude-tg-bridge CLI with the user's arguments and show the output:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs" $ARGUMENTS
```

If no arguments were given, run it with `status`.

Never read or print `%USERPROFILE%\.claude\telegram\.env` — it holds the bot token.

After `uninstall`, tell the user that the plugin itself is removed with `/plugin uninstall claude-tg-bridge`, and that `%USERPROFILE%\.claude\telegram` (settings, logs) is kept until they delete it.
