import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths as mkPaths } from '../src/config.mjs';

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
