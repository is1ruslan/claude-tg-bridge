// Registry of VS Code windows (our extension long-polls the daemon) and job dispatch to them.
import { randomBytes } from 'node:crypto';
import { normDir } from './dirs.mjs';

const WINDOW_TTL_MS = 35_000; // poll timeout (25 s) + slack

const within = (cwd, folder) => cwd === folder || cwd.startsWith(folder + '\\');

export function createVscodeBridge({ now = Date.now, windowTtlMs = WINDOW_TTL_MS } = {}) {
  const windows = new Map(); // id -> { id, folders, focusedAt, lastSeenAt, waiter, pending: [] }
  const jobs = new Map(); // jobId -> { job, resolve, timer, windowId }

  function touch(win) {
    const w = windows.get(win.id) ?? { id: win.id, folders: [], focusedAt: 0, lastSeenAt: 0, waiter: null, pending: [] };
    if (Array.isArray(win.folders)) w.folders = win.folders.map(normDir).filter(Boolean);
    if (Number.isFinite(win.focusedAt)) w.focusedAt = Math.max(w.focusedAt, win.focusedAt);
    w.lastSeenAt = now();
    windows.set(w.id, w);
    return w;
  }

  const alive = (w) => w.waiter || now() - w.lastSeenAt <= windowTtlMs;

  // Longest folder containing cwd wins; otherwise (and on ties) the most recently focused window.
  function pick(cwd) {
    const c = normDir(cwd);
    let best = null;
    let bestLen = -1;
    for (const w of windows.values()) {
      if (!alive(w)) continue;
      const len = Math.max(-1, ...w.folders.filter((f) => within(c, f)).map((f) => f.length));
      if (!best || len > bestLen || (len === bestLen && w.focusedAt > best.focusedAt)) { best = w; bestLen = len; }
    }
    return best;
  }

  function finish(jobId, result) {
    const j = jobs.get(jobId);
    if (!j) return false;
    jobs.delete(jobId);
    clearTimeout(j.timer);
    const w = windows.get(j.windowId);
    if (w) w.pending = w.pending.filter((p) => p.id !== jobId);
    j.resolve(result);
    return true;
  }

  // Hand a registered job to the best live window (or fail it).
  function deliver(jobId) {
    const j = jobs.get(jobId);
    if (!j) return;
    const w = pick(j.job.cwd);
    if (!w) { finish(jobId, { ok: false, error: 'no-window' }); return; }
    j.windowId = w.id;
    if (w.waiter) w.waiter.done(j.job);
    else w.pending.push(j.job);
  }

  // A window that is gone: forget it and move its undelivered jobs elsewhere.
  function cancel(id) {
    const w = windows.get(id);
    if (!w) return;
    windows.delete(id);
    w.waiter?.done(null);
    for (const job of w.pending) deliver(job.id);
  }

  return {
    // -> Promise<job | null> (null after timeoutMs, on cancel, or when a newer poll of the same window arrives)
    poll(win, { timeoutMs = 25_000 } = {}) {
      if (!win || typeof win.id !== 'string' || !win.id) return Promise.resolve(null);
      const w = touch(win);
      if (w.waiter) w.waiter.done(null);
      if (w.pending.length) return Promise.resolve(w.pending.shift());
      return new Promise((resolve) => {
        const waiter = {
          done(v) {
            clearTimeout(waiter.timer);
            if (w.waiter === waiter) w.waiter = null;
            w.lastSeenAt = now();
            resolve(v);
          },
        };
        waiter.timer = setTimeout(() => waiter.done(null), timeoutMs);
        w.waiter = waiter;
      });
    },

    focus(id, focusedAt) {
      const w = windows.get(id);
      if (w && Number.isFinite(focusedAt)) w.focusedAt = Math.max(w.focusedAt, focusedAt);
    },

    cancel,

    // A job handed to a poll whose connection was already closed: drop that window, try another one.
    redeliver(job, windowId) {
      windows.delete(windowId);
      deliver(job.id);
    },

    // job: { cwd, ... } -> Promise<{ ok, error? }>
    dispatch(job, { timeoutMs = 10_000 } = {}) {
      const full = { ...job, id: randomBytes(8).toString('hex') };
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(full.id, { ok: false, error: 'timeout' }), timeoutMs);
        jobs.set(full.id, { job: full, resolve, timer, windowId: null });
        deliver(full.id);
      });
    },

    ack(jobId, result) {
      return finish(jobId, { ok: !!result?.ok, ...(result?.error ? { error: String(result.error) } : {}) });
    },

    windowCount: () => [...windows.values()].filter(alive).length,

    close() {
      for (const w of windows.values()) w.waiter?.done(null);
      for (const id of [...jobs.keys()]) finish(id, { ok: false, error: 'closed' });
    },
  };
}
