import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_EXE = path.join(root, 'native', 'inject.exe');
const queues = new Map(); // pid -> tail promise

function run(pid, steps, exe, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ ok: false, error: `spawn: ${e.message}` }); }
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => finish({ ok: false, error: `spawn: ${e.message}` }));
    child.on('close', (code) => {
      out = out.trim();
      finish(code === 0 ? { ok: true } : { ok: false, error: out || `exit ${code}` });
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, error: 'timeout' }); }, timeoutMs);
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ pid, steps, gapMs: 150 }));
  });
}

export function injectSteps(pid, steps, { exe = DEFAULT_EXE, timeoutMs = 15000 } = {}) {
  const prev = queues.get(pid) || Promise.resolve();
  const p = prev.then(() => run(pid, steps, exe, timeoutMs));
  const tail = p.catch(() => {});
  queues.set(pid, tail);
  tail.then(() => { if (queues.get(pid) === tail) queues.delete(pid); });
  return p;
}
