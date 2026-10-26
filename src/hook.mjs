// Claude Code hook client: forwards the hook payload to the local daemon.
// Always exits 0, never writes to stdout, total budget < 2 s.
import fs from 'node:fs';
import path from 'node:path';
import { paths as getPaths, isDisabled, maskSecrets } from './config.mjs';
import { needsAncestor, claudeAncestor, truncateDeep, capLogFile } from './hookutil.mjs';

const T0 = Date.now();
const BUDGET_MS = 1900;
const STDIN_MAX = 16 * 1024 * 1024;
const STDIN_TIMEOUT_MS = 1000;
const POST_TIMEOUT_MS = 1500;

const event = String(process.argv[2] ?? '');
let secret = '';

// Hard stop: whatever happens, never exceed the budget.
setTimeout(() => process.exit(0), BUDGET_MS);

function logError(msg) {
  try {
    const p = getPaths();
    fs.mkdirSync(p.logsDir, { recursive: true });
    const line = `${new Date().toISOString()} ${event.replace(/\s/g, '_') || '-'} ${maskSecrets(String(msg), [secret]).replace(/\s+/g, ' ').slice(0, 300)}\n`;
    const file = path.join(p.logsDir, 'hook-errors.log');
    capLogFile(file);
    fs.appendFileSync(file, line);
  } catch { /* nothing else we can do */ }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('stdin timeout')), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (d) => {
      size += d.length;
      if (size > STDIN_MAX) { finish(reject, new Error('stdin too large')); process.stdin.destroy(); return; }
      chunks.push(d);
    });
    process.stdin.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', (e) => finish(reject, e));
  });
}

async function main() {
  if (isDisabled()) return;
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('stdin is not valid JSON'); }
  let info;
  try { info = JSON.parse(fs.readFileSync(getPaths().daemonJson, 'utf8')); } catch (e) {
    throw new Error(`daemon.json unavailable: ${e?.code ?? e?.message ?? e}`);
  }
  secret = String(info?.secret ?? '');
  const port = Number(info?.port);
  if (!Number.isInteger(port) || port <= 0 || !secret) throw new Error('daemon.json invalid');
  const body = { event, payload: truncateDeep(payload), ppid: process.ppid };
  // Resolve claude.exe now, while our parent chain is alive (spawnSync, <= 800 ms; failure -> omitted).
  if (needsAncestor(event, payload)) Object.assign(body, claudeAncestor(process.ppid) ?? {});
  const left = Math.max(100, Math.min(POST_TIMEOUT_MS, BUDGET_MS - 100 - (Date.now() - T0)));
  const res = await fetch(`http://127.0.0.1:${port}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cc-secret': secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(left),
  });
  if (res.status !== 204) throw new Error(`daemon replied ${res.status}`);
}

main()
  .catch((e) => logError(e?.cause?.code ?? e?.message ?? e))
  .finally(() => process.exit(0));
