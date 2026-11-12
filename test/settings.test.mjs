import test from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_EVENTS, hookCommand, mergeHooks, removeHooks } from '../src/settings.mjs';

const REPO = String.raw`C:\Projects\cc-telegram`;
const user = () => ({
  enabledPlugins: { 'superpowers@claude-plugins-official': true },
  effortLevel: 'high',
  autoMode: { soft_deny: ['$defaults', 'x'], environment: ['y'] },
  modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 400000 } },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] },
});

test('hookCommand uses forward slashes', () => {
  assert.equal(hookCommand(REPO, 'Stop'), 'node "C:/Projects/cc-telegram/src/hook.mjs" Stop');
});

test('mergeHooks keeps foreign hooks and keys, adds ours', () => {
  const orig = user();
  const m = mergeHooks(orig, REPO);
  assert.deepEqual(orig, user(), 'input not mutated');
  assert.deepEqual(m.autoMode, user().autoMode);
  assert.deepEqual(m.enabledPlugins, user().enabledPlugins);
  assert.equal(m.effortLevel, 'high');
  assert.deepEqual(m.hooks.Stop[0], { hooks: [{ type: 'command', command: 'other' }] });
  assert.equal(m.hooks.Stop.length, 2);
  for (const [ev] of HOOK_EVENTS) assert.ok(m.hooks[ev], ev);
});

test('mergeHooks is idempotent', () => {
  const once = mergeHooks(user(), REPO);
  assert.deepEqual(mergeHooks(once, REPO), once);
  assert.equal(mergeHooks(once, REPO).hooks.Stop.length, 2);
});

test('F5: no matcher anywhere (PreToolUse for all tools, as events.mjs expects); all our hooks async', () => {
  const m = mergeHooks(user(), REPO);
  assert.equal(m.hooks.PreToolUse.length, 1);
  assert.ok(!('matcher' in m.hooks.PreToolUse[0]));
  for (const [, matcher] of HOOK_EVENTS) assert.equal(matcher, null);
  assert.equal(m.hooks.Stop[1].matcher, undefined);
  // re-install over an old matcher-based entry replaces it
  const old = { hooks: { PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: hookCommand(REPO, 'PreToolUse'), async: true }] }] } };
  assert.deepEqual(mergeHooks(old, REPO).hooks.PreToolUse, mergeHooks({}, REPO).hooks.PreToolUse);
  let n = 0;
  for (const groups of Object.values(m.hooks)) for (const g of groups) for (const h of g.hooks) {
    if (h.command.includes('cc-telegram/src/hook.mjs')) { n++; assert.equal(h.async, true); assert.equal(h.timeout, 5); assert.equal(h.type, 'command'); }
  }
  assert.equal(n, HOOK_EVENTS.length);
});

test('removeHooks(mergeHooks(x)) deepEquals x', () => {
  assert.deepEqual(removeHooks(mergeHooks(user(), REPO)), user());
  assert.deepEqual(removeHooks(mergeHooks({}, REPO)), {});
});

test('merge with a different repo path replaces old entries', () => {
  const m = mergeHooks(mergeHooks(user(), String.raw`D:\old\cc-telegram`), REPO);
  assert.equal(m.hooks.Stop.length, 2);
  assert.ok(m.hooks.Stop[1].hooks[0].command.includes('C:/Projects/cc-telegram'));
});

test('removeHooks leaves foreign entries sharing a group', () => {
  const s = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: String.raw`node "C:\y\cc-telegram\src\hook.mjs" Stop` }] }] } };
  assert.deepEqual(removeHooks(s), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] } });
});

test('hooks/hooks.json of the plugin is exactly pluginHooks() (regenerate it when HOOK_EVENTS change)', async () => {
  const { pluginHooks } = await import('../src/settings.mjs');
  const fs = await import('node:fs');
  const file = new URL('../hooks/hooks.json', import.meta.url);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), pluginHooks());
  for (const [ev] of HOOK_EVENTS) {
    assert.equal(pluginHooks().hooks[ev][0].hooks[0].command, `node "\${CLAUDE_PLUGIN_ROOT}/src/hook.mjs" ${ev}`);
  }
});

test('removeHooks recognizes hooks pointing at the installed app copy', () => {
  const app = 'C:/Users/u/.claude/telegram/app';
  const m = mergeHooks({ effortLevel: 'high' }, app);
  assert.ok(m.hooks.Stop[0].hooks[0].command.includes('/telegram/app/src/hook.mjs'));
  assert.deepEqual(removeHooks(m), { effortLevel: 'high' });
});
