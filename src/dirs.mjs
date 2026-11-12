// Recent project folders, from Claude Code's history in ~/.claude/projects/<encoded>/<session>.jsonl.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HEAD_BYTES = 64 * 1024;
const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;

export const normDir = (p) => String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

export function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Only absolute local or UNC paths count as a folder answer (anything else is a normal message).
export const looksLikeDir = (s) => /^([A-Za-z]:[\\/]|\\\\[^\\])/.test(s) && !/[\r\n]/.test(s);

// Default projects folder; CC_TG_PROJECTS_DIR in .env overrides it (config.projectsDir).
export const PROJECTS_ROOT = path.join(os.homedir(), 'Projects');
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

// A missing folder may be created only as a direct child of `root` with a valid Windows name.
// -> normalized absolute path, or null.
export function newProjectDir(dir, root = PROJECTS_ROOT) {
  const p = path.win32.normalize(String(dir ?? '').replace(/\//g, '\\')).replace(/\\+$/, '');
  if (normDir(path.win32.dirname(p)) !== normDir(root)) return null;
  const name = path.win32.basename(p);
  if (!name || name === '.' || name === '..' || /[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || RESERVED.test(name)) return null;
  return path.win32.join(root, name);
}

async function cwdOf(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const m = CWD_RE.exec(buf.subarray(0, bytesRead).toString('utf8'));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; } finally {
    await fh?.close().catch(() => {});
  }
}

async function newestJsonl(dir) {
  let best = null;
  try {
    for (const f of await fsp.readdir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      const { mtimeMs } = await fsp.stat(full);
      if (!best || mtimeMs > best.mtime) best = { full, mtime: mtimeMs };
    }
  } catch { /* unreadable dir */ }
  return best;
}

// -> Promise<[{ path, label }]> newest first, deduplicated (case-insensitive), existing folders only.
export async function recentDirs({ projectsDir, limit = 8, exists = isDir } = {}) {
  let entries;
  try { entries = await fsp.readdir(projectsDir, { withFileTypes: true }); } catch { return []; }
  const latest = (await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => newestJsonl(path.join(projectsDir, e.name)))))
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  const out = [];
  const seen = new Set();
  for (const { full } of latest) {
    if (out.length >= limit) break;
    const cwd = await cwdOf(full);
    if (!cwd || seen.has(normDir(cwd)) || !exists(cwd)) continue;
    seen.add(normDir(cwd));
    out.push({ path: cwd });
  }
  // Label = folder name; parent\name when two folders share a name.
  const names = out.map((d) => path.win32.basename(d.path) || d.path);
  return out.map((d, i) => ({
    path: d.path,
    label: names.filter((n) => n === names[i]).length > 1
      ? path.win32.basename(path.win32.dirname(d.path)) + '\\' + names[i]
      : names[i],
  }));
}
