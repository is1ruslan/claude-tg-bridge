// cc-telegram bridge: long-polls the local cc-telegram daemon (127.0.0.1, secret from daemon.json)
// and opens a terminal running `node newsession.mjs <promptFile>` for each "new session" job.
// No ports are opened and nothing leaves the machine.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DAEMON_JSON = path.join(os.homedir(), '.claude', 'telegram', 'state', 'daemon.json');
const RETRY_MS = 5000;
const POLL_TIMEOUT_MS = 35000; // daemon answers within 25 s

const windowId = crypto.randomBytes(8).toString('hex');
let stopped = false;
let focusedAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function daemon() {
  try {
    const j = JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf8'));
    return j && j.port && j.secret ? j : null;
  } catch { return null; }
}

function post(d, url, body, ms) {
  return fetch(`http://127.0.0.1:${d.port}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cc-secret': d.secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
}

const folders = () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);

function openTerminal(job) {
  if (!fs.existsSync(job.cwd)) throw new Error('папка не найдена: ' + job.cwd);
  const t = vscode.window.createTerminal({
    name: job.title,
    cwd: job.cwd,
    shellPath: job.node,
    shellArgs: [job.script, job.promptFile],
    iconPath: new vscode.ThemeIcon('hubot'),
  });
  t.show(true);
}

async function loop() {
  while (!stopped) {
    const d = daemon();
    if (!d) { await sleep(RETRY_MS); continue; }
    try {
      const r = await post(d, '/vscode/poll', { id: windowId, folders: folders(), focusedAt }, POLL_TIMEOUT_MS);
      if (r.status === 200) {
        const job = await r.json();
        let ok = true;
        let error;
        try { openTerminal(job); } catch (e) { ok = false; error = String((e && e.message) || e); }
        await post(d, '/vscode/ack', { jobId: job.id, ok, error }, 5000).catch(() => {});
      } else if (r.status !== 204) {
        await sleep(RETRY_MS);
      }
    } catch {
      await sleep(RETRY_MS);
    }
  }
}

function activate(context) {
  if (vscode.window.state.focused) focusedAt = Date.now();
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => {
    if (!s.focused) return;
    focusedAt = Date.now();
    const d = daemon();
    if (d) post(d, '/vscode/focus', { id: windowId, focusedAt }, 3000).catch(() => {});
  }));
  loop();
}

function deactivate() { stopped = true; }

module.exports = { activate, deactivate };
