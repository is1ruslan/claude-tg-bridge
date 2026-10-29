import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptArg, claudeLaunch } from '../src/newsession.mjs';

test('promptArg: a leading "-" is shielded with a space, other text untouched', () => {
  assert.equal(promptArg('-v please'), ' -v please');
  assert.equal(promptArg('  --help'), '   --help');
  assert.equal(promptArg('напиши "README"\nи $HOME & ok'), 'напиши "README"\nи $HOME & ok');
});

test('claudeLaunch: exe → argv with the prompt as one element; empty prompt → no args', () => {
  const exe = { cmd: 'C:\\x\\claude.exe', shell: false };
  assert.deepEqual(claudeLaunch('a & b\nc', exe), { cmd: exe.cmd, args: ['a & b\nc'] });
  assert.deepEqual(claudeLaunch('  \n', exe), { cmd: exe.cmd, args: [] });
});

test('claudeLaunch: .cmd shim (shell) → refused, never run through cmd.exe', () => {
  const r = claudeLaunch('x & del *', { cmd: 'C:\\npm\\claude.cmd', shell: true });
  assert.ok(r.error);
  assert.equal(r.cmd, undefined);
});
