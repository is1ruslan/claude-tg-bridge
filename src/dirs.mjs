// Recent project folders, from Claude Code's history in ~/.claude/projects/<encoded>/<session>.jsonl.
import fs from 'node:fs';
import path from 'node:path';

const HEAD_BYTES = 64 * 1024;
const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;

export const normDir = (p) => String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

export function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function cwdOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const m = CWD_RE.exec(buf.subarray(0, n).toString('utf8'));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// -> [{ path, label }] newest first, deduplicated (case-insensitive), existing folders only.
export function recentDirs({ projectsDir, limit = 8, exists = isDir } = {}) {
  let entries;
  try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }
  const latest = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(projectsDir, e.name);
    let best = null;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        const mtime = fs.statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { full, mtime };
      }
    } catch { continue; }
    if (best) latest.push(best);
  }
  latest.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  const seen = new Set();
  for (const { full } of latest) {
    if (out.length >= limit) break;
    const cwd = cwdOf(full);
    if (!cwd || seen.has(normDir(cwd)) || !exists(cwd)) continue;
    seen.add(normDir(cwd));
    out.push({ path: cwd });
  }
  // Label = folder name; parent/name when two folders share a name.
  const names = out.map((d) => path.win32.basename(d.path) || d.path);
  return out.map((d, i) => ({
    path: d.path,
    label: names.filter((n) => n === names[i]).length > 1
      ? path.win32.basename(path.win32.dirname(d.path)) + '\\' + names[i]
      : names[i],
  }));
}
