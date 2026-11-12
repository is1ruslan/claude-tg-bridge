# claude-tg-bridge

A Claude Code plugin that connects your Claude Code sessions to a private Telegram bot. You can walk away from the computer and keep working from your phone: Claude reports finished tasks, asks its questions with buttons, requests permissions, and takes new instructions — all in Telegram. The terminal keeps working as usual; whichever side answers first wins.

> **Platform:** Windows 10/11, Claude Code in the VS Code integrated terminal or PowerShell. macOS/Linux are not supported yet — see [Porting](#porting-to-macos--linux).

## What it does

**Notifications**

- When Claude finishes a task you get a short message:

  ```
  📁 my-app · feat/login

  Status: ✅ done

  Added the login form and the /auth endpoint; tests pass.

  Left: the password-reset e-mail template.
  ```

- Status is `✅ done`, `❌ error` or `⏸ waiting for you`. Long reports are summarized by Claude Haiku (`claude -p --model haiku`, uses your own Claude Code login). When a decision is needed, the summary keeps the context, the options with their consequences and Claude's recommendation.
- Messages that need nothing from you have no buttons.

**Answering from Telegram**

- **Questions** (`AskUserQuestion`, brainstorming, multi-choice) arrive with buttons `1`, `2`, `3`… plus `✏️ Other` for a free-text answer. Multi-select questions get checkboxes and `✅ Submit`. Multi-question dialogs are asked one by one.
- **Plan approval** (`ExitPlanMode`): `✅ Yes, auto mode`, `✅ Yes, manual edits`, `✏️ Change the plan` (then type what to change).
- **Permission prompts**: the command / diff / file preview with `✅ Yes`, the "don't ask again" variants Claude Code offers, and `⛔ No`.
- The answer is typed into the right Claude Code console as keystrokes, so the session continues exactly as if you had answered at the keyboard. If you answer in the terminal first, the Telegram message is marked `✔ answered in the terminal` and its buttons disappear — nothing is sent twice.

**Controlling sessions from Telegram**

- **Reply** to any project message → your text goes to that session as a new instruction.
- **Plain message** (no reply) → the bot asks *Where to send it?* with a button per live session and `➕ New session`.
- **`➕ New session`** → pick one of your recent project folders (from Claude Code history) or `📂 Other folder` (send a full path; a missing folder directly inside your projects folder is created). A new terminal tab opens in your already-running VS Code, `claude` starts there with your text as the first prompt, and the tab stays open afterwards so you can continue at the computer.
- `/status` — live sessions and what they are doing; `/stop` — interrupt a session (Esc); `/help`.
- Several projects at once: every message is tagged `📁 project · git-branch`, and replies/buttons are routed to their own session.

**Security**

- The bot talks only to the one Telegram user ID in your `.env`; updates from anyone else are ignored (and logged).
- The token lives in `%USERPROFILE%\.claude\telegram\.env`, readable only by your Windows user; tokens are masked in logs.
- The only external host contacted is `api.telegram.org`. The local daemon listens on `127.0.0.1` only, and every request to it needs a random per-run secret.
- Hooks are async and fail silently (errors go to a log), so the bridge can never slow down or break Claude Code.
- No npm dependencies.

## Requirements

- Windows 10/11
- [Claude Code](https://claude.com/claude-code) 2.1+ (running in VS Code's integrated terminal or PowerShell)
- Node.js 22 or newer
- .NET Framework 4 (preinstalled on Windows; used to compile the small `inject.exe` helper from source)
- VS Code with the `code` command on `PATH` — only for `➕ New session`
- A Telegram account

## Installation

### 1. Create the bot

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot` and follow the steps. Copy the **token**.
2. Get your numeric **user ID**, e.g. from [@userinfobot](https://t.me/userinfobot).
3. Open your new bot and send it any message (a bot can only write to users who started it).

### 2. Install the plugin

In Claude Code:

```
/plugin marketplace add is1ruslan/claude-tg-bridge
/plugin install claude-tg-bridge@claude-tg-bridge
```

Then run the setup command:

```
/claude-tg-bridge:setup
```

It copies the runtime to `%USERPROFILE%\.claude\telegram\app`, compiles `inject.exe`, creates the `.env` template, registers the Task Scheduler task `cc-telegram` (starts the daemon at logon) and installs the small VS Code extension used for new sessions.

### 3. Configure

Open `%USERPROFILE%\.claude\telegram\.env` in an editor and fill it in yourself (don't paste the token into a chat):

```ini
TELEGRAM_BOT_TOKEN=123456789:AA...      # from @BotFather
TELEGRAM_USER_ID=123456789              # your numeric ID
CC_TG_LANG=en                           # bot language: en | ru
CC_TG_PROJECTS_DIR=                     # optional, default %USERPROFILE%\Projects
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | Bot token (required) |
| `TELEGRAM_USER_ID` | — | The only Telegram user the bot serves (required) |
| `CC_TG_LANG` | `en` | Bot language: `en` or `ru` |
| `CC_TG_PROJECTS_DIR` | `%USERPROFILE%\Projects` | `📂 Other folder` may create a missing folder only directly inside it |
| `CC_TG_PORT` | `47833` | Local daemon port (127.0.0.1) |

Then:

```
/claude-tg-bridge:tg restart
/claude-tg-bridge:tg test
```

You should get `🔔 claude-tg-bridge: connection test` in Telegram. Restart open Claude Code sessions so they pick up the plugin's hooks, and in VS Code run **Developer: Reload Window** once so the extension starts.

### Manual installation (without the plugin system)

```
git clone https://github.com/is1ruslan/claude-tg-bridge
cd claude-tg-bridge
node src/cli.mjs install
```

In this mode the hooks are written into `%USERPROFILE%\.claude\settings.json` (a backup `settings.json.bak-<date>` is made first). Use `node src/cli.mjs <command>` wherever this README says `/claude-tg-bridge:tg <command>`.

## Managing the bridge

`/claude-tg-bridge:tg <command>` (or `node src/cli.mjs <command>` from a clone):

| Command | What it does |
| --- | --- |
| `status` | Daemon state, number of sessions, task, disable flag, whether `.env` is filled |
| `restart` / `start` / `stop` | Control the daemon |
| `logs [n]` | Last `n` lines of the daemon log (default 50) |
| `test` | Send a test message |
| `disable` / `enable` | Switch the whole bridge off/on (a flag file; hooks become no-ops) |
| `uninstall` | Remove the task, hooks, VS Code extension and the app copy (keeps `.env`, logs, state) |

To keep a single session out of Telegram, start it with the environment variable `CC_TELEGRAM_DISABLE=1`.

## Updating

```
/plugin update claude-tg-bridge
/claude-tg-bridge:setup
```

Setup is idempotent: it stops the daemon, replaces the app copy, rebuilds `inject.exe` and starts the daemon again.

## Uninstalling

```
/claude-tg-bridge:tg uninstall
/plugin uninstall claude-tg-bridge
```

Then delete `%USERPROFILE%\.claude\telegram` if you no longer need the settings and logs.

## Where things live

| What | Where |
| --- | --- |
| Settings and token | `%USERPROFILE%\.claude\telegram\.env` (current user only) |
| Installed runtime | `%USERPROFILE%\.claude\telegram\app\` |
| Daemon state | `%USERPROFILE%\.claude\telegram\state\` |
| Logs (tokens masked) | `%USERPROFILE%\.claude\telegram\logs\` |
| Disable flag | `%USERPROFILE%\.claude\telegram\disabled` |
| Autostart | Task Scheduler task `cc-telegram` (at logon) → `launch.vbs` → supervisor → daemon |
| Hooks | the plugin's `hooks/hooks.json` (or `settings.json` for a manual install) |
| VS Code extension | `cc-telegram.cc-telegram-bridge` |

## How it works

```
Claude Code ──hooks (async)──► daemon (127.0.0.1) ──long polling──► api.telegram.org ──► you
     ▲                            │
     └──── inject.exe ◄───────────┘  your answers typed into the claude.exe console
```

- **Hooks** (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `StopFailure`, `SessionEnd`) forward each event to the daemon and exit immediately.
- **The daemon** tracks sessions, decides what to send, long-polls Telegram for your answers and runs as a hidden background process restarted by a supervisor.
- **`inject.exe`** (compiled from `native/inject.cs` at install) attaches to the console of the right `claude.exe` and writes keystrokes with `WriteConsoleInputW`. The key sequences for each Claude Code dialog are documented in `docs/ui-keymap.md`.
- **The VS Code extension** long-polls the daemon locally and opens a terminal tab for `➕ New session`; it opens no ports.

## Limitations

- Windows only (console injection, Task Scheduler, PowerShell process list).
- Don't type in the terminal at the very moment an answer arrives from Telegram — keystrokes could interleave.
- Answers rely on Claude Code's dialog layout; a future Claude Code UI change may need an update of `src/keys.mjs`.
- `➕ New session` needs a running VS Code window.

## Porting to macOS / Linux

The Telegram, routing, formatting, summary and session logic is platform-neutral. The Windows-specific pieces are:

| Piece | Windows implementation | Likely replacement |
| --- | --- | --- |
| Typing answers into the session | `native/inject.cs` (`WriteConsoleInputW`), `src/inject.mjs` | run `claude` inside tmux and use `tmux send-keys` |
| Finding the `claude` process of a hook | `inject.exe --ancestor`, `src/hookutil.mjs` | walk parents with `ps -o ppid=` |
| Process list / liveness | `src/procs.mjs` (PowerShell `Get-CimInstance`) | `ps -A -o pid,ppid,comm,lstart` |
| Autostart | `src/cli.mjs` (Task Scheduler XML), `scripts/launch.vbs` | launchd agent / systemd user service |
| `.env` permissions | `src/acl.mjs` (`icacls`) | `chmod 600` |
| New session tab | `src/newsession.mjs` (falls back to PowerShell), `cmd.exe /c code` | the user's shell, `code` directly |
| Paths | `path.win32` in `src/dirs.mjs`, `src/procs.mjs` | `path` |

## Development

```
npm test        # node:test, no dependencies
```

`hooks/hooks.json` is generated from `HOOK_EVENTS` in `src/settings.mjs`; a test fails if they drift apart.

## License

[MIT](LICENSE)
