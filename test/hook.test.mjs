import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths as mkPaths } from '../src/config.mjs';
import { claudeAncestor } from '../src/hookutil.mjs';

const HOOK = fileURLToPath(new URL('../src/hook.mjs', import.meta.url));
const PAYLOAD = { session_id: 's1', hook_event_name: 'Stop', last_assistant_message: 'very-private-payload' };

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-hook-'));
  return { home, p: mkPaths(home) };
}

function runHook(home, { env = {}, stdin = JSON.stringify(PAYLOAD) } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const childEnv = { ...process.env, USERPROFILE: home, HOME: home, ...env };
    if (!('CC_TELEGRAM_DISABLE' in env)) delete childEnv.CC_TELEGRAM_DISABLE;
    const child = spawn(process.execPath, [HOOK, 'Stop'], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
    child.stdin.end(stdin);
  });
}

function writeDaemonJson(p, port, secret = 'a'.repeat(32)) {
  fs.mkdirSync(p.stateDir, { recursive: true });
  fs.writeFileSync(p.daemonJson, JSON.stringify({ port, secret, pid: 1 }));
}

function server() {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { got.push({ url: req.url, headers: req.headers, body }); res.statusCode = 204; res.end(); });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, got, port: srv.address().port })));
}

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

test('RF-4: no daemon.json -> exit 0 < 2000ms, empty stdout, error logged without payload', async () => {
  const { home, p } = tempHome();
  const r = await runHook(home);
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.ok(r.ms < 2000, `took ${r.ms}ms`);
  const errLog = fs.readFileSync(path.join(p.logsDir, 'hook-errors.log'), 'utf8');
  assert.match(errLog, /Stop/);
  assert.ok(!errLog.includes('very-private-payload'));
});

test('RF-4: daemon.json points to a closed port -> exit 0 < 2000ms', async () => {
  const { home, p } = tempHome();
  writeDaemonJson(p, await freePort());
  const r = await runHook(home);
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.ok(r.ms < 2000, `took ${r.ms}ms`);
  assert.ok(!fs.readFileSync(path.join(p.logsDir, 'hook-errors.log'), 'utf8').includes('a'.repeat(32)));
});

test('posts {event, payload, ppid} with x-cc-secret to /event', async () => {
  const { home, p } = tempHome();
  const s = await server();
  try {
    writeDaemonJson(p, s.port, 'b'.repeat(32));
    const r = await runHook(home);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(s.got.length, 1);
    assert.equal(s.got[0].url, '/event');
    assert.equal(s.got[0].headers['x-cc-secret'], 'b'.repeat(32));
    const body = JSON.parse(s.got[0].body);
    assert.equal(body.event, 'Stop');
    assert.deepEqual(body.payload, PAYLOAD);
    assert.equal(typeof body.ppid, 'number');
  } finally { s.srv.close(); }
});

test('CC_TELEGRAM_DISABLE=1 -> nothing sent', async () => {
  const { home, p } = tempHome();
  const s = await server();
  try {
    writeDaemonJson(p, s.port);
    const r = await runHook(home, { env: { CC_TELEGRAM_DISABLE: '1' } });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(s.got.length, 0);
  } finally { s.srv.close(); }
});

test('disabled flag file -> nothing sent', async () => {
  const { home, p } = tempHome();
  const s = await server();
  try {
    writeDaemonJson(p, s.port);
    fs.writeFileSync(p.disabledFlag, '');
    const r = await runHook(home);
    assert.equal(r.code, 0);
    assert.equal(s.got.length, 0);
  } finally { s.srv.close(); }
});

test('RF-4: daemon accepts the connection but never answers -> exit 0 < 2000ms', async () => {
  const { home, p } = tempHome();
  const sockets = [];
  const srv = http.createServer(() => { /* hang forever */ });
  srv.on('connection', (c) => sockets.push(c));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    writeDaemonJson(p, srv.address().port);
    const r = await runHook(home);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.ok(r.ms < 2000, `took ${r.ms}ms`);
  } finally { for (const c of sockets) c.destroy(); srv.close(); }
});

function runHookEvent(home, eventName, payload) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const childEnv = { ...process.env, USERPROFILE: home, HOME: home };
    delete childEnv.CC_TELEGRAM_DISABLE;
    const child = spawn(process.execPath, [HOOK, eventName], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('minor: strings > 4000 chars deep-truncated before POST; tool_response.answers intact', async () => {
  const { home, p } = tempHome();
  const s = await server();
  try {
    writeDaemonJson(p, s.port, 'c'.repeat(32));
    const payload = {
      session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }], blob: 'z'.repeat(6000) },
      tool_response: { answers: { 'Q?': 'A' }, big: 'y'.repeat(4500) },
    };
    const r = await runHookEvent(home, 'PostToolUse', payload);
    assert.equal(r.code, 0);
    const body = JSON.parse(s.got[0].body);
    assert.equal(body.payload.tool_input.blob, 'z'.repeat(4000) + '…');
    assert.equal(body.payload.tool_response.big, 'y'.repeat(4000) + '…');
    assert.deepEqual(body.payload.tool_response.answers, { 'Q?': 'A' });
    assert.equal(body.claudePid, undefined, 'PostToolUse never runs the ancestor lookup');
  } finally { s.srv.close(); }
});

test('F1: SessionStart -> claudePid/claudeStartedAt = real claude.exe ancestor (omitted when none), < 2000ms', async () => {
  const { home, p } = tempHome();
  const s = await server();
  try {
    writeDaemonJson(p, s.port, 'd'.repeat(32));
    const r = await runHookEvent(home, 'SessionStart', { session_id: 's1', hook_event_name: 'SessionStart', cwd: 'C:/x' });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 2000, `took ${r.ms}ms`);
    const body = JSON.parse(s.got[0].body);
    assert.equal(body.event, 'SessionStart');
    // When the suite itself runs under Claude Code there IS a claude.exe ancestor; otherwise none.
    const expected = claudeAncestor(process.pid);
    if (expected) {
      assert.equal(body.claudePid, expected.claudePid);
      assert.equal(body.claudeStartedAt, expected.claudeStartedAt);
    } else assert.ok(!('claudePid' in body) && !('claudeStartedAt' in body));
    assert.equal(typeof body.ppid, 'number');
  } finally { s.srv.close(); }
});

test('F8: hook-errors.log > 256 KB is truncated before appending', async () => {
  const { home, p } = tempHome();
  fs.mkdirSync(p.logsDir, { recursive: true });
  const f = path.join(p.logsDir, 'hook-errors.log');
  fs.writeFileSync(f, 'old\n'.repeat(80 * 1024)); // 320 KB
  const r = await runHook(home); // no daemon.json -> logs an error
  assert.equal(r.code, 0);
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.length < 1000, `size ${text.length}`);
  assert.match(text, /daemon\.json unavailable/);
});
