import { execFile } from 'node:child_process';
import path from 'node:path';

// StartedAt: creation time as Unix ms (same representation as `inject.exe --ancestor`), null if unknown.
const PS_CMD = 'Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,'
  + '@{n="StartedAt";e={if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }}}'
  + ' | ConvertTo-Json -Compress';
export const START_TOLERANCE_MS = 2000;

export function listProcs() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', PS_CMD],
      { windowsHide: true, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        const map = new Map();
        if (err) return resolve(map);
        try {
          let arr = JSON.parse(String(stdout));
          if (!Array.isArray(arr)) arr = [arr];
          for (const p of arr) {
            if (p && Number.isInteger(p.ProcessId)) map.set(p.ProcessId, {
              name: String(p.Name ?? ''), ppid: p.ParentProcessId,
              startedAt: Number.isFinite(p.StartedAt) ? p.StartedAt : null,
            });
          }
        } catch { /* unknown */ }
        resolve(map);
      });
  });
}

export async function findAncestor(pid, name = 'claude.exe', { listProcs: lp = listProcs } = {}) {
  const procs = await lp();
  const want = name.toLowerCase();
  const seen = new Set();
  let cur = pid;
  for (let i = 0; i <= 10 && cur != null; i++) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const p = procs.get(cur);
    if (!p) return null;
    if (p.name.toLowerCase() === want) return cur;
    cur = p.ppid;
  }
  return null;
}

// startedAt (Unix ms, optional): guards against a reused pid — when both it and the process's
// creation time are known they must match within ±2 s.
export async function isClaudeAlive(pid, { listProcs: lp = listProcs, startedAt } = {}) {
  const p = (await lp()).get(pid);
  if (!p || p.name.toLowerCase() !== 'claude.exe') return false;
  if (Number.isFinite(startedAt) && Number.isFinite(p.startedAt)) return Math.abs(p.startedAt - startedAt) <= START_TOLERANCE_MS;
  return true;
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim());
    });
  });
}

export async function gitBranch(cwd) {
  const b = await git(cwd, ['branch', '--show-current']);
  if (b) return b;
  const sha = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  return sha || '—';
}

export function projectName(cwd) {
  return path.win32.basename(String(cwd).replace(/[\/]+$/, ''));
}
