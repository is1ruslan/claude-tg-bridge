import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, renderLauncher } from '../src/cli.mjs';

const REPO = path.resolve(import.meta.dirname, '..');

function setup({ settings } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-cli-'));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), settings);
  }
  const calls = [];
  const lines = [];
  const d = {
    fs, home, repo: REPO, execPath: 'C:/node/node.exe', nodeVersion: '22.1.0',
    now: () => new Date(2026, 9, 26, 12, 0, 0),
    out: (s) => lines.push(s), err: (s) => lines.push(s), sleep: async () => {},
    fetch: async () => { throw new Error('no network'); },
    exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    buildNative: async () => 'built',
    restrictToUser: async () => {},
    listProcs: async () => new Map(),
    createTelegram: () => ({ sendMessage: async () => {} }),
  };
  return { home, d, calls, lines };
}

test('install: writes env, launcher, hooks, task; no start when env empty', async () => {
  const { home, d, calls } = setup({ settings: JSON.stringify({ effortLevel: 'high' }) });
  assert.equal(await run(['install'], d), 0);
  const root = path.join(home, '.claude', 'telegram');
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /TELEGRAM_BOT_TOKEN=\nTELEGRAM_USER_ID=\n/);
  assert.ok(fs.existsSync(path.join(root, 'state')) && fs.existsSync(path.join(root, 'logs')));
  const vbs = fs.readFileSync(path.join(root, 'launch.vbs'), 'utf8');
  assert.ok(!vbs.includes('__REPO__') && vbs.includes('C:/node/node.exe'));
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.effortLevel, 'high');
  assert.ok(s.hooks.Stop);
  assert.ok(fs.readdirSync(path.join(home, '.claude')).some((f) => f.startsWith('settings.json.bak-20261026-120000')));
  assert.ok(calls.some((c) => c[0] === 'schtasks' && c[1] === '/Create' && c.includes('cc-telegram')));
  assert.ok(!calls.some((c) => c[1] === '/Run'));
  // idempotent
  assert.equal(await run(['install'], d), 0);
  const s2 = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s2, s);
});

test('install: starts task when .env is filled', async () => {
  const { home, d, calls } = setup();
  const root = path.join(home, '.claude', 'telegram');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'TELEGRAM_BOT_TOKEN=123456:abcdef\nTELEGRAM_USER_ID=42\n');
  assert.equal(await run(['install'], d), 0);
  assert.ok(calls.some((c) => c[0] === 'schtasks' && c[1] === '/Run'));
});

test('install: invalid settings.json aborts without changes', async () => {
  const { home, d, calls } = setup({ settings: '{broken' });
  assert.equal(await run(['install'], d), 1);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{broken');
  assert.equal(calls.length, 0);
});

test('install: old Node aborts', async () => {
  const { d } = setup();
  d.nodeVersion = '20.0.0';
  assert.equal(await run(['install'], d), 1);
});

test('uninstall removes hooks, task, launcher; keeps .env', async () => {
  const { home, d, calls } = setup({ settings: JSON.stringify({ effortLevel: 'high' }) });
  await run(['install'], d);
  assert.equal(await run(['uninstall'], d), 0);
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s, { effortLevel: 'high' });
  const root = path.join(home, '.claude', 'telegram');
  assert.ok(fs.existsSync(path.join(root, '.env')));
  assert.ok(!fs.existsSync(path.join(root, 'launch.vbs')));
  assert.ok(calls.some((c) => c[1] === '/Delete'));
});

test('stop kills supervisor tree when parent is node.exe', async () => {
  const { home, d, calls } = setup();
  d.fetch = async () => ({ ok: true, json: async () => ({ ok: true, sessions: 0 }) });
  const state = path.join(home, '.claude', 'telegram', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'daemon.json'), JSON.stringify({ port: 1, secret: 's', pid: 200 }));
  d.listProcs = async () => new Map([[200, { name: 'node.exe', ppid: 100 }], [100, { name: 'node.exe', ppid: 1 }]]);
  await run(['stop'], d);
  assert.deepEqual(calls[0], ['taskkill', '/PID', '100', '/T', '/F']);
  assert.ok(!fs.existsSync(path.join(state, 'daemon.json')));
});

test('stop with stale pid (not node.exe, non-empty list) kills nothing, removes daemon.json', async () => {
  const { home, d, calls } = setup();
  const state = path.join(home, '.claude', 'telegram', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'daemon.json'), JSON.stringify({ port: 1, secret: 's', pid: 200 }));
  d.listProcs = async () => new Map([[200, { name: 'chrome.exe', ppid: 1 }]]);
  await run(['stop'], d);
  assert.equal(calls.length, 0);
  assert.ok(!fs.existsSync(path.join(state, 'daemon.json')));
});

test('disable / enable toggle flag file', async () => {
  const { home, d } = setup();
  const flag = path.join(home, '.claude', 'telegram', 'disabled');
  await run(['disable'], d);
  assert.ok(fs.existsSync(flag));
  await run(['enable'], d);
  assert.ok(!fs.existsSync(flag));
});

test('status uses /health with secret header and never prints secrets', async () => {
  const { home, d, lines } = setup();
  const state = path.join(home, '.claude', 'telegram', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'daemon.json'), JSON.stringify({ port: 5555, secret: 'topsecret', pid: 1 }));
  let seen;
  d.fetch = async (url, opts) => { seen = { url, h: opts.headers }; return { ok: true, json: async () => ({ ok: true, sessions: 2 }) }; };
  await run(['status'], d);
  assert.equal(seen.url, 'http://127.0.0.1:5555/health');
  assert.equal(seen.h['x-cc-secret'], 'topsecret');
  assert.ok(lines.join('\n').includes('сессий: 2'));
  assert.ok(!lines.join('\n').includes('topsecret'));
});

test('logs tails n lines; test sends message; unknown command fails', async () => {
  const { home, d, lines } = setup();
  const logs = path.join(home, '.claude', 'telegram', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'daemon.log'), 'a\nb\nc\n');
  await run(['logs', '2'], d);
  assert.equal(lines.at(-1), 'b\nc');
  fs.writeFileSync(path.join(home, '.claude', 'telegram', '.env'), 'TELEGRAM_BOT_TOKEN=123456:abcdef\nTELEGRAM_USER_ID=42\n');
  let sent;
  d.createTelegram = () => ({ sendMessage: async (m) => { sent = m; } });
  assert.equal(await run(['test'], d), 0);
  assert.deepEqual(sent, { chatId: 42, text: '🔔 cc-telegram: проверка связи' });
  assert.equal(await run(['nope'], d), 1);
});

test('renderLauncher substitutes repo and absolute node', () => {
  const tpl = fs.readFileSync(path.join(REPO, 'scripts', 'launch.vbs'), 'utf8');
  const out = renderLauncher(tpl, 'C:\\r', 'C:\\Program Files\\nodejs\\node.exe');
  assert.ok(out.includes('"""C:\\Program Files\\nodejs\\node.exe"" ""C:\\r\\src\\supervisor.mjs""'));
});

function withDaemon(extra = {}) {
  const s = setup(extra);
  const state = path.join(s.home, '.claude', 'telegram', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'daemon.json'), JSON.stringify({ port: 1, secret: 's', pid: 200 }));
  s.json = path.join(state, 'daemon.json');
  return s;
}
const ALIVE = async () => ({ ok: true, json: async () => ({ ok: true, sessions: 0 }) });

test('stop: empty process list + live /health -> nothing destructive', async () => {
  const { d, calls, json } = withDaemon();
  d.fetch = ALIVE;
  d.listProcs = async () => new Map();
  await run(['stop'], d);
  assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(json));
});

test('stop: no /health but node.exe pid -> not killed, daemon.json kept', async () => {
  const { d, calls, json, lines } = withDaemon();
  d.listProcs = async () => new Map([[200, { name: 'node.exe', ppid: 1 }]]);
  await run(['stop'], d);
  assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(json));
  assert.ok(lines.join('\n').includes('завершите вручную'));
});

test('stop: taskkill failure keeps daemon.json', async () => {
  const { d, json } = withDaemon();
  d.fetch = ALIVE;
  d.listProcs = async () => new Map([[200, { name: 'node.exe', ppid: 1 }]]);
  d.exec = async () => ({ code: 1, stdout: '', stderr: 'denied' });
  await run(['stop'], d);
  assert.ok(fs.existsSync(json));
});

test('settings write: unique backup names, no tmp left, uninstall no-op skips write', async () => {
  const { home, d } = setup({ settings: JSON.stringify({ a: 1 }) });
  await run(['install'], d);
  await run(['install'], d);
  const dir = path.join(home, '.claude');
  const files = fs.readdirSync(dir);
  assert.equal(files.filter((f) => f.startsWith('settings.json.bak-')).length, 2);
  assert.ok(!files.some((f) => f.includes('.tmp-')));
  const { home: h2, d: d2 } = setup({ settings: JSON.stringify({ a: 1 }) });
  await run(['uninstall'], d2);
  assert.ok(!fs.readdirSync(path.join(h2, '.claude')).some((f) => f.includes('.bak-')));
});

test('install: malformed hooks aborts before any side effect', async () => {
  for (const bad of [{ hooks: [] }, { hooks: 'x' }, { hooks: { Stop: {} } }]) {
    const { home, d, calls } = setup({ settings: JSON.stringify(bad) });
    assert.equal(await run(['install'], d), 1);
    assert.equal(calls.length, 0);
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'telegram')));
  }
});

// ---------- F8: Task XML + install order ----------

function xmlSetup(opts) {
  const s = setup(opts);
  s.d.env = { USERDOMAIN: 'DOM', USERNAME: 'bob' };
  s.seen = [];
  s.d.exec = async (cmd, args) => {
    s.calls.push([cmd, ...args]);
    if (cmd === 'schtasks' && args[0] === '/Create') {
      const file = args[args.indexOf('/XML') + 1];
      const settings = path.join(s.home, '.claude', 'settings.json');
      s.seen.push({
        xmlBytes: fs.readFileSync(file),
        launcherExists: fs.existsSync(path.join(s.home, '.claude', 'telegram', 'launch.vbs')),
        envExists: fs.existsSync(path.join(s.home, '.claude', 'telegram', '.env')),
        settingsAtCreate: fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null,
      });
      return s.createResult ?? { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return s;
}

test('F8: task registered via schtasks /Create /TN cc-telegram /XML <file> /F with UTF-16 LE BOM XML', async () => {
  const s = xmlSetup({ settings: JSON.stringify({ effortLevel: 'high' }) });
  assert.equal(await run(['install'], s.d), 0);
  const create = s.calls.find((c) => c[0] === 'schtasks' && c[1] === '/Create');
  assert.deepEqual([create[1], create[2], create[3], create[4], create[6]], ['/Create', '/TN', 'cc-telegram', '/XML', '/F']);
  assert.equal(create.length, 7);
  const bytes = s.seen[0].xmlBytes;
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 LE BOM');
  const xml = bytes.subarray(2).toString('utf16le');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
  const has = (re) => assert.match(xml, re);
  has(/<LogonTrigger>[\s\S]*<UserId>DOM\\bob<\/UserId>[\s\S]*<\/LogonTrigger>/);
  has(/<LogonType>InteractiveToken<\/LogonType>/);
  has(/<RunLevel>LeastPrivilege<\/RunLevel>/);
  has(/<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  has(/<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  has(/<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  has(/<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  has(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>\s*<\/RestartOnFailure>/);
  has(/<Hidden>true<\/Hidden>/);
  const launcher = path.join(s.home, '.claude', 'telegram', 'launch.vbs');
  has(/<Command>wscript\.exe<\/Command>/);
  assert.ok(xml.includes(`<Arguments>"${launcher}"</Arguments>`), 'launch.vbs quoted');
  assert.ok(!s.calls.some((c) => c.includes('/SC') || c.includes('/TR')));
});

test('F8: order — exe, .env, launch.vbs, task, and only then settings.json', async () => {
  const s = xmlSetup({ settings: JSON.stringify({ effortLevel: 'high' }) });
  const order = [];
  s.d.buildNative = async () => { order.push('build'); return 'built'; };
  assert.equal(await run(['install'], s.d), 0);
  assert.deepEqual(order, ['build']);
  const seen = s.seen[0];
  assert.equal(seen.launcherExists, true);
  assert.equal(seen.envExists, true);
  assert.equal(seen.settingsAtCreate, JSON.stringify({ effortLevel: 'high' }), 'settings untouched until the task exists');
  const after = JSON.parse(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(after.hooks.PreToolUse);
});

test('F8: task step fails -> settings.json untouched, error + retry hint (admin), exit 1', async () => {
  const s = xmlSetup({ settings: JSON.stringify({ effortLevel: 'high' }) });
  s.createResult = { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
  assert.equal(await run(['install'], s.d), 1);
  assert.equal(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8'), JSON.stringify({ effortLevel: 'high' }));
  assert.ok(!fs.readdirSync(path.join(s.home, '.claude')).some((f) => f.startsWith('settings.json.bak')));
  const text = s.lines.join('\n');
  assert.match(text, /Access is denied/);
  assert.match(text, /запустите терминал от администратора, если отказано в доступе/);
  assert.match(text, /node src\/cli\.mjs install/);
  assert.ok(!s.calls.some((c) => c[1] === '/Run'));
});

test('F8: XML escapes special characters in paths and user name', async () => {
  const { taskXml } = await import('../src/cli.mjs');
  const xml = taskXml({ userId: 'D&D\\bo<b>', launcher: 'C:\\a&b\\launch.vbs' });
  assert.ok(xml.includes('<UserId>D&amp;D\\bo&lt;b&gt;</UserId>'));
  assert.ok(xml.includes('<Arguments>"C:\\a&amp;b\\launch.vbs"</Arguments>'));
});
