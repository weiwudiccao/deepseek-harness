const { strict: assert } = require('node:assert');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const test = require('node:test');
const support = require('../src/local-runtime-support.cjs');

function desktop(context, responses, tokens = ['session-a']) {
  const userData = mkdtempSync(join(tmpdir(), 'qifu-desktop-auth-'));
  context.after(() => rmSync(userData, { recursive: true, force: true }));
  const handlers = new Map();
  const appEvents = new Map();
  const calls = [];
  const spawns = [];
  const windows = [];
  const timers = [];
  const runtime = { child: { exitCode: null }, origin: new URL('http://127.0.0.1:43120/') };
  const owner = { current: runtime, retire: async () => { calls.push('retire'); owner.current = undefined; } };
  let authorization;
  let launch;
  class Window {
    static getAllWindows() { return windows.filter(window => !window.destroyed); }
    constructor() {
      this.webContents = { setWindowOpenHandler() {}, on() {}, send() {} };
      this.loads = [];
      this.destroyed = false;
      windows.push(this);
    }
    once() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    async loadFile() {}
    async loadURL(url) { this.loads.push(url); calls.push(url); }
  }
  const electron = {
    BrowserWindow: Window,
    app: {
      getPath: () => userData, whenReady: () => ({ then() {} }),
      on: (name, handler) => appEvents.set(name, handler),
      quit: () => calls.push('quit'), exit: () => calls.push('exit'),
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    session: { defaultSession: {
      fetch: async url => { calls.push(new URL(url).pathname); return responses.shift(); },
      cookies: { get: async () => [{ value: tokens.length > 1 ? tokens.shift() : tokens[0] }] },
      setPermissionRequestHandler() {},
    } },
  };
  const filename = resolve(__dirname, '../src/main.cjs');
  runInNewContext(readFileSync(filename, 'utf8'), {
    require: name => name === 'electron' ? electron : name === 'node:fs'
      ? { ...require(name), existsSync: () => true }
      : name === 'node:child_process'
        ? { spawn: (command, args, options) => { spawns.push({ command, args, options }); throw new Error('test-only captured launch'); } }
        : name === './local-runtime-support.cjs'
      ? { ...support, createLocalRuntimeOwner: options => { authorization = options.authorize; launch = options.launch; return owner; } }
      : require(name),
    __dirname: resolve(__dirname, '../src'),
    process, URL, Buffer,
    setTimeout: callback => { timers.push(callback); return timers.length; },
  }, { filename });
  return { owner, runtime, calls, authorization, launch: (...args) => launch(...args), spawns, appEvents, windows, timers,
    switchRuntime: target => handlers.get('desktop:switch-runtime')({ senderFrame: { url: 'https://47.106.208.2:3443/' } }, target),
    login: () => {
      if (Window.getAllWindows().length === 0) appEvents.get('activate')();
      return handlers.get('desktop:login')({ senderFrame: { url: 'file:///login.html' } }, {
        account: 'employee-a', password: 'test-only-password', remember: false,
      });
    },
  };
}

test('local runtime routes chat and search through the employee gateway', context => {
  const app = desktop(context, []);
  const controller = new AbortController();
  assert.throws(
    () => app.launch({ user: 'employee-a', token: 'employee-session-token' }, controller.signal),
    /test-only captured launch/u,
  );
  assert.equal(app.spawns.length, 1);
  const { env } = app.spawns[0].options;
  assert.equal(env.DEEPSEEK_API_KEY, 'employee-session-token');
  assert.equal(env.DEEPSEEK_BASE_URL, 'https://47.106.208.2:3443/qifu-model/v1');
  assert.equal(env.DEEPSEEK_SEARCH_BASE_URL, 'https://47.106.208.2:3443/qifu-model/v1');
  assert.equal(env.QIFUAI_CONTEXT_TOKEN, 'employee-session-token');
  assert.equal(env.QIFUAI_OFFICE_ENABLED, 'true');
});

test('failed employee login preserves the current local runtime', async context => {
  const app = desktop(context, [new Response('{"message":"denied"}', { status: 401 })]);
  const result = await app.login();
  assert.equal(result.ok, false);
  assert.equal(app.owner.current, app.runtime);
  assert.deepEqual(app.calls, ['/auth/login']);
});

test('successful employee login retires the previous runtime before entering the new session', async context => {
  const app = desktop(context, [
    new Response('{"ok":true}'),
    new Response('{"ok":true,"user":"employee-b"}'),
  ]);
  const result = await app.login();
  assert.equal(result.ok, true);
  assert.equal(app.owner.current, undefined);
  assert.deepEqual(app.calls, ['/auth/login', 'retire', '/auth/session']);
});

test('local runtime authorization rejects an employee identity paired with a changed cookie', async context => {
  const app = desktop(context, [new Response('{"ok":true,"user":"employee-a"}')], ['session-a', 'session-b']);
  await assert.rejects(app.authorization(), /登录状态已更新/u);
  assert.deepEqual(app.calls, ['/auth/session']);
});

test('desktop quit waits for runtime retirement even when requested twice', async context => {
  const app = desktop(context, []);
  let finish;
  let retirements = 0;
  let prevented = 0;
  const retirement = new Promise(resolve => { finish = resolve; });
  app.owner.retire = () => { retirements += 1; return retirement; };
  const beforeQuit = app.appEvents.get('before-quit');
  beforeQuit({ preventDefault: () => { prevented += 1; } });
  beforeQuit({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 2);
  assert.equal(retirements, 1);
  assert.deepEqual(app.calls, []);
  finish();
  await retirement;
  assert.deepEqual(app.calls, ['quit']);
  beforeQuit({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 2);
});

test('local navigation rejects a runtime retired before the switch continuation', async context => {
  const app = desktop(context, []);
  app.appEvents.get('activate')();
  let finish;
  app.owner.get = () => new Promise(resolve => { finish = resolve; });
  const switching = app.switchRuntime('local');
  app.owner.current = undefined;
  finish(app.runtime);
  const result = await switching;
  assert.equal(result.ok, false);
  assert.match(result.message, /登录状态已更新/u);
  assert.deepEqual(app.calls, []);
});

test('pending local navigation cannot load a replacement login window', async context => {
  const app = desktop(context, []);
  app.appEvents.get('activate')();
  let finish;
  app.owner.get = () => new Promise(resolve => { finish = resolve; });
  const switching = app.switchRuntime('local');
  app.windows[0].destroy();
  app.appEvents.get('activate')();
  finish(app.runtime);
  const result = await switching;
  assert.equal(result.ok, false);
  assert.deepEqual(app.windows[1].loads, []);
});

test('a completed login timer cannot navigate a replacement window', async context => {
  const app = desktop(context, [new Response('{"ok":true}'), new Response('{"ok":true,"user":"employee-a"}')]);
  assert.equal((await app.login()).ok, true);
  app.windows[0].destroy();
  app.appEvents.get('activate')();
  for (const timer of app.timers) timer();
  assert.deepEqual(app.windows[1].loads, []);
});
