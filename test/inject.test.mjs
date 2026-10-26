import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectSteps } from '../src/inject.mjs';
import { build, findCsc } from '../native/build.mjs';

const win = process.platform === 'win32';
const exe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'inject.exe');
let skip = !win;
before(() => {
  if (skip) return;
  if (!fs.existsSync(exe)) {
    if (!findCsc()) { skip = 'csc.exe not found; cannot build inject.exe'; return; }
    build();
  }
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Node's detached spawn uses DETACHED_PROCESS (no console at all), so the target is started via
// Start-Process, which gives it its own (hidden) console with a real input buffer.
function startTarget(outFile) {
  const script = `$x = Read-Host; Set-Content -Encoding utf8 '${outFile}' $x`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `(Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-EncodedCommand','${encoded}').Id`],
    { encoding: 'utf8', windowsHide: true });
  const pid = Number(r.stdout.trim());
  assert.ok(pid > 0, `target start failed: ${r.stderr}`);
  return pid;
}

test('injects Cyrillic text and ENTER into a hidden console', { skip: !win }, async (t) => {
  if (skip) return t.skip(String(skip));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-'));
  const outFile = path.join(dir, 'out.txt');
  const pid = startTarget(outFile);
  try {
    await wait(1500);
    const steps = [{ text: 'привет — ok' }, { sleep: 400 }, { key: 'ENTER' }];
    const copy = JSON.stringify(steps);
    const r = await injectSteps(pid, steps);
    assert.deepEqual(r, { ok: true });
    assert.equal(JSON.stringify(steps), copy, 'steps must not be mutated');
    for (let i = 0; i < 80 && alive(pid); i++) await wait(100);
    assert.equal(fs.readFileSync(outFile, 'utf8').replace(/^﻿/, '').trim(), 'привет — ok');
  } finally {
    try { process.kill(pid); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nonexistent pid yields ok:false', { skip: !win }, async (t) => {
  if (skip) return t.skip(String(skip));
  const r = await injectSteps(999999, [{ key: 'ENTER' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /^err attach /);
});

// F1: --ancestor <pid> <name> walks the parent chain via a toolhelp snapshot.
test('inject.exe --ancestor <process.pid> node.exe -> ok <this pid> <creation ms>', (t) => {
  if (skip) return t.skip(String(skip));
  const r = spawnSync(exe, ['--ancestor', String(process.pid), 'node.exe'], { encoding: 'utf8', windowsHide: true, timeout: 5000, input: '' });
  assert.equal(r.status, 0);
  const m = /^ok (\d+) (\d+)\s*$/.exec(r.stdout);
  assert.ok(m, `stdout: ${r.stdout}`);
  assert.equal(Number(m[1]), process.pid);
  const started = Date.now() - performance.now();
  assert.ok(Math.abs(Number(m[2]) - started) < 2000, `creation ${m[2]} vs ${started}`);
});

test('inject.exe --ancestor: walks up to the parent (case-insensitive), "none" when no match', async (t) => {
  if (skip) return t.skip(String(skip));
  const { spawn } = await import('node:child_process');
  // cmd.exe is our child: walking up from it for NODE.EXE must land on this process.
  const child = spawn('cmd.exe', ['/d', '/c', 'ping -n 4 127.0.0.1 >nul'], { windowsHide: true, stdio: 'ignore' });
  try {
    await wait(200);
    const up = spawnSync(exe, ['--ancestor', String(child.pid), 'NODE.EXE'], { encoding: 'utf8', windowsHide: true, timeout: 5000, input: '' });
    const m = /^ok (\d+) \d+/.exec(up.stdout);
    assert.ok(m, `stdout: ${up.stdout}`);
    assert.equal(Number(m[1]), process.pid);
  } finally { child.kill(); }
  const none = spawnSync(exe, ['--ancestor', String(process.pid), 'no-such-process.exe'], { encoding: 'utf8', windowsHide: true, timeout: 5000, input: '' });
  assert.equal(none.status, 0);
  assert.equal(none.stdout.trim(), 'none');
});
