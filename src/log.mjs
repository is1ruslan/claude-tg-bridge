import fs from 'node:fs';
import path from 'node:path';
import { maskSecrets } from './config.mjs';

export function createLogger({ dir, secrets = [], maxBytes = 1_000_000, keep = 3 }) {
  const file = path.join(dir, 'daemon.log');

  function rotate() {
    try {
      fs.rmSync(`${file}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
      fs.renameSync(file, `${file}.1`);
    } catch { /* best effort */ }
  }

  function write(level, msg, obj) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      let line;
      try { line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(obj === undefined ? {} : { data: obj }) }); }
      catch { line = JSON.stringify({ ts: new Date().toISOString(), level, msg }); }
      line = maskSecrets(line, secrets) + '\n';
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* new file */ }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate();
      fs.appendFileSync(file, line);
    } catch { /* logging must never throw */ }
  }

  return {
    info: (m, o) => write('info', m, o),
    warn: (m, o) => write('warn', m, o),
    error: (m, o) => write('error', m, o),
  };
}
