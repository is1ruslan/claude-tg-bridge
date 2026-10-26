import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, parseEnv, loadConfig, isDisabled, maskSecrets } from '../src/config.mjs';

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-')); }
function writeEnv(home, text) {
  const p = paths(home);
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.env, text);
}

test('paths', () => {
  const p = paths('H');
  assert.equal(p.root, path.join('H', '.claude', 'telegram'));
  assert.equal(p.env, path.join(p.root, '.env'));
  assert.equal(p.disabledFlag, path.join(p.root, 'disabled'));
});

test('parseEnv', () => {
  assert.deepEqual(parseEnv('A=1\n# c\nB="x y"\nC='), { A: '1', B: 'x y', C: '' });
});

test('loadConfig', () => {
  const h = tmpHome();
  writeEnv(h, 'TELEGRAM_BOT_TOKEN=abc\nTELEGRAM_USER_ID=42\n');
  const c = loadConfig(h, {});
  assert.equal(c.userId, 42);
  assert.equal(c.port, 47833);
  assert.equal(c.token, 'abc');
  writeEnv(h, 'TELEGRAM_USER_ID=\n');
  assert.equal(loadConfig(h, {}).userId, null);
  writeEnv(h, 'TELEGRAM_USER_ID=42\nCC_TG_PORT=5000\n');
  assert.equal(loadConfig(h, { TELEGRAM_USER_ID: '7', CC_TG_PORT: '6000' }).userId, 7);
  assert.equal(loadConfig(h, { CC_TG_PORT: '6000' }).port, 6000);
});

test('loadConfig without file', () => {
  assert.equal(loadConfig(tmpHome(), {}).token, '');
});

test('isDisabled', () => {
  const h = tmpHome();
  assert.equal(isDisabled({}, h), false);
  assert.equal(isDisabled({ CC_TELEGRAM_DISABLE: '1' }, h), true);
  writeEnv(h, '');
  fs.writeFileSync(paths(h).disabledFlag, '');
  assert.equal(isDisabled({}, h), true);
});

test('maskSecrets', () => {
  const s = maskSecrets('url https://api.telegram.org/bot123456:ABCdef_ghijk/getMe', ['123456:ABCdef_ghijk']);
  assert.ok(!s.includes('ABCdef'));
  const t = maskSecrets('https://api.telegram.org/bot999:XYZxyz-1/getMe', []);
  assert.ok(!t.includes('XYZxyz'));
  assert.equal(maskSecrets('abc short', ['abc']), 'abc short');
});
