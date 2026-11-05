const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const { startBrowserTestServer } = require('../src/browser-test-support.cjs');

function fixture(context, options = {}) {
  const windows = [];
  const sessions = [];
  const created = new EventEmitter();
  class Window extends EventEmitter {
    constructor(configuration) {
      super(); this.configuration = configuration; this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.setWindowOpenHandler = handler => { this.popup = handler; };
      this.webContents.executeJavaScriptInIsolatedWorld = async (_world, scripts) => {
        this.scripts = scripts;
        return { dom: '<html>owned marker</html>', domTruncated: false };
      };
      windows.push(this); created.emit('created', this);
    }
    isDestroyed() { return this.destroyed; }
    loadURL(url) { this.url = url; return options.load ? options.load(this) : Promise.resolve(); }
    finishDestroy() { this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); }
    destroy() { this.destroyRequested = true; this.emit('destroy-requested'); if (!options.delayedDestroy) this.finishDestroy(); }
  }
  const session = { fromPartition: (partition, configuration) => {
    const value = new EventEmitter();
    Object.assign(value, { partition, configuration, cleared: false,
      setPermissionRequestHandler(handler) { this.permission = handler; },
      setPermissionCheckHandler(handler) { this.permissionCheck = handler; },
      setDevicePermissionHandler(handler) { this.devicePermission = handler; },
      async clearStorageData() { this.cleared = true; this.emit('cleared'); },
      async clearCache() {},
    });
    sessions.push(value); return value;
  } };
  let bridge;
  context.after(async () => {
    for (const window of windows) if (!window.destroyed) window.finishDestroy();
    await bridge?.stop();
  });
  return { windows, sessions, created, async start() {
    bridge = await startBrowserTestServer({ BrowserWindow: Window, session, timeoutMs: 30_000, maxDomBytes: 1024 * 1024, maxConcurrentOperations: 2 });
    return bridge;
  } };
}
function identity() { return { requestId: randomUUID(), createdAt: Date.now() }; }
function headers(bridge, id) { return { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json', 'x-qifu-browser-request-id': id.requestId, 'x-qifu-browser-created-at': String(id.createdAt) }; }
function send(bridge, id, method = 'POST', overrides = {}, extraHeaders = {}) {
  const body = method === 'DELETE' ? { requestId: id.requestId } : { requestId: id.requestId, url: 'https://example.invalid/page', maxDomBytes: 1024, timeoutMs: 1000, ...overrides };
  return fetch(bridge.url, { method, headers: { ...headers(bridge, id), ...extraHeaders }, body: JSON.stringify(body) });
}

test('normal POST returns bounded DOM only after its isolated window and session are destroyed', async context => {
  const f = fixture(context); const bridge = await f.start();
  const response = await send(bridge, identity());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://example.invalid/page', dom: '<html>owned marker</html>', domTruncated: false });
  assert.equal(f.windows[0].destroyed, true); assert.equal(f.sessions[0].cleared, true);
  assert.equal(bridge.activeWindowCount, 0);
  assert.equal(f.sessions[0].partition.startsWith('persist:'), false);
  assert.deepEqual(f.windows[0].configuration.webPreferences, { session: f.sessions[0], offscreen: true, focusOnNavigation: false, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, sandbox: true, contextIsolation: true, webSecurity: true, disableDialogs: true, devTools: false });
  assert.deepEqual(f.windows[0].popup(), { action: 'deny' });
  assert.equal(f.sessions[0].permissionCheck(), false);
  let granted; f.sessions[0].permission(null, null, value => { granted = value; }); assert.equal(granted, false);
  assert.match(f.windows[0].scripts[0].code, /TextEncoder/u);
  assert.match(f.windows[0].scripts[0].code, /slice\(0, 1025\)/u);
});

test('authentication, unsafe URLs, extra input and stale requests never create a window', async context => {
  const f = fixture(context); const bridge = await f.start();
  for (const [id, payload, extraHeaders, status] of [
    [identity(), {}, { authorization: 'Bearer invalid' }, 401],
    [identity(), { url: 'file:///private/file' }, {}, 400],
    [identity(), { url: 'https://user:secret@example.invalid/' }, {}, 400],
    [identity(), { code: 'process.exit()' }, {}, 400],
    [{ requestId: randomUUID(), createdAt: Date.now() - 60_000 }, {}, {}, 400],
  ]) { const response = await send(bridge, id, 'POST', payload, extraHeaders); assert.equal(response.status, status); await response.text(); }
  assert.equal(f.windows.length, 0);
});

test('DELETE before POST records cancellation and prevents a late window', async context => {
  const f = fixture(context); const bridge = await f.start(); const id = identity();
  assert.equal((await send(bridge, id, 'DELETE')).status, 204);
  assert.equal((await send(bridge, id)).status, 409);
  assert.equal(f.windows.length, 0);
});

test('DELETE waits for webContents destruction and shared session cleanup', async context => {
  const f = fixture(context, { delayedDestroy: true, load: () => new Promise(() => {}) });
  const bridge = await f.start(); const id = identity();
  const created = once(f.created, 'created'); const reading = send(bridge, id); await created;
  const destroyRequested = once(f.windows[0], 'destroy-requested');
  let cancelled = false; const cancelling = send(bridge, id, 'DELETE').then(value => { cancelled = true; return value; });
  await destroyRequested;
  assert.equal(cancelled, false); assert.equal(f.sessions[0].cleared, false);
  f.windows[0].finishDestroy();
  assert.equal((await cancelling).status, 204); assert.equal((await reading).status, 409);
  assert.equal(f.sessions[0].cleared, true); assert.equal(bridge.activeWindowCount, 0);
});

test('DELETE during a partial POST body prevents later window creation', async context => {
  const f = fixture(context); const bridge = await f.start(); const id = identity();
  const body = JSON.stringify({ requestId: id.requestId, url: 'https://example.invalid/page', maxDomBytes: 1024, timeoutMs: 1000 });
  const request = http.request(bridge.url, { method: 'POST', headers: { ...headers(bridge, id), 'content-length': Buffer.byteLength(body) } });
  const response = new Promise((resolve, reject) => { request.on('response', value => { value.resume(); value.on('end', () => resolve(value.statusCode)); }); request.on('error', reject); });
  request.write(body.slice(0, 10));
  assert.equal((await send(bridge, id, 'DELETE')).status, 204);
  request.end(body.slice(10)); assert.equal(await response, 409); assert.equal(f.windows.length, 0);
});

test('socket cancellation and stop dispose owned windows and private sessions', async context => {
  const f = fixture(context, { load: () => new Promise(() => {}) }); const bridge = await f.start();
  const created = once(f.created, 'created'); const controller = new AbortController(); const id = identity();
  const reading = fetch(bridge.url, { method: 'POST', headers: headers(bridge, id), body: JSON.stringify({ requestId: id.requestId, url: 'https://example.invalid/', maxDomBytes: 1024, timeoutMs: 1000 }), signal: controller.signal }).catch(() => undefined);
  await created; const cleared = once(f.sessions[0], 'cleared');
  controller.abort(); await reading; await cleared;
  assert.equal(f.windows[0].destroyed, true);
  await bridge.stop();
  assert.equal(f.windows.every(window => window.destroyed), true); assert.equal(f.sessions.every(value => value.cleared), true); assert.equal(bridge.activeWindowCount, 0);
});

test('timeout and forbidden redirects destroy the renderer before responding', async context => {
  const f = fixture(context, { load: () => new Promise(() => {}) }); const bridge = await f.start();
  const timed = await send(bridge, identity(), 'POST', { timeoutMs: 1 }); assert.equal(timed.status, 408); await timed.text();
  assert.equal(f.windows[0].destroyed, true);
  const created = once(f.created, 'created'); const reading = send(bridge, identity()); await created;
  let prevented = false; f.windows[1].webContents.emit('will-redirect', { preventDefault() { prevented = true; } }, 'file:///private/file');
  assert.equal((await reading).status, 400); assert.equal(prevented, true); assert.equal(f.windows[1].destroyed, true);
});
