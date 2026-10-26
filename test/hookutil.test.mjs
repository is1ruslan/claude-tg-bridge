import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsAncestor, claudeAncestor, truncateDeep, capLogFile, INJECT_EXE } from '../src/hookutil.mjs';

const exe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'inject.exe');

test('F1: needsAncestor only for SessionStart/UserPromptSubmit/PermissionRequest and PreToolUse Ask/ExitPlanMode', () => {
  assert.equal(needsAncestor('SessionStart', {}), true);
  assert.equal(needsAncestor('UserPromptSubmit', {}), true);
  assert.equal(needsAncestor('PermissionRequest', { tool_name: 'Bash' }), true);
  assert.equal(needsAncestor('PreToolUse', { tool_name: 'AskUserQuestion' }), true);
  assert.equal(needsAncestor('PreToolUse', { tool_name: 'ExitPlanMode' }), true);
  assert.equal(needsAncestor('PreToolUse', { tool_name: 'Bash' }), false);
  for (const e of ['PostToolUse', 'Stop', 'StopFailure', 'SessionEnd', '']) assert.equal(needsAncestor(e, { tool_name: 'AskUserQuestion' }), false, e);
});

test('F1: INJECT_EXE resolves to <repo>/native/inject.exe', () => {
  assert.equal(INJECT_EXE.toLowerCase(), exe.toLowerCase());
});

test('F1: claudeAncestor parses "ok <pid> <ms>", passes ppid/name/timeout, omits on none/failure', () => {
  const calls = [];
  const sp = (out, extra = {}) => (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: out, ...extra }; };
  assert.deepEqual(claudeAncestor(123, { spawnSync: sp('ok 4242 1730000000000\r\n') }), { claudePid: 4242, claudeStartedAt: 1730000000000 });
  assert.deepEqual(calls[0].args, ['--ancestor', '123', 'claude.exe']);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.timeout, 800);
  assert.deepEqual(claudeAncestor(123, { spawnSync: sp('ok 4242 0\n') }), { claudePid: 4242 });
  assert.equal(claudeAncestor(123, { spawnSync: sp('none\n') }), null);
  assert.equal(claudeAncestor(123, { spawnSync: sp('', { status: null, error: new Error('ETIMEDOUT') }) }), null);
  assert.equal(claudeAncestor(123, { spawnSync: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(claudeAncestor(undefined, { spawnSync: sp('ok 1 1') }), null);
});

test('F1: claudeAncestor with the real inject.exe finds this node.exe', (t) => {
  if (!fs.existsSync(exe)) return t.skip('inject.exe not built');
  const r = claudeAncestor(process.pid, { name: 'node.exe' });
  assert.equal(r?.claudePid, process.pid);
  assert.ok(r.claudeStartedAt > 1_600_000_000_000);
});

test('truncateDeep: strings > 4000 -> 4000 + "…", nested, short untouched, no split surrogate', () => {
  const long = 'x'.repeat(5000);
  const p = { a: long, b: { c: [long, 'ok'] }, tool_response: { answers: { 'Q?': 'A' } }, n: 5, z: null };
  const out = truncateDeep(p);
  assert.equal(out.a, 'x'.repeat(4000) + '…');
  assert.equal(out.b.c[0].length, 4001);
  assert.equal(out.b.c[1], 'ok');
  assert.deepEqual(out.tool_response, { answers: { 'Q?': 'A' } });
  assert.equal(out.n, 5);
  assert.equal(out.z, null);
  assert.equal(p.a.length, 5000, 'input not mutated');
  const emoji = 'x'.repeat(3999) + '😀' + 'y'.repeat(10);
  const e = truncateDeep({ s: emoji }).s;
  assert.equal(e, 'x'.repeat(3999) + '…');
});

test('capLogFile: > 256 KB -> truncated to empty; smaller untouched; missing ok', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-cap-'));
  const f = path.join(dir, 'hook-errors.log');
  capLogFile(f);
  fs.writeFileSync(f, 'a'.repeat(1000));
  capLogFile(f);
  assert.equal(fs.statSync(f).size, 1000);
  fs.writeFileSync(f, 'a'.repeat(300 * 1024));
  capLogFile(f);
  assert.equal(fs.statSync(f).size, 0);
});
