import { randomInt } from 'node:crypto';

const MAX_BINDINGS = 500;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const TOOL_KIND = { AskUserQuestion: 'ask', ExitPlanMode: 'plan' };

const isLive = d => d.status === 'open' || d.status === 'injected';

function newId() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(36)];
  return s;
}

// In-memory store of sessions, dialogs and Telegram message bindings.
// Persistence is done by the daemon via toJSON()/fromJSON().
export class Store {
  constructor() {
    this.sessions = new Map();
    this.dialogs = new Map(); // insertion order == creation order
    this.messages = new Map(); // messageId -> { sessionId, dialogId? }
    this.pendingRoute = null; // { text, createdAt } | null
    this.pendingOther = null; // dialogId | null
  }

  // ---- sessions ----
  upsertSession(partial) {
    const prev = this.sessions.get(partial.id);
    const defined = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined));
    const s = { ...(prev ?? { pid: null, cwd: '', project: '', branch: '', state: 'idle', lastPromptAt: null }), ...defined };
    s.short = partial.short ?? prev?.short ?? partial.id.slice(0, 8);
    s.lastActivityAt = partial.lastActivityAt ?? Date.now();
    this.sessions.set(s.id, s);
    return s;
  }

  getSession(id) { return this.sessions.get(id) ?? null; }

  sessionByShort(short) {
    for (const s of this.sessions.values()) if (s.short === short) return s;
    return null;
  }

  // Removes the session and closes its open dialogs ('ended'); returns the closed dialogs.
  removeSession(id) {
    const closed = this.closeOpenDialogsOf(id, 'ended');
    this.sessions.delete(id);
    return closed;
  }

  liveSessions() {
    return [...this.sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  labelOf(id) {
    const s = this.sessions.get(id);
    if (!s) return '';
    let label = `${s.project} · ${s.branch}`;
    let same = 0;
    for (const o of this.sessions.values()) if (o.project === s.project) same++;
    if (same > 1) label += ` #${s.short.slice(0, 4)}`;
    return label;
  }

  // ---- dialogs ----
  openDialog({ sessionId, kind, toolUseId = null, payload = null, options = [] }) {
    let id;
    do { id = newId(); } while (this.dialogs.has(id));
    const d = {
      id, sessionId, kind,
      toolUseId: toolUseId ?? null,
      payload, options,
      answers: [], cursor: 0, multi: [], awaitingOther: false,
      status: 'open', closedReason: null,
      messageIds: [], source: null,
      createdAt: Date.now(),
    };
    this.dialogs.set(id, d);
    return d;
  }

  getDialog(id) { return this.dialogs.get(id) ?? null; }

  openDialogOf(sessionId) {
    let found = null;
    for (const d of this.dialogs.values()) if (d.sessionId === sessionId && isLive(d)) found = d;
    return found;
  }

  // Closing drops the heavy payload (tool_input); only text/messageIds stay for late edits.
  closeDialog(id, reason, at = Date.now()) {
    const d = this.dialogs.get(id);
    if (!d) return null;
    if (d.status === 'closed') return d;
    d.status = 'closed';
    d.closedReason = reason;
    d.closedAt = at;
    d.payload = null;
    if (this.pendingOther === id) this.pendingOther = null;
    return d;
  }

  // Drops dialogs of removed sessions and closed dialogs older than maxAgeMs (by closedAt,
  // falling back to createdAt for snapshots written before closedAt existed).
  pruneDialogs(now = Date.now(), maxAgeMs = 3_600_000) {
    for (const d of [...this.dialogs.values()]) {
      const orphan = !this.sessions.has(d.sessionId);
      const expired = d.status === 'closed' && now - (d.closedAt ?? d.createdAt ?? 0) > maxAgeMs;
      if (!orphan && !expired) continue;
      this.dialogs.delete(d.id);
      if (this.pendingOther === d.id) this.pendingOther = null;
    }
  }

  closeOpenDialogsOf(sessionId, reason) {
    const closed = [];
    for (const d of this.dialogs.values()) {
      if (d.sessionId === sessionId && isLive(d)) {
        this.closeDialog(d.id, reason);
        closed.push(d);
      }
    }
    return closed;
  }

  findDialogForTool(sessionId, toolName, toolUseId) {
    const mine = [...this.dialogs.values()].filter(d => d.sessionId === sessionId);
    if (toolUseId) {
      const hit = mine.find(d => d.toolUseId === toolUseId);
      if (hit) return hit;
    }
    const kind = TOOL_KIND[toolName] ?? 'perm';
    const same = mine.filter(d => d.kind === kind);
    for (const st of ['injected', 'open']) {
      for (let i = same.length - 1; i >= 0; i--) if (same[i].status === st) return same[i];
    }
    return null;
  }

  // ---- message bindings (capped, oldest evicted) ----
  bindMessage(messageId, binding) {
    this.messages.delete(messageId);
    this.messages.set(messageId, { ...binding });
    while (this.messages.size > MAX_BINDINGS) this.messages.delete(this.messages.keys().next().value);
  }

  lookupMessage(messageId) { return this.messages.get(messageId) ?? null; }

  // ---- persistence ----
  toJSON() {
    return {
      sessions: [...this.sessions.values()].map(s => ({ ...s })),
      dialogs: [...this.dialogs.values()].map(d => ({ ...d, multi: [...d.multi], answers: [...d.answers], messageIds: [...d.messageIds] })),
      messages: [...this.messages.entries()].map(([id, b]) => [id, { ...b }]),
      pendingRoute: this.pendingRoute ? { ...this.pendingRoute } : null,
      pendingOther: this.pendingOther,
    };
  }

  static fromJSON(data) {
    const st = new Store();
    if (!data || typeof data !== 'object') return st;
    for (const s of data.sessions ?? []) st.sessions.set(s.id, { ...s });
    for (const d of data.dialogs ?? []) st.dialogs.set(d.id, { ...d, multi: [...(d.multi ?? [])] });
    for (const [id, b] of data.messages ?? []) st.messages.set(id, { ...b });
    st.pendingRoute = data.pendingRoute ?? null;
    st.pendingOther = data.pendingOther ?? null;
    return st;
  }
}
