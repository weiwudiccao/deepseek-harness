/** Run the real desktop DOM bridge through the shared authenticated DSH/SEA smoke. */
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { isAbsolute, join } = require('node:path');
const { promisify } = require('node:util');
const { app, BrowserWindow, session } = require('electron');
const argumentsList = process.argv.slice(2);
const moduleIndex = argumentsList.indexOf('--browserModule');
const modulePath = moduleIndex < 0 ? undefined : argumentsList[moduleIndex + 1];
if (moduleIndex >= 0) {
  assert.ok(modulePath && isAbsolute(modulePath), '--browserModule must be an absolute source or ASAR module path');
  argumentsList.splice(moduleIndex, 2);
}
const { startBrowserTestServer } = require(modulePath ?? '../src/browser-test-support.cjs');

let child;
let bridge;
const scratch = process.env.QIFU_BROWSER_ACCEPTANCE_ROOT;
assert.ok(scratch && isAbsolute(scratch), 'The Node parent must provide a private acceptance root');
app.setPath('userData', scratch);
app.setPath('sessionData', scratch);
app.setName('Qifu Browser Runtime Acceptance');
const phase = message => process.stderr.write(`[electron-browser-acceptance] ${message}\n`);
let slowPage;
const sockets = new Set();
const windows = new Set();
const destroyedWindows = new Set();
const privateSessions = new Set();
let expectedCancellationWindow;
let report;
let failed = false;
let exiting;
const deadline = setTimeout(() => { failed = true; void finish(new Error('Electron browser acceptance exceeded 150 seconds')); }, 150_000);
const childDone = () => child?.pid === undefined || child.exitCode !== null || child.signalCode !== null;
async function stopChild() {
  if (childDone()) return;
  const closed = once(child, 'close');
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10_000, windowsHide: true });
    await closed;
    return;
  }
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function finish(error) {
  if (error) { process.stderr.write(`${error.stack ?? error}\n`); failed = true; }
  exiting ??= (async () => {
    clearTimeout(deadline);
    const cleanupDeadline = setTimeout(() => { process.stderr.write('Electron browser cleanup exceeded 20 seconds\n'); app.exit(1); }, 20_000);
    try {
      phase('stop-harness'); await stopChild();
      phase('stop-browser-bridge'); await bridge?.stop();
      for (const socket of sockets) socket.destroy();
      if (slowPage?.listening) await new Promise(resolve => slowPage.close(resolve));
      assert.equal([...windows].every(window => window.isDestroyed()), true);
      assert.equal(destroyedWindows.size, windows.size);
      assert.equal(bridge?.activeWindowCount ?? 0, 0);
      for (const value of privateSessions) {
        assert.equal(value.getStoragePath(), null);
        assert.deepEqual(await value.cookies.get({}), []);
      }
      if (!failed) process.stdout.write(`${JSON.stringify({ ...report, isolatedWindowsCreated: windows.size, isolatedWindowsDestroyed: destroyedWindows.size, privateSessionsNonPersistent: true, privateSessionCookiesCleared: true, remainingOwnedWindows: 0 })}\n`);
    } catch (cleanupError) { process.stderr.write(`${cleanupError.stack ?? cleanupError}\n`); failed = true; }
    finally { clearTimeout(cleanupDeadline); phase('exit-electron'); app.exit(failed ? 1 : 0); }
  })();
  return exiting;
}
process.once('SIGINT', () => { failed = true; void finish(new Error('Electron browser acceptance interrupted')); });
process.once('SIGTERM', () => { failed = true; void finish(new Error('Electron browser acceptance interrupted')); });
app.on('window-all-closed', () => {}); // The fixture owns app exit after its background windows are destroyed.

void (async () => {
  phase('await-ready');
  await app.whenReady();
  phase('ready');
  class TrackedWindow {
    constructor(options) {
      assert.equal(options.webPreferences.sandbox, true);
      assert.equal(options.webPreferences.disableDialogs, true);
      assert.equal(options.webPreferences.nodeIntegration, false);
      assert.equal(options.focusable, false);
      assert.equal(options.webPreferences.focusOnNavigation, false);
      const window = new BrowserWindow(options);
      assert.equal(window.isVisible(), false);
      windows.add(window);
      window.webContents.once('destroyed', () => destroyedWindows.add(window));
      if (expectedCancellationWindow) { expectedCancellationWindow(window); expectedCancellationWindow = undefined; }
      return window;
    }
  }
  phase('start-browser-bridge');
  bridge = await startBrowserTestServer({ BrowserWindow: TrackedWindow, session: { fromPartition(partition, options) {
    assert.equal(partition.startsWith('persist:'), false);
    const value = session.fromPartition(partition, options); privateSessions.add(value); return value;
  } }, timeoutMs: 30_000, maxDomBytes: 1024 * 1024, maxConcurrentOperations: 2 });
  slowPage = createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(Object.keys(request.headers).some(name => name.startsWith('x-qifu-')), false);
    response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'qifu_browser_cancel=owned; SameSite=Lax' });
    response.write('<html><body>Owned incomplete page');
  });
  slowPage.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => slowPage.listen(0, '127.0.0.1', resolve));
  const id = randomUUID(); const createdAt = Date.now();
  const headers = { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json', 'x-qifu-browser-request-id': id, 'x-qifu-browser-created-at': String(createdAt) };
  const created = new Promise(resolve => { expectedCancellationWindow = resolve; });
  const pending = fetch(bridge.url, { method: 'POST', headers, body: JSON.stringify({ requestId: id, url: `http://127.0.0.1:${slowPage.address().port}/`, timeoutMs: 10_000, maxDomBytes: 1024 }) });
  await created; phase('cancel-window-created');
  const cancelled = await fetch(bridge.url, { method: 'DELETE', headers, body: JSON.stringify({ requestId: id }) });
  phase('cancel-acknowledged');
  assert.equal(cancelled.status, 204); assert.equal((await pending).status, 409); assert.equal(bridge.activeWindowCount, 0);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|DEEPSEEK|NODE_OPTIONS/iu.test(name)));
  phase('start-dsh-harness');
  child = spawn(process.execPath, [join(__dirname, 'check-browser-runtime.mjs'), ...argumentsList], {
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1', QIFUAI_BROWSER_TEST_URL: bridge.url, QIFUAI_BROWSER_TEST_TOKEN: bridge.token },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = ''; let stderr = '';
  child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-65_536); });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-65_536); process.stderr.write(chunk); });
  const [code, signal] = await once(child, 'close');
  phase('dsh-harness-closed');
  assert.equal(signal, null, stderr); assert.equal(code, 0, stderr);
  report = JSON.parse(output.trim().split('\n').at(-1));
  assert.equal(report.domMarker, true); assert.equal(report.directLaunchRefused, true); assert.equal(report.pageTransportHeadersAbsent, true);
  assert.ok(windows.size >= 2);
  await finish();
})().catch(error => finish(error));
