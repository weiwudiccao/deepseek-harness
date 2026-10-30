const { strict: assert } = require('node:assert');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createLocalRuntimeOwner } = require('../src/local-runtime-support.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function runtimeFixture({ automaticExit = true } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.exit = () => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  };
  child.kill = signal => {
    child.signals.push(signal);
    if (automaticExit) queueMicrotask(child.exit);
    return true;
  };
  return { child, origin: new URL('http://127.0.0.1:43120/') };
}

test('runtime ownership revalidates authorization and reuses only the same employee and token', async (context) => {
  let authorization = { user: 'employee-a', token: 'session-a' };
  let reads = 0;
  const launched = [];
  const owner = createLocalRuntimeOwner({
    authorize: async () => { reads += 1; return authorization; },
    launch: (auth) => {
      const runtime = runtimeFixture();
      launched.push({ auth, runtime });
      return { child: runtime.child, ready: Promise.resolve(runtime) };
    },
  });
  context.after(() => owner.retire());
  const first = await owner.get();
  assert.equal(await owner.get(), first);
  assert.equal(reads, 2);
  assert.equal(launched.length, 1);
  authorization = { user: 'employee-a', token: 'session-b' };
  const rotated = await owner.get();
  assert.notEqual(rotated, first);
  assert.deepEqual(first.child.signals, ['SIGTERM']);
  authorization = { user: 'employee-b', token: 'session-b' };
  const otherEmployee = await owner.get();
  assert.notEqual(otherEmployee, rotated);
  assert.deepEqual(rotated.child.signals, ['SIGTERM']);
  assert.equal(owner.current, otherEmployee);
});

test('runtime ownership retires a successful login generation and suppresses the old exit notification', async () => {
  let exits = 0;
  const runtime = runtimeFixture();
  const owner = createLocalRuntimeOwner({
    authorize: async () => ({ user: 'employee-a', token: 'session-a' }),
    launch: () => ({ child: runtime.child, ready: Promise.resolve(runtime) }),
    onExit: () => { exits += 1; },
  });
  await owner.get();
  const retirement = owner.retire();
  assert.equal(owner.current, undefined);
  await retirement;
  assert.equal(runtime.child.exitCode, 0);
  assert.equal(exits, 0);
});

test('runtime ownership rejects authorization completed after a new login generation', async () => {
  const authorization = deferred();
  let launches = 0;
  const owner = createLocalRuntimeOwner({
    authorize: () => authorization.promise,
    launch: () => { launches += 1; throw new Error('stale authorization must not launch'); },
  });
  const pending = owner.get();
  const rejected = assert.rejects(pending, /登录状态已更新/u);
  await owner.retire();
  authorization.resolve({ user: 'employee-a', token: 'rotated-cookie' });
  await rejected;
  assert.equal(launches, 0);
  assert.equal(owner.current, undefined);
});

test('runtime ownership stops a pending launch and rejects its late readiness after login changes', async () => {
  const started = deferred();
  const ready = deferred();
  const runtime = runtimeFixture();
  let launchSignal;
  const owner = createLocalRuntimeOwner({
    authorize: async () => ({ user: 'employee-a', token: 'session-a' }),
    launch: (_authorization, signal) => {
      launchSignal = signal;
      started.resolve();
      return { child: runtime.child, ready: ready.promise };
    },
  });
  const pending = owner.get();
  const rejected = assert.rejects(pending, /登录状态已更新/u);
  await started.promise;
  await owner.retire();
  ready.resolve(runtime);
  await rejected;
  assert.equal(launchSignal.aborted, true);
  assert.equal(runtime.child.exitCode, 0);
  assert.equal(owner.current, undefined);
});

test('runtime ownership shares an in-flight launch and reports only the current runtime exit', async () => {
  const started = deferred();
  const ready = deferred();
  const runtime = runtimeFixture();
  let launches = 0;
  let exits = 0;
  const owner = createLocalRuntimeOwner({
    authorize: async () => ({ user: 'employee-a', token: 'session-a' }),
    launch: () => {
      launches += 1;
      started.resolve();
      return { child: runtime.child, ready: ready.promise };
    },
    onExit: () => { exits += 1; },
  });
  const first = owner.get();
  await started.promise;
  const second = owner.get();
  ready.resolve(runtime);
  assert.equal(await first, runtime);
  assert.equal(await second, runtime);
  assert.equal(launches, 1);
  runtime.child.exit();
  assert.equal(owner.current, undefined);
  assert.equal(exits, 1);
});

test('runtime ownership keeps the current runtime when authorization fails', async (context) => {
  let denied = false;
  const runtime = runtimeFixture();
  const owner = createLocalRuntimeOwner({
    authorize: async () => {
      if (denied) throw new Error('login failed');
      return { user: 'employee-a', token: 'session-a' };
    },
    launch: () => ({ child: runtime.child, ready: Promise.resolve(runtime) }),
  });
  context.after(() => owner.retire());
  await owner.get();
  denied = true;
  await assert.rejects(owner.get(), /login failed/u);
  assert.equal(owner.current, runtime);
  assert.deepEqual(runtime.child.signals, []);
});

test('runtime ownership joins ongoing retirements before another launch or retirement completes', async (context) => {
  const previous = runtimeFixture({ automaticExit: false });
  const replacement = runtimeFixture();
  let launches = 0;
  const owner = createLocalRuntimeOwner({
    authorize: async () => ({ user: 'employee-a', token: 'session-a' }),
    launch: () => {
      const runtime = launches++ === 0 ? previous : replacement;
      return { child: runtime.child, ready: Promise.resolve(runtime) };
    },
  });
  context.after(async () => { previous.child.exit(); await owner.retire(); });
  await owner.get();
  const firstRetirement = owner.retire();
  let secondFinished = false;
  const secondRetirement = owner.retire().then(() => { secondFinished = true; });
  const next = owner.get();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondFinished, false);
  assert.equal(launches, 1);
  previous.child.exit();
  await Promise.all([firstRetirement, secondRetirement]);
  assert.equal(await next, replacement);
  assert.equal(launches, 2);
});
