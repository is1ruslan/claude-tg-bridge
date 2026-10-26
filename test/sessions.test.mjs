import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/sessions.mjs';

const sess = (id, project = 'proj', branch = 'main', extra = {}) =>
  ({ id, pid: 1, cwd: `/x/${project}`, project, branch, state: 'idle', ...extra });

test('upsertSession sets short/lastActivityAt and merges', () => {
  const s = new Store();
  const a = s.upsertSession(sess('abcdef1234567890'));
  assert.equal(a.short, 'abcdef12');
  assert.equal(typeof a.lastActivityAt, 'number');
  s.upsertSession({ id: 'abcdef1234567890', state: 'working', lastActivityAt: 5 });
  const b = s.getSession('abcdef1234567890');
  assert.equal(b.state, 'working');
  assert.equal(b.project, 'proj');
  assert.equal(b.lastActivityAt, 5);
  assert.equal(s.sessionByShort('abcdef12').id, 'abcdef1234567890');
  assert.equal(s.sessionByShort('nope'), null);
  assert.equal(s.getSession('nope'), null);
});

test('liveSessions sorted by lastActivityAt desc', () => {
  const s = new Store();
  s.upsertSession(sess('aaaaaaaa1', 'a', 'm', { lastActivityAt: 1 }));
  s.upsertSession(sess('bbbbbbbb1', 'b', 'm', { lastActivityAt: 3 }));
  s.upsertSession(sess('cccccccc1', 'c', 'm', { lastActivityAt: 2 }));
  assert.deepEqual(s.liveSessions().map(x => x.project), ['b', 'c', 'a']);
});

test('labelOf adds #short4 only for duplicate projects', () => {
  const s = new Store();
  s.upsertSession(sess('aaaa1111xx', 'p', 'main'));
  assert.equal(s.labelOf('aaaa1111xx'), 'p · main');
  s.upsertSession(sess('bbbb2222xx', 'p', 'dev'));
  assert.equal(s.labelOf('aaaa1111xx'), 'p · main #aaaa');
  assert.equal(s.labelOf('bbbb2222xx'), 'p · dev #bbbb');
});

test('openDialog: 6-char base36 unique id, defaults', () => {
  const s = new Store();
  s.upsertSession(sess('s1'));
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const d = s.openDialog({ sessionId: 's1', kind: 'ask', toolUseId: 't' + i, payload: {} });
    assert.match(d.id, /^[0-9a-z]{6}$/);
    ids.add(d.id);
  }
  assert.equal(ids.size, 200);
  const d = s.openDialog({ sessionId: 's1', kind: 'perm', payload: {}, options: ['a'] });
  assert.equal(d.status, 'open');
  assert.equal(d.toolUseId, null);
  assert.deepEqual(d.answers, []);
  assert.equal(d.cursor, 0);
  assert.deepEqual(d.multi, []);
  assert.equal(d.awaitingOther, false);
  assert.deepEqual(d.messageIds, []);
  assert.equal(d.source, null);
  assert.equal(s.getDialog(d.id), d);
});

test('openDialogOf returns latest open/injected; closeDialog clears it', () => {
  const s = new Store();
  s.upsertSession(sess('s1'));
  assert.equal(s.openDialogOf('s1'), null);
  const d1 = s.openDialog({ sessionId: 's1', kind: 'ask', payload: {} });
  const d2 = s.openDialog({ sessionId: 's1', kind: 'plan', payload: {} });
  assert.equal(s.openDialogOf('s1'), d2);
  d2.status = 'injected';
  assert.equal(s.openDialogOf('s1'), d2);
  s.closeDialog(d2.id, 'terminal');
  assert.equal(d2.status, 'closed');
  assert.equal(d2.closedReason, 'terminal');
  assert.equal(s.openDialogOf('s1'), d1);
  s.closeDialog(d1.id, 'stale');
  assert.equal(s.openDialogOf('s1'), null);
});

test('closeDialog does not overwrite source; clears pendingOther', () => {
  const s = new Store();
  s.upsertSession(sess('s1'));
  const d = s.openDialog({ sessionId: 's1', kind: 'ask', payload: {} });
  d.source = 'telegram';
  s.pendingOther = d.id;
  s.closeDialog(d.id, 'ended');
  assert.equal(d.source, 'telegram');
  assert.equal(s.pendingOther, null);
  const e = s.openDialog({ sessionId: 's1', kind: 'ask', payload: {} });
  s.pendingOther = 'other';
  s.closeDialog(e.id, 'telegram');
  assert.equal(s.pendingOther, 'other');
});

test('closeOpenDialogsOf returns closed dialogs only', () => {
  const s = new Store();
  s.upsertSession(sess('s1'));
  s.upsertSession(sess('s2'));
  const a = s.openDialog({ sessionId: 's1', kind: 'ask', payload: {} });
  const b = s.openDialog({ sessionId: 's1', kind: 'perm', payload: {} });
  const c = s.openDialog({ sessionId: 's2', kind: 'perm', payload: {} });
  s.closeDialog(a.id, 'terminal');
  const closed = s.closeOpenDialogsOf('s1', 'terminal');
  assert.deepEqual(closed, [b]);
  assert.equal(b.closedReason, 'terminal');
  assert.equal(c.status, 'open');
  assert.deepEqual(s.closeOpenDialogsOf('s1', 'terminal'), []);
});

test('findDialogForTool: by toolUseId, else latest open of same kind', () => {
  const s = new Store();
  s.upsertSession(sess('s1'));
  const a = s.openDialog({ sessionId: 's1', kind: 'ask', toolUseId: 'tu1', payload: {} });
  const b = s.openDialog({ sessionId: 's1', kind: 'ask', toolUseId: 'tu2', payload: {} });
  const p = s.openDialog({ sessionId: 's1', kind: 'plan', toolUseId: 'tu3', payload: {} });
  const m = s.openDialog({ sessionId: 's1', kind: 'perm', toolUseId: null, payload: {} });
  assert.equal(s.findDialogForTool('s1', 'AskUserQuestion', 'tu1'), a);
  assert.equal(s.findDialogForTool('s1', 'AskUserQuestion', 'zzz'), b);
  assert.equal(s.findDialogForTool('s1', 'AskUserQuestion', null), b);
  assert.equal(s.findDialogForTool('s1', 'ExitPlanMode', undefined), p);
  assert.equal(s.findDialogForTool('s1', 'Bash', 'nope'), m);
  s.closeDialog(b.id, 'terminal');
  assert.equal(s.findDialogForTool('s1', 'AskUserQuestion', 'nope'), a);
  s.closeDialog(a.id, 'terminal');
  assert.equal(s.findDialogForTool('s1', 'AskUserQuestion', 'nope'), null);
  assert.equal(s.findDialogForTool('other', 'Bash', null), null);
});

test('removeSession closes its dialogs with ended and returns them', () => {
  const s = new Store();
  s.upsertSession(sess('s1'));
  const d = s.openDialog({ sessionId: 's1', kind: 'ask', payload: {} });
  const closed = s.removeSession('s1');
  assert.deepEqual(closed, [d]);
  assert.equal(d.status, 'closed');
  assert.equal(d.closedReason, 'ended');
  assert.equal(s.getSession('s1'), null);
  assert.deepEqual(s.removeSession('s1'), []);
});

test('bindMessage / lookupMessage with 500 cap', () => {
  const s = new Store();
  for (let i = 1; i <= 600; i++) s.bindMessage(i, { sessionId: 's', dialogId: 'd' + i });
  assert.equal(s.lookupMessage(1), null);
  assert.equal(s.lookupMessage(100), null);
  assert.deepEqual(s.lookupMessage(101), { sessionId: 's', dialogId: 'd101' });
  assert.deepEqual(s.lookupMessage(600), { sessionId: 's', dialogId: 'd600' });
});

test('toJSON/fromJSON round-trips everything', () => {
  const s = new Store();
  s.upsertSession(sess('s1'));
  s.upsertSession(sess('s2', 'q'));
  const d = s.openDialog({ sessionId: 's1', kind: 'ask', toolUseId: 't', payload: { q: 1 }, options: ['x'] });
  d.multi = [0, 2];
  d.answers = [['a'], null];
  d.cursor = 1;
  d.messageIds = [7, 8];
  s.bindMessage(7, { sessionId: 's1', dialogId: d.id });
  const e = s.openDialog({ sessionId: 's2', kind: 'perm', payload: {} });
  s.closeDialog(e.id, 'stale');
  s.pendingOther = d.id;
  s.pendingRoute = { text: 'hi', createdAt: 5 };
  const json = JSON.parse(JSON.stringify(s.toJSON()));
  assert.ok(Array.isArray(json.dialogs.find(x => x.id === d.id).multi));
  const r = Store.fromJSON(json);
  assert.deepEqual(r.toJSON(), s.toJSON());
  assert.deepEqual(r.getDialog(d.id), d);
  assert.equal(r.getDialog(e.id).closedReason, 'stale');
  assert.equal(r.pendingOther, d.id);
  assert.deepEqual(r.pendingRoute, { text: 'hi', createdAt: 5 });
  assert.deepEqual(r.lookupMessage(7), { sessionId: 's1', dialogId: d.id });
  assert.equal(r.openDialogOf('s1').id, d.id);
  const n = r.openDialog({ sessionId: 's1', kind: 'ask', payload: {} });
  assert.notEqual(n.id, d.id);
  assert.equal(Store.fromJSON(null).liveSessions().length, 0);
});
