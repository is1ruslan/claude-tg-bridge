import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function paths(home = os.homedir()) {
  const root = path.join(home, '.claude', 'telegram');
  const stateDir = path.join(root, 'state');
  return {
    root,
    env: path.join(root, '.env'),
    stateDir,
    logsDir: path.join(root, 'logs'),
    disabledFlag: path.join(root, 'disabled'),
    daemonJson: path.join(stateDir, 'daemon.json'),
    snapshot: path.join(stateDir, 'snapshot.json'),
  };
}

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val.at(-1) === val[0]) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadConfig(home, procEnv = process.env) {
  let file = {};
  try { file = parseEnv(fs.readFileSync(paths(home).env, 'utf8')); } catch { /* no file */ }
  const pick = (k) => (procEnv[k] !== undefined && procEnv[k] !== '' ? procEnv[k] : file[k] ?? '');
  const uid = Number(pick('TELEGRAM_USER_ID'));
  const port = Number(pick('CC_TG_PORT'));
  return {
    token: pick('TELEGRAM_BOT_TOKEN'),
    userId: pick('TELEGRAM_USER_ID') !== '' && Number.isInteger(uid) ? uid : null,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 47833,
  };
}

export function isDisabled(env = process.env, home) {
  if (env.CC_TELEGRAM_DISABLE === '1') return true;
  try { return fs.existsSync(paths(home).disabledFlag); } catch { return false; }
}

export function maskSecrets(s, secrets = []) {
  let out = String(s);
  for (const sec of secrets) {
    if (typeof sec === 'string' && sec.length >= 6) out = out.split(sec).join('***');
  }
  return out.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***');
}
