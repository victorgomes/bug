import assert from 'node:assert/strict';
import test from 'node:test';

import { Mutex, SessionManager } from '../mcp-server/session-manager.js';

function fakeOpenSession({ openDelayMs = 0, closeDelayMs = 0 } = {}) {
  const state = { opens: 0, closes: 0, sessions: [] };
  const factory = async () => {
    state.opens++;
    if (openDelayMs) await new Promise((r) => setTimeout(r, openDelayMs));
    const session = {
      id: state.opens,
      closed: false,
      async close() {
        if (closeDelayMs) await new Promise((r) => setTimeout(r, closeDelayMs));
        this.closed = true;
        state.closes++;
      },
    };
    state.sessions.push(session);
    return session;
  };
  return { factory, state };
}

test('SessionManager opens lazily and reuses the session', async () => {
  const { factory, state } = fakeOpenSession();
  const sm = new SessionManager({ openSession: factory, idleMs: 60_000 });

  assert.equal(state.opens, 0);
  assert.equal(sm.isOpen(), false);

  const a = await sm.get();
  const b = await sm.get();
  assert.equal(state.opens, 1);
  assert.equal(a, b);
  assert.equal(sm.isOpen(), true);

  await sm.close();
  assert.equal(state.closes, 1);
  assert.equal(sm.isOpen(), false);
});

test('SessionManager dedupes concurrent first opens', async () => {
  const { factory, state } = fakeOpenSession({ openDelayMs: 20 });
  const sm = new SessionManager({ openSession: factory, idleMs: 60_000 });

  const [a, b, c] = await Promise.all([sm.get(), sm.get(), sm.get()]);
  assert.equal(state.opens, 1);
  assert.equal(a, b);
  assert.equal(b, c);
  await sm.close();
});

test('SessionManager propagates open errors and recovers', async () => {
  let attempts = 0;
  const sm = new SessionManager({
    openSession: async () => {
      attempts++;
      if (attempts === 1) throw new Error('boom');
      return { id: attempts, async close() {} };
    },
    idleMs: 60_000,
  });

  await assert.rejects(() => sm.get(), /boom/);
  // After a failed open the manager clears its in-flight promise so a retry
  // actually retries instead of returning the same rejection forever.
  const s = await sm.get();
  assert.equal(s.id, 2);
  await sm.close();
});

test('withSession suppresses idle teardown while fn runs', async () => {
  const { factory } = fakeOpenSession();
  const sm = new SessionManager({ openSession: factory, idleMs: 30 });

  // fn runs for longer than idleMs; without suppression the timer would fire
  // mid-call and close the browser under us.
  const stillOpenInside = await sm.withSession(async () => {
    await new Promise((r) => setTimeout(r, 80));
    return sm.isOpen();
  });
  assert.equal(stillOpenInside, true);

  // After fn settles, the timer is re-armed; wait past it.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sm.isOpen(), false);
  await sm.close();
});

test('withSession re-arms idle even when fn throws', async () => {
  const { factory } = fakeOpenSession();
  const sm = new SessionManager({ openSession: factory, idleMs: 30 });

  await assert.rejects(
    () => sm.withSession(async () => { throw new Error('work failed'); }),
    /work failed/,
  );
  // Timer was armed in finally — wait past it, session should close.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sm.isOpen(), false);
  await sm.close();
});

test('get() does not arm the idle timer on its own', async () => {
  const { factory } = fakeOpenSession();
  const sm = new SessionManager({ openSession: factory, idleMs: 30 });

  await sm.get();
  // Wait past the idle window. Since get() no longer arms, the session must
  // still be open — withSession is the only thing that arms teardown.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sm.isOpen(), true);
  await sm.close();
});

test('get() awaits an in-flight close before launching a new session', async () => {
  const { factory, state } = fakeOpenSession({ closeDelayMs: 40 });
  const sm = new SessionManager({ openSession: factory, idleMs: 60_000 });

  await sm.get();
  assert.equal(state.opens, 1);

  // Start a close, then start a get before close finishes. The new get must
  // wait for close to drain so it doesn't race the profile-directory lock.
  const closePromise = sm.close();
  const getPromise = sm.get();

  // While close is still in flight, the new get cannot have launched yet.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(state.opens, 1, 'second open must not start until close drained');

  const [, fresh] = await Promise.all([closePromise, getPromise]);
  assert.equal(state.opens, 2);
  assert.equal(state.closes, 1);
  assert.equal(fresh.id, 2);
  await sm.close();
});

test('idleMs <= 0 disables teardown', async () => {
  const { factory } = fakeOpenSession();
  const sm = new SessionManager({ openSession: factory, idleMs: 0 });

  await sm.withSession(async () => {});
  // No timer should have been armed; session stays open indefinitely.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sm.isOpen(), true);
  await sm.close();
});

test('Mutex serializes async work', async () => {
  const m = new Mutex();
  const order = [];
  const task = (label, ms) => async () => {
    order.push(`${label}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${label}:end`);
    return label;
  };

  const results = await Promise.all([
    m.run(task('a', 30)),
    m.run(task('b', 10)),
    m.run(task('c', 5)),
  ]);

  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(order, [
    'a:start', 'a:end',
    'b:start', 'b:end',
    'c:start', 'c:end',
  ]);
});

test('Mutex releases the lock even on thrown work', async () => {
  const m = new Mutex();
  await assert.rejects(() => m.run(async () => { throw new Error('nope'); }), /nope/);
  const out = await m.run(async () => 'ok');
  assert.equal(out, 'ok');
});
