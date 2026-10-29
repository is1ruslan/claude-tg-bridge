// Runs inside a VS Code terminal opened by the extension: `node newsession.mjs <promptFile>`.
// Starts claude with the prompt from Telegram, then leaves an interactive PowerShell in the tab.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveClaude } from './summary.mjs';

// A prompt starting with "-" would be parsed as a CLI flag; a leading space keeps it a prompt.
export const promptArg = (text) => (/^\s*-/.test(text) ? ' ' + text : text);

// -> { cmd, args } or { error }. Never through a shell: the prompt is untrusted text from Telegram
// and cmd.exe would interpret & | > % and cut it at the first newline.
export function claudeLaunch(prompt, claude = resolveClaude()) {
  if (claude.shell) return { error: `найден только ${claude.cmd} (без claude.exe) — запуск через cmd небезопасен` };
  return { cmd: claude.cmd, args: prompt.trim() ? [promptArg(prompt)] : [] };
}

function main(promptFile) {
  let prompt = '';
  try {
    prompt = fs.readFileSync(promptFile, 'utf8');
    fs.rmSync(promptFile, { force: true });
  } catch (e) {
    process.stderr.write(`cc-telegram: не удалось прочитать промпт (${e.message})\n`);
  }
  // Ctrl+C belongs to claude; this wrapper must survive it or VS Code would close the tab.
  process.on('SIGINT', () => {});
  const env = { ...process.env };
  delete env.CC_TELEGRAM_DISABLE;
  const launch = claudeLaunch(prompt);
  if (launch.error) {
    process.stderr.write(`cc-telegram: ${launch.error}\nПромпт:\n${prompt}\n`);
  } else {
    const r = spawnSync(launch.cmd, launch.args, { stdio: 'inherit', env });
    if (r.error) process.stderr.write(`cc-telegram: claude не запустился (${r.error.message})\n`);
  }
  spawnSync('powershell.exe', ['-NoLogo'], { stdio: 'inherit', env });
}

if (process.argv[1] && /newsession\.mjs$/i.test(process.argv[1])) main(process.argv[2]);
