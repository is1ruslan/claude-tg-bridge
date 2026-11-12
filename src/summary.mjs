import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';

const MAX_INPUT = 12000;
const SHORT_LINES = 5;
const SHORT_CHARS = 500;

let cached;

/** Resolve the claude binary once. Returns { cmd, shell }. */
export function resolveClaude() {
  if (cached) return cached;
  let result = { cmd: 'claude', shell: false };
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true });
      const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'));
      if (exe) result = { cmd: exe, shell: false };
      else {
        const cmdFile = lines.find((l) => /\.(cmd|bat)$/i.test(l));
        if (cmdFile) {
          // npm shim: the real binary usually sits next to it in node_modules
          const real = path.join(path.dirname(cmdFile), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
          result = fs.existsSync(real) ? { cmd: real, shell: false } : { cmd: cmdFile, shell: true };
        }
      }
    } catch { /* keep default */ }
  }
  cached = result;
  return cached;
}

export function runClaude(prompt, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const { cmd, shell } = resolveClaude();
    const args = ['-p', '--model', 'haiku', '--no-session-persistence', '--setting-sources', '',
      '--strict-mcp-config', '--disable-slash-commands', '--tools', '',
      '--exclude-dynamic-system-prompt-sections', '--system-prompt', t('summaryPrompt')];
    const q = (a) => (shell ? `"${a.replace(/"/g, '""')}"` : a);
    let child;
    try {
      child = spawn(shell ? q(cmd) : cmd, shell ? args.map(q) : args, {
        env: { ...process.env, CC_TELEGRAM_DISABLE: '1' }, windowsHide: true, shell,
      });
    } catch (e) { reject(e); return; }
    let out = '', err = '', done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(reject, new Error('claude timeout')); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => (code === 0 ? finish(resolve, out) : finish(reject, new Error(`claude exit ${code}: ${err.slice(0, 200)}`))));
    child.stdin.on('error', () => { /* handled by close */ });
    child.stdin.end(prompt);
  });
}

export function fallbackSummary(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, SHORT_LINES);
  const joined = lines.join('\n');
  const cps = Array.from(joined);
  return cps.length > SHORT_CHARS ? cps.slice(0, SHORT_CHARS).join('') + '…' : joined;
}

function parseModel(text) {
  const m = String(text ?? '').match(/\{[\s\S]*?\}/);
  const candidates = [];
  if (m) candidates.push(m[0]);
  const wide = String(text ?? '').match(/\{[\s\S]*\}/);
  if (wide && wide[0] !== m?.[0]) candidates.push(wide[0]);
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      if (j && typeof j.summary === 'string' && j.summary.trim()) {
        const status = ['done', 'waiting', 'error'].includes(j.status) ? j.status : null;
        return { status, summary: j.summary.trim() };
      }
    } catch { /* try next */ }
  }
  return null;
}

// Long reports keep both ends: the conclusion usually sits at the tail.
function capInput(text) {
  const cps = Array.from(text);
  if (cps.length <= MAX_INPUT) return text;
  const half = MAX_INPUT / 2;
  return cps.slice(0, half).join('') + '\n…\n' + cps.slice(-half).join('');
}

export async function summarize(lastMessage, { failed = false, run = runClaude } = {}) {
  const text = String(lastMessage ?? '').trim();
  const nonEmpty = text.split(/\r?\n/).filter((l) => l.trim());
  if (nonEmpty.length <= SHORT_LINES && Array.from(text).length <= SHORT_CHARS) {
    const status = failed ? 'error' : nonEmpty.length && nonEmpty[nonEmpty.length - 1].trim().endsWith('?') ? 'waiting' : 'done';
    return { status, summary: text };
  }
  try {
    const out = await run(capInput(text));
    const p = parseModel(out);
    if (p) return { status: failed ? 'error' : (p.status ?? 'done'), summary: p.summary };
  } catch { /* fall through */ }
  return { status: failed ? 'error' : 'done', summary: fallbackSummary(text) };
}
