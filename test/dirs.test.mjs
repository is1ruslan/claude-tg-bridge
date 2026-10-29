import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recentDirs, normDir } from '../src/dirs.mjs';

function mkProjects(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-dirs-'));
  let t = Date.now() / 1000 - 1000;
  for (const { enc, cwd, age } of spec) {
    const dir = path.join(root, enc);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${enc}.jsonl`);
    fs.writeFileSync(f, JSON.stringify({ type: 'x' }) + '\n' + JSON.stringify({ cwd, sessionId: 's' }) + '\n');
    fs.utimesSync(f, t - age, t - age);
  }
  return root;
}

test('recentDirs: newest first, dedup case-insensitive, missing folders skipped, limit', () => {
  const root = mkProjects([
    { enc: 'a', cwd: 'C:\\P\\alpha', age: 50 },
    { enc: 'b', cwd: 'C:\\P\\beta', age: 10 },
    { enc: 'c', cwd: 'c:\\p\\ALPHA', age: 5 },
    { enc: 'd', cwd: 'C:\\P\\gone', age: 1 },
    { enc: 'e', cwd: 'C:\\P\\eps', age: 100 },
  ]);
  const exists = (p) => !/gone/.test(p);
  const r = recentDirs({ projectsDir: root, exists });
  assert.deepEqual(r.map((d) => d.path), ['c:\\p\\ALPHA', 'C:\\P\\beta', 'C:\\P\\eps']);
  assert.deepEqual(r.map((d) => d.label), ['ALPHA', 'beta', 'eps']);
  assert.equal(recentDirs({ projectsDir: root, exists, limit: 2 }).length, 2);
});

test('recentDirs: same folder name -> parent\\name labels', () => {
  const root = mkProjects([
    { enc: 'a', cwd: 'C:\\one\\app', age: 1 },
    { enc: 'b', cwd: 'C:\\two\\app', age: 2 },
  ]);
  assert.deepEqual(recentDirs({ projectsDir: root, exists: () => true }).map((d) => d.label), ['one\\app', 'two\\app']);
});

test('recentDirs: missing projects dir -> []', () => {
  assert.deepEqual(recentDirs({ projectsDir: path.join(os.tmpdir(), 'nope-' + Date.now()) }), []);
});

test('normDir', () => {
  assert.equal(normDir('C:/Projects/X/'), 'c:\\projects\\x');
});
