import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findAncestor, listProcs, isClaudeAlive, gitBranch, projectName } from '../src/procs.mjs';

const mk = (entries) => async () => new Map(entries.map(([pid, name, ppid]) => [pid, { name, ppid }]));
const chain = () => mk([[300, 'node.exe', 200], [200, 'bash.exe', 100], [100, 'claude.exe', 4]]);

test('findAncestor walks up to claude.exe', async () => {
  assert.equal(await findAncestor(300, 'claude.exe', { listProcs: chain() }), 100);
});
test('findAncestor matches pid itself and ignores case', async () => {
  assert.equal(await findAncestor(100, 'CLAUDE.EXE', { listProcs: chain() }), 100);
});
test('findAncestor: cycle and broken chain give null', async () => {
  assert.equal(await findAncestor(1, 'claude.exe', { listProcs: mk([[1, 'a', 2], [2, 'b', 1]]) }), null);
  assert.equal(await findAncestor(1, 'claude.exe', { listProcs: mk([[1, 'a', 99]]) }), null);
});
test('findAncestor: depth limit 10', async () => {
  const e = [];
  for (let i = 1; i <= 12; i++) e.push([i, 'x.exe', i + 1]);
  e.push([13, 'claude.exe', 0]);
  assert.equal(await findAncestor(1, 'claude.exe', { listProcs: mk(e) }), null);
});
test('isClaudeAlive and reused pid (RF-5)', async () => {
  assert.equal(await isClaudeAlive(100, { listProcs: chain() }), true);
  assert.equal(await isClaudeAlive(100, { listProcs: mk([[100, 'notepad.exe', 4]]) }), false);
  assert.equal(await isClaudeAlive(555, { listProcs: chain() }), false);
});
test('listProcs smoke (real)', async () => {
  const m = await listProcs();
  assert.equal(m.get(process.pid)?.name.toLowerCase(), 'node.exe');
});
test('gitBranch on repo, detached, non-repo', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgit-'));
  const g = (...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
  g('init'); g('checkout', '-b', 'feat/x'); g('commit', '--allow-empty', '-m', 'i');
  assert.equal(await gitBranch(d), 'feat/x');
  g('checkout', '--detach');
  assert.match(await gitBranch(d), /^[0-9a-f]{4,}$/);
  const n = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnogit-'));
  assert.equal(await gitBranch(n), '—');
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(n, { recursive: true, force: true });
});
test('projectName', () => {
  const bs = String.fromCharCode(92);
  const p = ['C:', 'Projects', 'cc-telegram'].join(bs);
  assert.equal(projectName(p), 'cc-telegram');
  assert.equal(projectName(p + bs), 'cc-telegram');
});

// F1b: PID reuse guard via process creation time (Unix ms).
const withStart = (entries) => async () => new Map(entries.map(([pid, name, ppid, startedAt]) => [pid, { name, ppid, startedAt }]));
test('F1b: isClaudeAlive with startedAt requires a match within ±2 s', async () => {
  const lp = withStart([[100, 'claude.exe', 4, 1_000_000]]);
  assert.equal(await isClaudeAlive(100, { listProcs: lp, startedAt: 1_000_000 }), true);
  assert.equal(await isClaudeAlive(100, { listProcs: lp, startedAt: 1_001_999 }), true);
  assert.equal(await isClaudeAlive(100, { listProcs: lp, startedAt: 998_001 }), true);
  assert.equal(await isClaudeAlive(100, { listProcs: lp, startedAt: 1_002_500 }), false, 'pid reused by a newer claude.exe');
  assert.equal(await isClaudeAlive(100, { listProcs: lp }), true, 'unknown startedAt -> name check only');
  assert.equal(await isClaudeAlive(100, { listProcs: withStart([[100, 'claude.exe', 4, null]]), startedAt: 1_000_000 }), true, 'proc creation unknown -> name check only');
});
test('F1b: listProcs (real) returns startedAt as Unix ms for this process', async () => {
  const m = await listProcs();
  const me = m.get(process.pid);
  const started = Date.now() - performance.now();
  assert.equal(typeof me?.startedAt, 'number');
  assert.ok(Math.abs(me.startedAt - started) < 2000, `${me.startedAt} vs ${started}`);
});
