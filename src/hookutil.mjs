// Helpers for the hook client (src/hook.mjs): claude.exe ancestor lookup, payload truncation, log cap.
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INJECT_EXE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'inject.exe');
export const ANCESTOR_TIMEOUT_MS = 800;
export const MAX_STRING = 4000;
export const LOG_CAP_BYTES = 256 * 1024;

const ANCESTOR_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PermissionRequest']);
const DIALOG_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Events after which the daemon may need to type into the session: resolve claude.exe synchronously
// (while the hook's parent chain is still alive) instead of letting the daemon race for it.
export function needsAncestor(event, payload) {
  if (ANCESTOR_EVENTS.has(event)) return true;
  return event === 'PreToolUse' && DIALOG_TOOLS.has(payload?.tool_name);
}

// -> { claudePid, claudeStartedAt? } | null. Never throws.
export function claudeAncestor(ppid, { exe = INJECT_EXE, name = 'claude.exe', spawnSync = nodeSpawnSync, timeoutMs = ANCESTOR_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(ppid) || ppid <= 0) return null;
  try {
    const r = spawnSync(exe, ['--ancestor', String(ppid), name], {
      windowsHide: true, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!r || r.error || r.status !== 0) return null;
    const m = /^ok (\d+) (\d+)\s*$/.exec(String(r.stdout ?? ''));
    if (!m) return null;
    const out = { claudePid: Number(m[1]) };
    const started = Number(m[2]);
    if (started > 0) out.claudeStartedAt = started;
    return out.claudePid > 0 ? out : null;
  } catch { return null; }
}

function cut(s, max) {
  let head = s.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1); // never split a surrogate pair
  return head + '…';
}

// Copy of `value` with every string longer than `max` cut to `max` + '…'.
export function truncateDeep(value, max = MAX_STRING) {
  if (typeof value === 'string') return value.length > max ? cut(value, max) : value;
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, max));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, max);
    return out;
  }
  return value;
}

// Keeps logs/hook-errors.log bounded: truncated to empty once it exceeds `max` bytes.
export function capLogFile(file, max = LOG_CAP_BYTES) {
  try {
    if (fs.statSync(file).size > max) fs.writeFileSync(file, '');
  } catch { /* missing file is fine */ }
}
