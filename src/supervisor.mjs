// Keeps the daemon running: restart on crash with backoff, stop when another instance owns the port.
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths as getPaths } from './config.mjs';
import { createLogger } from './log.mjs';

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon.mjs');
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 60_000;
const STABLE_UPTIME_MS = 5 * 60_000;
const PORT_IN_USE_LIMIT = 3;
export const EXIT_PORT_IN_USE = 1;
export const EXIT_CONFIG = 3;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOnce(spawn, daemonPath, log) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [daemonPath], { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      log.error('supervisor: spawn failed', { error: String(e?.message ?? e) });
      return resolve(-1);
    }
    let done = false;
    const finish = (code) => { if (!done) { done = true; resolve(code); } };
    child.on('error', (e) => { log.error('supervisor: daemon error', { error: String(e?.message ?? e) }); finish(-1); });
    child.on('exit', (code, signal) => finish(code ?? (signal ? -1 : 0)));
  });
}

export async function runSupervisor({
  spawn = nodeSpawn, sleep = defaultSleep, log, daemonPath = DAEMON, now = Date.now,
} = {}) {
  let backoff = BACKOFF_MIN_MS;
  let portInUse = 0;
  for (;;) {
    const started = now();
    const code = await runOnce(spawn, daemonPath, log);
    const uptime = now() - started;
    if (code === 0) { log.info('supervisor: daemon exited normally'); return 0; }
    if (code === EXIT_CONFIG) { log.error('supervisor: daemon reported missing config (exit 3), not restarting'); return 0; }
    if (code === EXIT_PORT_IN_USE) {
      portInUse++;
      if (portInUse >= PORT_IN_USE_LIMIT) {
        log.warn('supervisor: port in use 3 times in a row, another instance is running — exiting');
        return 0;
      }
    } else portInUse = 0;
    if (uptime >= STABLE_UPTIME_MS) backoff = BACKOFF_MIN_MS;
    log.warn(`supervisor: daemon exited with code ${code}, restarting in ${backoff} ms`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const log = createLogger({ dir: getPaths().logsDir });
  runSupervisor({ log }).then((code) => process.exit(code), (e) => {
    log.error('supervisor: fatal', { error: String(e?.stack ?? e) });
    process.exit(1);
  });
}
