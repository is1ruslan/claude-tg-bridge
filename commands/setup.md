---
description: Install or update the Telegram bridge (daemon, autostart, VS Code extension). Windows only.
allowed-tools: Bash(node:*)
---

Install or update claude-tg-bridge on this machine.

1. Run exactly this command and show its output to the user:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs" install --plugin
   ```

   If it fails, explain the error in plain words (the most common causes: not Windows, Node.js older than 22, `schtasks` access denied — then the terminal has to be run as administrator once).

2. If the output says the `.env` file has to be filled in, guide the user through it. **Never ask the user to paste the token or the user ID into the chat, and never read or print the `.env` file** — the user edits it themselves:
   - Create a bot: open @BotFather in Telegram → `/newbot` → copy the token.
   - Get their numeric user ID, e.g. from @userinfobot.
   - Open the file the installer printed (`%USERPROFILE%\.claude\telegram\.env`) in an editor and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID`. Optional: `CC_TG_LANG=ru` for a Russian bot, `CC_TG_PROJECTS_DIR` for the folder where «➕ New session» may create projects.
   - Send any message to the new bot once (Telegram bots can only write to users who started them).
   - Then run `/tg-bridge:tg restart` and `/tg-bridge:tg test`.

3. If VS Code is open, remind the user to run **Developer: Reload Window** once so the bridge extension starts.

Re-run this command after every plugin update — it replaces the installed copy and restarts the daemon.
