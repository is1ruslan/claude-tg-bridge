import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegram, TelegramError } from '../src/telegram.mjs';

const TOKEN = '123456:SECRETTOKENabc';

function stub(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), init });
    const r = responses.length > 1 ? responses.shift() : responses[0];
    return { json: async () => r };
  };
  return { calls, fetch };
}

test('sendMessage posts JSON with keyboard and returns message_id', async () => {
  const { calls, fetch } = stub([{ ok: true, result: { message_id: 77 } }]);
  const tg = createTelegram({ token: TOKEN, fetch });
  const id = await tg.sendMessage({ chatId: 1, text: 'x', keyboard: [[{ text: '1', callback_data: 'a|abc|0|0' }]] });
  assert.equal(id, 77);
  assert.ok(calls[0].url.endsWith('/sendMessage'));
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].text, '1');
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.equal(calls[0].body.disable_web_page_preview, true);
});

test('long text split by lines, keyboard only on last', async () => {
  const { calls, fetch } = stub([{ ok: true, result: { message_id: 5 } }]);
  const tg = createTelegram({ token: TOKEN, fetch });
  const text = Array.from({ length: 90 }, () => 'a'.repeat(99)).join('\n');
  assert.equal(text.length, 9000 - 1);
  const kb = [[{ text: 'k', callback_data: 'z' }]];
  await tg.sendMessage({ chatId: 1, text, keyboard: kb });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.reply_markup, undefined);
  assert.equal(calls[1].body.reply_markup, undefined);
  assert.ok(calls[2].body.reply_markup);
  for (const c of calls) assert.ok(c.body.text.length <= 4096);
  assert.equal(calls.map((c) => c.body.text).join('\n'), text);
});

test('single overlong line is hard-split', async () => {
  const { calls, fetch } = stub([{ ok: true, result: { message_id: 5 } }]);
  const tg = createTelegram({ token: TOKEN, fetch });
  await tg.sendMessage({ chatId: 1, text: 'b'.repeat(5000) });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.text.length, 4096);
});

test('ok:false throws TelegramError without token', async () => {
  const { fetch } = stub([{ ok: false, error_code: 400, description: 'Bad' }]);
  const tg = createTelegram({ token: TOKEN, fetch });
  await assert.rejects(tg.getMe(), (err) => {
    assert.ok(err instanceof TelegramError);
    assert.ok(!String(err).includes('SECRETTOKEN'));
    assert.match(err.message, /^getMe failed: 400 Bad$/);
    return true;
  });
});

test('edit swallows "message is not modified"', async () => {
  const { fetch } = stub([{ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }]);
  const tg = createTelegram({ token: TOKEN, fetch });
  await tg.editMessage({ chatId: 1, messageId: 2, text: 'x', keyboard: null });
});

test('edit keyboard null -> empty inline_keyboard; forceReply; getUpdates', async () => {
  const { calls, fetch } = stub([{ ok: true, result: [] }]);
  const tg = createTelegram({ token: TOKEN, fetch });
  await tg.editMessage({ chatId: 1, messageId: 2, text: 'x', keyboard: null });
  assert.deepEqual(calls[0].body.reply_markup, { inline_keyboard: [] });
  await tg.sendMessage({ chatId: 1, text: 'q', forceReply: true, replyTo: 9 });
  assert.deepEqual(calls[1].body.reply_markup, { force_reply: true });
  assert.equal(calls[1].body.reply_to_message_id, 9);
  const u = await tg.getUpdates(10);
  assert.deepEqual(u, []);
  assert.deepEqual(calls[2].body.allowed_updates, ['message', 'callback_query']);
  assert.equal(calls[2].body.offset, 10);
  assert.equal(calls[2].body.timeout, 50);
  await tg.answerCallback('cb1', 'hi');
  assert.equal(calls[3].body.callback_query_id, 'cb1');
});

test('network error message has token masked', async () => {
  const fetch = async (url) => { throw new Error(`failed ${url}`); };
  const tg = createTelegram({ token: TOKEN, fetch });
  await assert.rejects(tg.getMe(), (err) => !String(err.message).includes('SECRETTOKEN'));
});
