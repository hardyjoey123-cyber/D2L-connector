/**
 * Conversation memory across sessions.
 *
 * Stored in the browser rather than on the server: it is the user's own
 * conversation, it never needs to outlive their machine, and keeping it here
 * means the server stays stateless. Cleared with one button in settings.
 */

const STORAGE_KEY = "jarvis.history.v1";
/** Turns kept in context. Bounds both API cost and reply latency. */
export const HISTORY_LIMIT = 30;
/** Older turns are dropped entirely rather than kept in a growing archive. */
const STORE_LIMIT = 60;

export class Memory {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    this.turns = enabled ? read() : [];
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) clear();
    else write(this.turns);
  }

  /** The turns to send with a request — trimmed to the context limit. */
  context() {
    const recent = this.turns.slice(-HISTORY_LIMIT);
    // The API requires the conversation to open on a user turn.
    while (recent.length && recent[0].role !== "user") recent.shift();
    return recent;
  }

  push(role, content) {
    this.turns.push({ role, content });
    if (this.turns.length > STORE_LIMIT) {
      this.turns = this.turns.slice(-STORE_LIMIT);
    }
    if (this.enabled) write(this.turns);
  }

  /** Drops the last turn — used when a request fails before it was answered. */
  pop() {
    this.turns.pop();
    if (this.enabled) write(this.turns);
  }

  forget() {
    this.turns = [];
    clear();
  }

  get isEmpty() {
    return this.turns.length === 0;
  }
}

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (turn) =>
        turn &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string" &&
        turn.content.trim() !== ""
    );
  } catch {
    return [];
  }
}

function write(turns) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(turns));
  } catch {
    /* storage unavailable or full — memory just won't persist */
  }
}

function clear() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
