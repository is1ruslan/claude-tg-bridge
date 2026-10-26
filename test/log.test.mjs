import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/log.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cctl-'));

test('masks secrets', () => {
  const dir = tmp();
  const log = createLogger({ dir, secrets: ['123456:ABCdef_ghijk'] });
  log.info('t', { token: '123456:ABCdef_ghijk' });
  const txt = fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8');
  assert.ok(!txt.includes('ABCdef'));
  const rec = JSON.parse(txt.trim());
  assert.equal(rec.level, 'info');
  assert.equal(rec.msg, 't');
});

test('rotates', () => {
  const dir = tmp();
  const log = createLogger({ dir, secrets: [], maxBytes: 200, keep: 3 });
  for (let i = 0; i < 20; i++) log.warn('message number ' + i, { i });
  assert.ok(fs.existsSync(path.join(dir, 'daemon.log.1')));
  assert.ok(!fs.existsSync(path.join(dir, 'daemon.log.4')));
});
