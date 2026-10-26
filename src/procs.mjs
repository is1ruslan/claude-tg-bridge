import { execFile } from 'node:child_process';
import path from 'node:path';

const PS_CMD = 'Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';

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
            if (p && Number.isInteger(p.ProcessId)) map.set(p.ProcessId, { name: String(p.Name ?? ''), ppid: p.ParentProcessId });
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

export async function isClaudeAlive(pid, { listProcs: lp = listProcs } = {}) {
  const p = (await lp()).get(pid);
  return !!p && p.name.toLowerCase() === 'claude.exe';
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
