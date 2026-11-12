import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recentDirs, normDir, looksLikeDir, newProjectDir } from '../src/dirs.mjs';

test('newProjectDir: only a direct child of C:\\Projects with a valid name', () => {
  assert.equal(newProjectDir('C:\\Projects\\test-tg'), 'C:\\Projects\\test-tg');
  assert.equal(newProjectDir('c:/projects/new app/'), 'C:\\Projects\\new app');
  for (const bad of ['C:\\Projects', 'C:\\Projects\\a\\b', 'D:\\Projects\\x', 'C:\\Other\\x', 'C:\\Projects\\..\\x',
    'C:\\Projects\\a?b', 'C:\\Projects\\con', 'C:\\Projects\\name.', 'C:\\Projects\\x:y']) {
    assert.equal(newProjectDir(bad), null, bad);
  }
});

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

test('recentDirs: newest first, dedup case-insensitive, missing folders skipped, limit', async () => {
  const root = mkProjects([
    { enc: 'a', cwd: 'C:\\P\\alpha', age: 50 },
    { enc: 'b', cwd: 'C:\\P\\beta', age: 10 },
    { enc: 'c', cwd: 'c:\\p\\ALPHA', age: 5 },
    { enc: 'd', cwd: 'C:\\P\\gone', age: 1 },
    { enc: 'e', cwd: 'C:\\P\\eps', age: 100 },
  ]);
  const exists = (p) => !/gone/.test(p);
  const r = await recentDirs({ projectsDir: root, exists });
  assert.deepEqual(r.map((d) => d.path), ['c:\\p\\ALPHA', 'C:\\P\\beta', 'C:\\P\\eps']);
  assert.deepEqual(r.map((d) => d.label), ['ALPHA', 'beta', 'eps']);
  assert.equal((await recentDirs({ projectsDir: root, exists, limit: 2 })).length, 2);
});

test('recentDirs: same folder name -> parent\\name labels', async () => {
  const root = mkProjects([
    { enc: 'a', cwd: 'C:\\one\\app', age: 1 },
    { enc: 'b', cwd: 'C:\\two\\app', age: 2 },
  ]);
  assert.deepEqual((await recentDirs({ projectsDir: root, exists: () => true })).map((d) => d.label), ['one\\app', 'two\\app']);
});

test('recentDirs: missing projects dir -> []', async () => {
  assert.deepEqual(await recentDirs({ projectsDir: path.join(os.tmpdir(), 'nope-' + Date.now()) }), []);
});

test('normDir', () => {
  assert.equal(normDir('C:/Projects/X/'), 'c:\\projects\\x');
});

test('looksLikeDir: absolute drive or UNC paths only, single line', () => {
  for (const s of ['C:\\Projects\\app', 'd:/work', '\\\\server\\share']) assert.equal(looksLikeDir(s), true, s);
  for (const s of ['Projects', 'сделай тесты', '/compact', 'C:\\a\nb', '.\\x', 'C:']) assert.equal(looksLikeDir(s), false, s);
});
