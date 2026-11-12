#!/usr/bin/env node
// claude-tg-bridge CLI: install / uninstall / status / logs / test / enable / disable / start / stop / restart.
// All side effects go through `deps` so tests can run against temp dirs and stubs.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { paths, loadConfig } from './config.mjs';
import { mergeHooks, removeHooks } from './settings.mjs';
import { restrictToUser } from './acl.mjs';
import { listProcs } from './procs.mjs';
import { createTelegram } from './telegram.mjs';
import { buildVsix, EXT_ID } from './vsix.mjs';

const TASK = 'cc-telegram';
export const PLUGIN_NAME = 'tg-bridge'; // plugin id (Claude Code reserves names starting with claude-)
// What install copies into ~/.claude/telegram/app: a stable home for the daemon, independent of
// where the plugin cache (or a git clone) lives and of plugin updates.
const APP_ITEMS = ['src', 'native', 'scripts', 'vscode-ext', 'package.json'];
const ENV_TEMPLATE = `# claude-tg-bridge — fill in the values yourself; this file is readable only by your Windows user
# Bot token from @BotFather
TELEGRAM_BOT_TOKEN=
# Your numeric Telegram user ID (e.g. from @userinfobot); the bot talks to nobody else
TELEGRAM_USER_ID=
# Bot language: en or ru
CC_TG_LANG=en
# Where «➕ New session» → «Other folder» may create a missing project folder (default: %USERPROFILE%\\Projects)
CC_TG_PROJECTS_DIR=
`;

export const USAGE = `claude-tg-bridge — Claude Code ↔ Telegram bridge

Usage: node src/cli.mjs <command>

  install [--plugin]  install or update: copy to ~/.claude/telegram/app, build inject.exe, .env,
                      Task Scheduler task, hooks (settings.json, or none with --plugin — the plugin
                      ships its own), VS Code extension (new sessions from the bot)
  uninstall           stop the daemon, remove the task, hooks, extension and app copy
                      (.env, logs and state are kept)
  status              daemon state, sessions, task, disable flag
  start               start the daemon (Task Scheduler task)
  stop                stop the daemon
  restart             restart the daemon
  logs [n]            last n log lines (default 50)
  test                send a test message to Telegram
  disable             temporarily switch the bridge off (flag file)
  enable              switch it back on
`;

export function defaultDeps() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    fs: nodeFs,
    home: os.homedir(),
    env: process.env,
    repo: path.resolve(here, '..'),
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    now: () => new Date(),
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetch: globalThis.fetch,
    exec: (cmd, args) => new Promise((resolve) => {
      execFile(cmd, args, { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    }),
    buildNative: async (outFile) => (await import('../native/build.mjs')).build(outFile),
    restrictToUser,
    listProcs,
    createTelegram,
  };
}

const pad = (n) => String(n).padStart(2, '0');
export function stamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function renderLauncher(template, repo, execPath) {
  return template
    .split('"node ""__REPO__').join(`"""${execPath}"" ""${repo}`)
    .split('__REPO__').join(repo);
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // text nodes only

// Task Scheduler definition (written as UTF-16 LE with BOM, registered via schtasks /XML).
export function taskXml({ userId, launcher }) {
  const u = xmlEsc(userId);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>claude-tg-bridge: Claude Code ↔ Telegram bridge (daemon)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${u}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${u}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${xmlEsc(launcher)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function readJsonSafe(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function settingsFile(home) { return path.join(home, '.claude', 'settings.json'); }

// Reads settings.json; returns { obj, existed }. Throws on invalid JSON (never overwrite what we cannot parse).
function readSettings(d) {
  const file = settingsFile(d.home);
  if (!d.fs.existsSync(file)) return { file, obj: {}, existed: false };
  const text = d.fs.readFileSync(file, 'utf8');
  try {
    const obj = JSON.parse(text);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
    const h = obj.hooks;
    if (h !== undefined && (h === null || typeof h !== 'object' || Array.isArray(h) || Object.values(h).some((v) => !Array.isArray(v)))) {
      throw new Error(`${file}: the "hooks" field has an unexpected shape (expected an object of event lists). Fix the file by hand — the installer does not touch it.`);
    }
    return { file, obj, existed: true };
  } catch (e) {
    if (e.message.includes('"hooks"')) throw e;
    throw new Error(`${file} is not valid JSON (${e.message}). Fix the file by hand — the installer does not touch it.`);
  }
}

function writeSettings(d, file, obj, existed) {
  if (existed) {
    const base = `${file}.bak-${stamp(d.now())}`;
    let bak = base;
    for (let i = 1; d.fs.existsSync(bak); i++) bak = `${base}-${i}`;
    d.fs.copyFileSync(file, bak);
  } else d.fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  d.fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  d.fs.renameSync(tmp, file);
}

// The plugin is enabled in settings.json → its hooks/hooks.json is active; ours must not be duplicated.
export function pluginEnabled(settings) {
  const ep = settings?.enabledPlugins;
  return !!ep && typeof ep === 'object' && Object.entries(ep).some(([k, v]) => v === true && k.split('@')[0] === PLUGIN_NAME);
}

function envFilled(d) {
  const c = loadConfig(d.home, {});
  return Boolean(c.token) && c.userId !== null;
}

async function daemonInfo(d) {
  const p = paths(d.home);
  const info = readJsonSafe(d.fs, p.daemonJson);
  if (!info || !Number.isInteger(info.pid)) return null;
  return info;
}

async function health(d) {
  const info = await daemonInfo(d);
  if (!info || !info.port || !info.secret) return null;
  try {
    const res = await d.fetch(`http://127.0.0.1:${info.port}/health`, { headers: { 'x-cc-secret': info.secret }, signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function stopDaemon(d) {
  const p = paths(d.home);
  const info = await daemonInfo(d);
  if (!info) { d.out('daemon is not running'); return false; }
  const alive = Boolean(await health(d));
  const procs = await d.listProcs();
  const me = procs.get(info.pid);
  const isNode = Boolean(me) && me.name.toLowerCase() === 'node.exe';
  if (procs.size === 0) {
    d.out('could not identify the daemon process (process list unavailable); nothing changed');
    return false;
  }
  if (!alive) {
    if (!isNode) {
      d.out('daemon is not running (stale daemon.json)');
      d.fs.rmSync(p.daemonJson, { force: true });
    } else {
      d.out(`daemon is not responding; pid ${info.pid} — end it by hand if needed`);
    }
    return false;
  }
  if (!isNode) { d.out(`pid ${info.pid} is not node.exe; nothing changed`); return false; }
  const parent = procs.get(me.ppid);
  const target = parent && parent.name.toLowerCase() === 'node.exe' ? me.ppid : info.pid;
  const k = await d.exec('taskkill', ['/PID', String(target), '/T', '/F']);
  if (k.code !== 0) { d.err(`taskkill failed: ${k.stderr || k.stdout}`.trim()); return false; }
  d.fs.rmSync(p.daemonJson, { force: true });
  d.out(`daemon stopped (pid ${target})`);
  return true;
}

async function startDaemon(d) {
  const r = await d.exec('schtasks', ['/Run', '/TN', TASK]);
  if (r.code !== 0) { d.err(`could not start task ${TASK}: ${r.stderr || r.stdout}`.trim()); return false; }
  for (let i = 0; i < 20; i++) {
    if (await health(d)) { d.out('daemon started'); return true; }
    await d.sleep(500);
  }
  d.err('the daemon did not answer /health within 10 seconds — see: node src/cli.mjs logs');
  return false;
}

// Copy the runtime into ~/.claude/telegram/app (replacing an older copy). No-op when run from there.
function syncApp(d, app) {
  if (path.resolve(d.repo).toLowerCase() === path.resolve(app).toLowerCase()) return;
  d.fs.rmSync(app, { recursive: true, force: true });
  d.fs.mkdirSync(app, { recursive: true });
  for (const item of APP_ITEMS) {
    const from = path.join(d.repo, item);
    if (!d.fs.existsSync(from)) continue;
    d.fs.cpSync(from, path.join(app, item), {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|inject\.exe|config\.json)$/i.test(src),
    });
  }
}

async function install(d, flags) {
  const [major] = d.nodeVersion.split('.').map(Number);
  if (!(major >= 22)) { d.err(`Node.js 22 or newer is required (found ${d.nodeVersion})`); return 1; }
  const p = paths(d.home);

  // Parse settings first: abort before changing anything if the file is broken.
  let st;
  try { st = readSettings(d); } catch (e) { d.err(e.message); return 1; }
  const plugin = flags.includes('--plugin') || pluginEnabled(st.obj);

  // Update: the running daemon is stopped first so the app copy can be replaced, then started again.
  if (await health(d)) {
    await stopDaemon(d);
    await d.exec('schtasks', ['/End', '/TN', TASK]);
  }

  d.fs.mkdirSync(p.root, { recursive: true });
  try { syncApp(d, p.app); } catch (e) { d.err(`could not copy the app to ${p.app}: ${e.message}`); return 1; }
  try { await d.buildNative(path.join(p.app, 'native', 'inject.exe')); } catch (e) { d.err(`building native/inject.exe failed: ${e.message}`); return 1; }
  d.fs.mkdirSync(p.stateDir, { recursive: true });
  d.fs.mkdirSync(p.logsDir, { recursive: true });

  let envCreated = false;
  if (!d.fs.existsSync(p.env)) { d.fs.writeFileSync(p.env, ENV_TEMPLATE); envCreated = true; }
  await d.restrictToUser(p.env);

  const tpl = d.fs.readFileSync(path.join(p.app, 'scripts', 'launch.vbs'), 'utf8');
  const launcher = path.join(p.root, 'launch.vbs');
  d.fs.writeFileSync(launcher, renderLauncher(tpl, p.app, d.execPath));

  // F8: the task goes in before settings.json — hooks without a daemon task would be useless.
  const env = d.env ?? process.env;
  const userId = env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME ?? ''}` : String(env.USERNAME ?? '');
  const xmlFile = path.join(p.root, 'task.xml');
  d.fs.writeFileSync(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml({ userId, launcher }), 'utf16le')]));
  const c = await d.exec('schtasks', ['/Create', '/TN', TASK, '/XML', xmlFile, '/F']);
  d.fs.rmSync(xmlFile, { force: true });
  if (c.code !== 0) {
    d.err(`schtasks /Create failed: ${c.stderr || c.stdout}`.trim());
    d.err('settings.json was not changed. Fix the cause and run again: node src/cli.mjs install');
    d.err('(run the terminal as administrator if access is denied)');
    return 1;
  }

  // Plugin: hooks come from the plugin's hooks/hooks.json, so ours (e.g. from an earlier
  // git-clone install) are removed. Otherwise they go into settings.json, pointing at the app copy.
  const next = plugin ? removeHooks(st.obj) : mergeHooks(st.obj, p.app);
  const hooksChanged = JSON.stringify(next) !== JSON.stringify(st.obj);
  if (hooksChanged) writeSettings(d, st.file, next, st.existed);

  // VS Code extension for «➕ New session». Optional: a failure here does not undo the install.
  const vsix = path.join(p.root, 'cc-telegram-bridge.vsix');
  let extLine;
  try {
    (d.buildVsix ?? buildVsix)(path.join(p.app, 'vscode-ext'), vsix, {
      node: d.execPath, script: path.join(p.app, 'src', 'newsession.mjs'),
    });
    const x = await d.exec('cmd.exe', ['/d', '/c', 'code', '--install-extension', vsix, '--force']);
    extLine = x.code === 0
      ? '  - VS Code extension cc-telegram-bridge (once, in VS Code: Developer: Reload Window)'
      : `  - VS Code extension not installed: ${(x.stderr || x.stdout).trim()} — install it by hand: code --install-extension "${vsix}"`;
  } catch (e) {
    extLine = `  - VS Code extension not built: ${e.message}`;
  }

  d.out('Installed:');
  d.out(`  - app: ${p.app} (native/inject.exe built)`);
  d.out(`  - data folder: ${p.root}`);
  if (plugin) d.out(`  - hooks: provided by the ${PLUGIN_NAME} plugin${hooksChanged ? ' (old hooks removed from settings.json, backup settings.json.bak-*)' : ''}`);
  else d.out(`  - hooks added to ${st.file}${st.existed && hooksChanged ? ' (backup settings.json.bak-*)' : ''}`);
  d.out(`  - Task Scheduler task ${TASK} (starts at logon)`);
  d.out(extLine);
  if (envFilled(d)) {
    const r = await d.exec('schtasks', ['/Run', '/TN', TASK]);
    d.out(r.code === 0 ? '  - daemon started' : `  - could not start the task: ${r.stderr || r.stdout}`.trim());
  } else {
    d.out('');
    d.out(`${envCreated ? 'Created' : 'Fill in'} ${p.env}: set TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID.`);
    d.out('Then run: node src/cli.mjs restart');
  }
  return 0;
}

async function uninstall(d) {
  const p = paths(d.home);
  await stopDaemon(d);
  const r = await d.exec('schtasks', ['/Delete', '/TN', TASK, '/F']);
  d.out(r.code === 0 ? `task ${TASK} removed` : `task ${TASK} not found or not removed`);
  try {
    const st = readSettings(d);
    if (st.existed) {
      const next = removeHooks(st.obj);
      if (JSON.stringify(next) !== JSON.stringify(st.obj)) { writeSettings(d, st.file, next, true); d.out('hooks removed from settings.json'); }
      else d.out('no hooks of ours in settings.json');
    }
  } catch (e) { d.err(e.message); }
  d.fs.rmSync(path.join(p.root, 'launch.vbs'), { force: true });
  const x = await d.exec('cmd.exe', ['/d', '/c', 'code', '--uninstall-extension', EXT_ID]);
  d.out(x.code === 0 ? 'VS Code extension removed' : 'VS Code extension not found or not removed');
  d.fs.rmSync(path.join(p.root, 'cc-telegram-bridge.vsix'), { force: true });
  if (path.resolve(d.repo).toLowerCase() !== path.resolve(p.app).toLowerCase()) d.fs.rmSync(p.app, { recursive: true, force: true });
  d.out(`Kept: ${p.root} (.env, logs, state). To delete it: rmdir /s /q "${p.root}"`);
  return 0;
}

async function status(d) {
  const p = paths(d.home);
  const h = await health(d);
  d.out(h ? `daemon: running, sessions: ${h.sessions}` : 'daemon: not responding');
  const q = await d.exec('schtasks', ['/Query', '/TN', TASK]);
  d.out(`Task Scheduler task ${TASK}: ${q.code === 0 ? 'present' : 'missing'}`);
  d.out(`disabled: ${d.fs.existsSync(p.disabledFlag) ? 'YES (bridge switched off)' : 'no'}`);
  d.out(`.env filled: ${envFilled(d) ? 'yes' : 'no'}`);
  return 0;
}

function logs(d, n) {
  const file = path.join(paths(d.home).logsDir, 'daemon.log');
  let text;
  try { text = d.fs.readFileSync(file, 'utf8'); } catch { d.out(`log is empty or missing: ${file}`); return 0; }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  d.out(lines.slice(-n).join('\n'));
  return 0;
}

async function testMsg(d) {
  const c = loadConfig(d.home, {});
  if (!c.token || c.userId === null) { d.err(`fill in ${paths(d.home).env} (TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID)`); return 1; }
  try {
    await d.createTelegram({ token: c.token }).sendMessage({ chatId: c.userId, text: '🔔 claude-tg-bridge: connection test' });
    d.out('message sent');
    return 0;
  } catch (e) { d.err(`could not send: ${e.message}`); return 1; }
}

export async function run(argv, d = defaultDeps()) {
  const [cmd, arg] = argv;
  const p = paths(d.home);
  switch (cmd) {
    case 'install': return install(d, argv.slice(1));
    case 'uninstall': return uninstall(d);
    case 'status': return status(d);
    case 'logs': return logs(d, Number.parseInt(arg, 10) > 0 ? Number.parseInt(arg, 10) : 50);
    case 'test': return testMsg(d);
    case 'disable': d.fs.mkdirSync(p.root, { recursive: true }); d.fs.writeFileSync(p.disabledFlag, ''); d.out('bridge switched off (enable — switch it on)'); return 0;
    case 'enable': d.fs.rmSync(p.disabledFlag, { force: true }); d.out('bridge switched on'); return 0;
    case 'stop': await stopDaemon(d); return 0;
    case 'start': return (await startDaemon(d)) ? 0 : 1;
    case 'restart':
      await stopDaemon(d);
      // The task instance (wscript waiting on the supervisor) may still count as running;
      // with MultipleInstancesPolicy=IgnoreNew the next /Run would then be silently dropped.
      await d.exec('schtasks', ['/End', '/TN', TASK]);
      return (await startDaemon(d)) ? 0 : 1;
    case undefined: case '--help': case '-h': case 'help': d.out(USAGE); return 0;
    default: d.err(`unknown command: ${cmd}\n\n${USAGE}`); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exitCode = 1; });
}
