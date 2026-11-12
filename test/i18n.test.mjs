import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STRINGS, t, setLang, getLang, normLang } from '../src/i18n.mjs';
import { loadConfig } from '../src/config.mjs';
import * as F from '../src/format.mjs';
import { planOptions, permissionOptions } from '../src/keys.mjs';
import { Store } from '../src/sessions.mjs';
import { handleUpdate } from '../src/router.mjs';

test('en and ru define the same keys with the same kinds', () => {
  const en = STRINGS.en;
  const ru = STRINGS.ru;
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  for (const k of Object.keys(en)) {
    assert.equal(typeof ru[k], typeof en[k], k);
    if (typeof en[k] === 'function') assert.equal(ru[k].length, en[k].length, k);
  }
});

test('normLang: en/ru (any case), everything else -> en', () => {
  assert.equal(normLang('RU'), 'ru');
  assert.equal(normLang(' en '), 'en');
  for (const bad of ['', undefined, 'de', 'russian']) assert.equal(normLang(bad), 'en');
});

test('setLang switches the bot texts; default is English', () => {
  assert.equal(getLang(), 'en');
  assert.equal(F.completionText('app · main', 'waiting', 'x'), '📁 <b>app · main</b>\n\nStatus: ⏸ waiting for you\n\nx');
  assert.deepEqual(planOptions(), ['✅ Yes, auto mode', '✅ Yes, manual edits', '✏️ Change the plan']);
  assert.deepEqual(permissionOptions([]), ['✅ Yes', '⛔ No']);
  assert.equal(F.routePickKeyboard([], '7').at(-1)[0].text, '➕ New session');
  assert.match(t('summaryPrompt'), /in English/);
  setLang('ru');
  try {
    assert.match(F.completionText('a', 'done', 'x'), /Статус: ✅ завершено/);
    assert.equal(F.routePickKeyboard([], '7').at(-1)[0].text, '➕ Новая сессия');
    assert.match(t('summaryPrompt'), /по-русски/);
  } finally { setLang('en'); }
});

test('router: plain text with no sessions -> English picker; «Other folder» prompt names the configured root', () => {
  const store = new Store();
  const msg = (text, id) => ({ message: { message_id: id, text, from: { id: 1 }, chat: { id: 1, type: 'private' } } });
  const [pick] = handleUpdate(store, msg('hi', 10), { userId: 1, now: 0 });
  assert.equal(pick.text, 'No active sessions — start a new one?');
  const cb = (data) => ({ callback_query: { id: 'c', data, from: { id: 1 }, message: { message_id: 11, chat: { type: 'private' } } } });
  handleUpdate(store, cb('n|10'), { userId: 1, now: 0, recentDirs: [] });
  const out = handleUpdate(store, cb('f|10|o'), { userId: 1, now: 0, projectsRoot: 'D:\\Code' });
  assert.match(out.find((e) => e.type === 'send').text, /^📂 Send the full path to the folder \(e\.g\. D:\\Code\\app\)/);
});

test('loadConfig: CC_TG_LANG and CC_TG_PROJECTS_DIR (default ~/Projects)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-i18n-'));
  fs.mkdirSync(path.join(home, '.claude', 'telegram'), { recursive: true });
  const env = path.join(home, '.claude', 'telegram', '.env');
  fs.writeFileSync(env, 'TELEGRAM_USER_ID=1\n');
  let c = loadConfig(home, {});
  assert.equal(c.lang, 'en');
  assert.equal(c.projectsDir, path.join(home, 'Projects'));
  fs.writeFileSync(env, 'CC_TG_LANG=ru\nCC_TG_PROJECTS_DIR=D:\\Code\n');
  c = loadConfig(home, {});
  assert.equal(c.lang, 'ru');
  assert.equal(c.projectsDir, 'D:\\Code');
  fs.rmSync(home, { recursive: true, force: true });
});
