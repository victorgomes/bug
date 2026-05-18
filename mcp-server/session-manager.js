// Lazily-opened, idle-teardown wrapper around a Playwright browser session.
//
// Public entry point is withSession(fn): it acquires the session (launching
// Chromium on first call, reusing it after), suppresses the idle teardown
// while fn runs, and re-arms the idle timer when fn settles. This prevents
// the timer from firing mid-call and yanking the browser out from under a
// long-running fetch (e.g. a 30-page paginated list).
//
// close() records its in-flight promise so a get() arriving while the old
// browser is still releasing its profile directory waits for the close to
// finish before launching a new one — otherwise Playwright's persistent
// context launch fails with "profile in use".
//
// `openSession` is injected for testability.

export class SessionManager {
  constructor({ openSession, idleMs = 5 * 60_000, headless = true } = {}) {
    if (!openSession) throw new Error('SessionManager: openSession factory required');
    this._openSession = openSession;
    this._idleMs = idleMs;
    this._headless = headless;
    this._session = null;
    this._opening = null;
    this._closing = null;
    this._timer = null;
  }

  // Acquire the session, run fn against it, then re-arm idle teardown. fn
  // exceptions propagate; the idle timer is still re-armed.
  async withSession(fn) {
    const session = await this.get();
    this._cancelIdle();
    try {
      return await fn(session);
    } finally {
      this._armIdle();
    }
  }

  // Ensure a live session exists and return it. Does NOT arm the idle timer
  // (callers should use withSession, which re-arms after the work settles).
  // Exposed primarily for tests.
  async get() {
    if (this._closing) {
      // Don't let a previous close's failure poison subsequent opens; we'll
      // launch a fresh browser regardless.
      try { await this._closing; } catch { /* ignored */ }
    }
    if (this._session) return this._session;
    if (!this._opening) {
      const p = Promise.resolve()
        .then(() => this._openSession({ headless: this._headless }));
      this._opening = p.then(
        (s) => { this._session = s; this._opening = null; return s; },
        (err) => { this._opening = null; throw err; },
      );
    }
    return this._opening;
  }

  _cancelIdle() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _armIdle() {
    this._cancelIdle();
    if (this._idleMs <= 0) return;
    this._timer = setTimeout(() => this.close().catch(() => {}), this._idleMs);
    this._timer.unref?.();
  }

  async close() {
    this._cancelIdle();
    if (!this._session) {
      // Either never opened, or a previous close is already in flight. In the
      // latter case, returning that promise lets callers serialize correctly.
      return this._closing ?? undefined;
    }
    const s = this._session;
    this._session = null;
    this._closing = (async () => {
      try {
        await s.close();
      } finally {
        this._closing = null;
      }
    })();
    return this._closing;
  }

  isOpen() {
    return this._session !== null;
  }
}

// Async serialization primitive. openSession returns one Page; concurrent
// navigations on the same Page clobber each other, so all tool invocations
// must run serially against a given session.
export class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  async run(fn) {
    const prev = this._tail;
    let release;
    this._tail = new Promise((r) => { release = r; });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }
}
