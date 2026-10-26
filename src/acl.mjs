import { execFile as nodeExecFile } from 'node:child_process';
import os from 'node:os';

// Restrict a file to the current user only (no inherited ACEs). Errors are logged, never thrown.
export function restrictToUser(file, { log, execFile = nodeExecFile, user = process.env.USERNAME || os.userInfo().username } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true, timeout: 10_000 }, (err) => {
        if (err) log?.error('icacls failed', { file, error: String(err?.message ?? err) });
        resolve();
      });
    } catch (e) {
      log?.error('icacls failed', { file, error: String(e?.message ?? e) });
      resolve();
    }
  });
}
