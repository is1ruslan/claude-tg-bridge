// Pure helpers for merging / removing our hooks in Claude Code settings.json.
export const HOOK_EVENTS = [
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PreToolUse', null], // F5: all tools — events.mjs closes stale plan/perm dialogs on any PreToolUse
  ['PermissionRequest', null],
  ['PostToolUse', null],
  ['Stop', null],
  ['StopFailure', null],
  ['SessionEnd', null],
];

const MARKER = 'cc-telegram/src/hook.mjs';
const toSlash = (s) => String(s).split(String.fromCharCode(92)).join('/');

export function hookCommand(repo, event) {
  return `node "${toSlash(repo)}/src/hook.mjs" ${event}`;
}

export function isOurs(entry) {
  return typeof entry?.command === 'string' && toSlash(entry.command).includes(MARKER);
}

// Remove only our entries; drop groups/events/hooks-key that become empty because of it.
export function removeHooks(settings) {
  const out = structuredClone(settings ?? {});
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) { kept.push(g); continue; }
      const rest = g.hooks.filter((h) => !isOurs(h));
      if (rest.length === g.hooks.length) kept.push(g);
      else if (rest.length > 0) kept.push({ ...g, hooks: rest });
    }
    if (kept.length > 0) out.hooks[event] = kept;
    else delete out.hooks[event];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

// Idempotent: strips our previous entries (also from an old repo path), then appends fresh ones.
export function mergeHooks(settings, repo) {
  const out = removeHooks(settings);
  out.hooks ??= {};
  for (const [event, matcher] of HOOK_EVENTS) {
    const group = { hooks: [{ type: 'command', command: hookCommand(repo, event), async: true, timeout: 5 }] };
    if (matcher) group.matcher = matcher;
    (out.hooks[event] ??= []).push(group);
  }
  return out;
}
