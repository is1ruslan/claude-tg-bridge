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
  const state = path.join(home, '.claude', 'telegram', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'daemon.json'), JSON.stringify({ port: 1, secret: 's', pid: 200 }));
  d.listProcs = async () => new Map([[200, { name: 'node.exe', ppid: 100 }], [100, { name: 'node.exe', ppid: 1 }]]);
  await run(['stop'], d);
  assert.deepEqual(calls[0], ['taskkill', '/PID', '100', '/T', '/F']);
});

test('stop with stale pid (not node.exe) kills nothing', async () => {
  const { home, d, calls } = setup();
  const state = path.join(home, '.claude', 'telegram', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'daemon.json'), JSON.stringify({ port: 1, secret: 's', pid: 200 }));
  d.listProcs = async () => new Map([[200, { name: 'chrome.exe', ppid: 1 }]]);
  await run(['stop'], d);
  assert.equal(calls.length, 0);
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
