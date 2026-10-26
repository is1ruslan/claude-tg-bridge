import { maskSecrets } from './config.mjs';

const MAX_LEN = 4096;

export class TelegramError extends Error {
  constructor(method, errorCode, description) {
    super(`${method} failed: ${errorCode} ${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.errorCode = errorCode;
    this.description = description;
  }
}

export function splitText(text, max = MAX_LEN) {
  if (text.length <= max) return [text];
  const parts = [];
  let cur = '';
  const flush = () => { if (cur !== '') parts.push(cur); cur = ''; };
  for (const line of text.split('\n')) {
    if (line.length > max) {
      flush();
      for (let i = 0; i < line.length; i += max) parts.push(line.slice(i, i + max));
      continue;
    }
    if (cur === '') cur = line;
    else if (cur.length + 1 + line.length <= max) cur += '\n' + line;
    else { flush(); cur = line; }
  }
  flush();
  return parts;
}

export function createTelegram({ token, fetch = globalThis.fetch, log } = {}) {
  const logger = log ?? { info() {}, warn() {}, error() {} };
  const mask = (s) => maskSecrets(s, [token]);

  async function call(method, params) {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    let data;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params ?? {}),
      });
      data = await res.json();
    } catch (e) {
      const err = new Error(mask(`${method} request failed: ${e?.message ?? e}`));
      err.name = 'TelegramNetworkError';
      throw err;
    }
    if (!data || data.ok !== true) {
      const err = new TelegramError(
        method,
        data?.error_code,
        mask(String(data?.description ?? 'unknown error')),
      );
      logger.warn(err.message);
      throw err;
    }
    return data.result;
  }

  const base = { parse_mode: 'HTML', disable_web_page_preview: true };

  return {
    getUpdates(offset, timeoutSec = 50) {
      return call('getUpdates', {
        offset,
        timeout: timeoutSec,
        allowed_updates: ['message', 'callback_query'],
      });
    },

    async sendMessage({ chatId, text, keyboard, replyTo, forceReply }) {
      const parts = splitText(String(text));
      let lastId;
      for (let i = 0; i < parts.length; i++) {
        const last = i === parts.length - 1;
        const params = { chat_id: chatId, text: parts[i], ...base };
        if (replyTo != null && i === 0) params.reply_to_message_id = replyTo;
        if (last) {
          if (keyboard) params.reply_markup = { inline_keyboard: keyboard };
          else if (forceReply) params.reply_markup = { force_reply: true };
        }
        const msg = await call('sendMessage', params);
        lastId = msg.message_id;
      }
      return lastId;
    },

    async editMessage({ chatId, messageId, text, keyboard }) {
      const params = { chat_id: chatId, message_id: messageId, text, ...base };
      if (keyboard === null) params.reply_markup = { inline_keyboard: [] };
      else if (keyboard) params.reply_markup = { inline_keyboard: keyboard };
      try {
        await call('editMessageText', params);
      } catch (e) {
        if (e instanceof TelegramError && /message is not modified/i.test(e.description)) return;
        throw e;
      }
    },

    async answerCallback(callbackId, text) {
      const params = { callback_query_id: callbackId };
      if (text) params.text = text;
      await call('answerCallbackQuery', params);
    },

    getMe() {
      return call('getMe', {});
    },
  };
}
