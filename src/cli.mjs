#!/usr/bin/env node
// cc-telegram CLI: install / uninstall / status / logs / test / enable / disable / start / stop / restart.
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
const ENV_TEMPLATE = `# cc-telegram — впишите значения сами, файл доступен только вашему пользователю
TELEGRAM_BOT_TOKEN=
TELEGRAM_USER_ID=
`;

export const USAGE = `cc-telegram — мост между Claude Code и Telegram

Использование: node src/cli.mjs <команда>

  install     установить: сборка inject.exe, папки, .env, задача Планировщика, хуки в settings.json,
              расширение VS Code (новые сессии из бота)
  uninstall   остановить демон, удалить задачу, хуки и расширение (.env, логи, состояние остаются)
  status      состояние демона, сессии, задача, флаг отключения
  start       запустить демон (задача Планировщика)
  stop        остановить демон
  restart     перезапустить демон
  logs [n]    последние n строк лога (по умолчанию 50)
  test        отправить тестовое сообщение в Telegram
  disable     временно выключить мост (файл-флаг)
  enable      снова включить мост
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
    buildNative: async () => (await import('../native/build.mjs')).build(),
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
    <Description>cc-telegram: мост Claude Code ↔ Telegram (демон)</Description>
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
      throw new Error(`${file}: поле "hooks" имеет неожиданный формат (ожидается объект событий со списками). Исправьте файл вручную — установщик его не трогает.`);
    }
    return { file, obj, existed: true };
  } catch (e) {
    if (e.message.includes('"hooks"')) throw e;
    throw new Error(`${file} содержит некорректный JSON (${e.message}). Исправьте файл вручную — установщик его не трогает.`);
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
  if (!info) { d.out('демон не запущен'); return false; }
  const alive = Boolean(await health(d));
  const procs = await d.listProcs();
  const me = procs.get(info.pid);
  const isNode = Boolean(me) && me.name.toLowerCase() === 'node.exe';
  if (procs.size === 0) {
    d.out('не удалось определить процесс демона (список процессов недоступен); ничего не изменено');
    return false;
  }
  if (!alive) {
    if (!isNode) {
      d.out('демон не запущен (daemon.json устарел)');
      d.fs.rmSync(p.daemonJson, { force: true });
    } else {
      d.out(`демон не отвечает; pid ${info.pid} — завершите вручную при необходимости`);
    }
    return false;
  }
  if (!isNode) { d.out(`pid ${info.pid} не является node.exe; ничего не изменено`); return false; }
  const parent = procs.get(me.ppid);
  const target = parent && parent.name.toLowerCase() === 'node.exe' ? me.ppid : info.pid;
  const k = await d.exec('taskkill', ['/PID', String(target), '/T', '/F']);
  if (k.code !== 0) { d.err(`taskkill не удался: ${k.stderr || k.stdout}`.trim()); return false; }
  d.fs.rmSync(p.daemonJson, { force: true });
  d.out(`демон остановлен (pid ${target})`);
  return true;
}

async function startDaemon(d) {
  const r = await d.exec('schtasks', ['/Run', '/TN', TASK]);
  if (r.code !== 0) { d.err(`не удалось запустить задачу ${TASK}: ${r.stderr || r.stdout}`.trim()); return false; }
  for (let i = 0; i < 20; i++) {
    if (await health(d)) { d.out('демон запущен'); return true; }
    await d.sleep(500);
  }
  d.err('демон не ответил на /health за 10 секунд — смотрите: node src/cli.mjs logs');
  return false;
}

async function install(d) {
  const [major] = d.nodeVersion.split('.').map(Number);
  if (!(major >= 22)) { d.err(`нужен Node.js 22 или новее (сейчас ${d.nodeVersion})`); return 1; }
  const p = paths(d.home);

  // Parse settings first: abort before changing anything if the file is broken.
  let st;
  try { st = readSettings(d); } catch (e) { d.err(e.message); return 1; }

  try { await d.buildNative(); } catch (e) { d.err(`сборка native/inject.exe не удалась: ${e.message}`); return 1; }
  d.fs.mkdirSync(p.stateDir, { recursive: true });
  d.fs.mkdirSync(p.logsDir, { recursive: true });

  let envCreated = false;
  if (!d.fs.existsSync(p.env)) { d.fs.writeFileSync(p.env, ENV_TEMPLATE); envCreated = true; }
  await d.restrictToUser(p.env);

  const tpl = d.fs.readFileSync(path.join(d.repo, 'scripts', 'launch.vbs'), 'utf8');
  const launcher = path.join(p.root, 'launch.vbs');
  d.fs.writeFileSync(launcher, renderLauncher(tpl, d.repo, d.execPath));

  // F8: the task goes in before settings.json — hooks without a daemon task would be useless.
  const env = d.env ?? process.env;
  const userId = env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME ?? ''}` : String(env.USERNAME ?? '');
  const xmlFile = path.join(p.root, 'task.xml');
  d.fs.writeFileSync(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml({ userId, launcher }), 'utf16le')]));
  const c = await d.exec('schtasks', ['/Create', '/TN', TASK, '/XML', xmlFile, '/F']);
  d.fs.rmSync(xmlFile, { force: true });
  if (c.code !== 0) {
    d.err(`schtasks /Create не удался: ${c.stderr || c.stdout}`.trim());
    d.err('settings.json не изменён. Исправьте причину и повторите: node src/cli.mjs install');
    d.err('(запустите терминал от администратора, если отказано в доступе)');
    return 1;
  }

  writeSettings(d, st.file, mergeHooks(st.obj, d.repo), st.existed);

  // VS Code extension for «➕ Новая сессия». Optional: a failure here does not undo the install.
  const vsix = path.join(p.root, 'cc-telegram-bridge.vsix');
  let extLine;
  try {
    (d.buildVsix ?? buildVsix)(path.join(d.repo, 'vscode-ext'), vsix, {
      node: d.execPath, script: path.join(d.repo, 'src', 'newsession.mjs'),
    });
    const x = await d.exec('cmd.exe', ['/d', '/c', 'code', '--install-extension', vsix, '--force']);
    extLine = x.code === 0
      ? '  - расширение VS Code cc-telegram-bridge (один раз выполните в VS Code: Developer: Reload Window)'
      : `  - расширение VS Code не установлено: ${(x.stderr || x.stdout).trim()} — установите вручную: code --install-extension "${vsix}"`;
  } catch (e) {
    extLine = `  - расширение VS Code не собрано: ${e.message}`;
  }

  d.out('Установлено:');
  d.out(`  - собран native/inject.exe`);
  d.out(`  - папка данных: ${p.root}`);
  d.out(`  - хуки добавлены в ${st.file}${st.existed ? ' (резервная копия settings.json.bak-*)' : ''}`);
  d.out(`  - задача Планировщика ${TASK} (запуск при входе в систему)`);
  d.out(extLine);
  if (envFilled(d)) {
    const r = await d.exec('schtasks', ['/Run', '/TN', TASK]);
    d.out(r.code === 0 ? '  - демон запущен' : `  - не удалось запустить задачу: ${r.stderr || r.stdout}`.trim());
  } else {
    d.out('');
    d.out(`${envCreated ? 'Создан' : 'Заполните'} файл ${p.env}: впишите TELEGRAM_BOT_TOKEN и TELEGRAM_USER_ID.`);
    d.out('Затем выполните: node src/cli.mjs restart');
  }
  return 0;
}

async function uninstall(d) {
  const p = paths(d.home);
  await stopDaemon(d);
  const r = await d.exec('schtasks', ['/Delete', '/TN', TASK, '/F']);
  d.out(r.code === 0 ? `задача ${TASK} удалена` : `задача ${TASK} не найдена или не удалена`);
  try {
    const st = readSettings(d);
    if (st.existed) {
      const next = removeHooks(st.obj);
      if (JSON.stringify(next) !== JSON.stringify(st.obj)) { writeSettings(d, st.file, next, true); d.out('хуки удалены из settings.json'); }
      else d.out('в settings.json наших хуков нет');
    }
  } catch (e) { d.err(e.message); }
  d.fs.rmSync(path.join(p.root, 'launch.vbs'), { force: true });
  const x = await d.exec('cmd.exe', ['/d', '/c', 'code', '--uninstall-extension', EXT_ID]);
  d.out(x.code === 0 ? 'расширение VS Code удалено' : 'расширение VS Code не найдено или не удалено');
  d.fs.rmSync(path.join(p.root, 'cc-telegram-bridge.vsix'), { force: true });
  d.out(`Оставлено: ${p.root} (.env, logs, state). Удалить вручную: rmdir /s /q "${p.root}"`);
  return 0;
}

async function status(d) {
  const p = paths(d.home);
  const h = await health(d);
  d.out(h ? `демон: работает, сессий: ${h.sessions}` : 'демон: не отвечает');
  const q = await d.exec('schtasks', ['/Query', '/TN', TASK]);
  d.out(`задача Планировщика ${TASK}: ${q.code === 0 ? 'есть' : 'нет'}`);
  d.out(`отключение (disabled): ${d.fs.existsSync(p.disabledFlag) ? 'ВКЛЮЧЕНО (мост выключен)' : 'нет'}`);
  d.out(`.env заполнен: ${envFilled(d) ? 'да' : 'нет'}`);
  return 0;
}

function logs(d, n) {
  const file = path.join(paths(d.home).logsDir, 'daemon.log');
  let text;
  try { text = d.fs.readFileSync(file, 'utf8'); } catch { d.out(`лог пуст или не найден: ${file}`); return 0; }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  d.out(lines.slice(-n).join('\n'));
  return 0;
}

async function testMsg(d) {
  const c = loadConfig(d.home, {});
  if (!c.token || c.userId === null) { d.err(`заполните ${paths(d.home).env} (TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID)`); return 1; }
  try {
    await d.createTelegram({ token: c.token }).sendMessage({ chatId: c.userId, text: '🔔 cc-telegram: проверка связи' });
    d.out('сообщение отправлено');
    return 0;
  } catch (e) { d.err(`не удалось отправить: ${e.message}`); return 1; }
}

export async function run(argv, d = defaultDeps()) {
  const [cmd, arg] = argv;
  const p = paths(d.home);
  switch (cmd) {
    case 'install': return install(d);
    case 'uninstall': return uninstall(d);
    case 'status': return status(d);
    case 'logs': return logs(d, Number.parseInt(arg, 10) > 0 ? Number.parseInt(arg, 10) : 50);
    case 'test': return testMsg(d);
    case 'disable': d.fs.mkdirSync(p.root, { recursive: true }); d.fs.writeFileSync(p.disabledFlag, ''); d.out('мост выключен (enable — включить)'); return 0;
    case 'enable': d.fs.rmSync(p.disabledFlag, { force: true }); d.out('мост включён'); return 0;
    case 'stop': await stopDaemon(d); return 0;
    case 'start': return (await startDaemon(d)) ? 0 : 1;
    case 'restart':
      await stopDaemon(d);
      // The task instance (wscript waiting on the supervisor) may still count as running;
      // with MultipleInstancesPolicy=IgnoreNew the next /Run would then be silently dropped.
      await d.exec('schtasks', ['/End', '/TN', TASK]);
      return (await startDaemon(d)) ? 0 : 1;
    case undefined: case '--help': case '-h': case 'help': d.out(USAGE); return 0;
    default: d.err(`неизвестная команда: ${cmd}\n\n${USAGE}`); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exitCode = 1; });
}
