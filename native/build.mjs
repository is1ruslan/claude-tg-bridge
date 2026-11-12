import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function findCsc() {
  const win = process.env.WINDIR || 'C:\\Windows';
  const p = path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  return fs.existsSync(p) ? p : null;
}

export function build(out = path.join(here, 'inject.exe')) {
  const csc = findCsc();
  if (!csc) throw new Error('csc.exe not found (.NET Framework 4 x64 required): %WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(csc, ['/nologo', '/target:exe', `/out:${out}`, '/optimize', '/r:System.Web.Extensions.dll', path.join(here, 'inject.cs')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`csc failed (${r.status}): ${r.stdout}${r.stderr}`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log('built', build()); } catch (e) { console.error(e.message); process.exit(1); }
}
