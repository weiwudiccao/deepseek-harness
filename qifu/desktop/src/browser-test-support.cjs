/** Disposable sandboxed Electron renderers behind an authenticated loopback DOM service. */
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { createServer } = require('node:http');

const REQUEST_MAX_AGE_MS = 30_000;
const BODY_TIMEOUT_MS = 5000;
const RETAIN_REQUEST_MS = 60_000;
const MAX_REQUEST_RECORDS = 256;
const MAX_BODY_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function failure(status, message) { return Object.assign(new Error(message), { status }); }
function pageUrl(value) {
  if (typeof value !== 'string') throw failure(400, 'An HTTP or HTTPS page URL is required.');
  let parsed;
  try { parsed = new URL(value); } catch { throw failure(400, 'The page URL is invalid.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw failure(400, 'Only HTTP or HTTPS pages without credentials are allowed.');
  return parsed.href;
}
function fresh(createdAt) {
  const age = Date.now() - createdAt;
  if (age < -1000 || age > REQUEST_MAX_AGE_MS) throw failure(400, 'The browser request has expired.');
}
function integer(value, ceiling) { return Number.isSafeInteger(value) && value >= 1 && value <= ceiling; }
function body(request, signal) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0; let finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true;
      clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('aborted', aborted); request.off('error', failed); signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(value);
    };
    const data = chunk => { bytes += chunk.length; if (bytes > MAX_BODY_BYTES) { finish(failure(413, 'The browser request body is too large.')); request.resume(); } else chunks.push(chunk); };
    const end = () => { try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(failure(400, 'The browser request body must be JSON.')); } };
    const aborted = () => finish(failure(409, 'The browser request was cancelled.'));
    const failed = () => finish(failure(400, 'The browser request body was interrupted.'));
    const timer = setTimeout(() => { finish(failure(408, 'The browser request body timed out.')); request.resume(); }, BODY_TIMEOUT_MS);
    request.on('data', data); request.once('end', end); request.once('aborted', aborted); request.once('error', failed); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
function destroyed(emitter, event, isDestroyed) {
  if (isDestroyed()) return Promise.resolve();
  return new Promise(resolve => emitter.once(event, resolve));
}
function domScript(maxBytes) {
  return `(() => { const raw = document.documentElement?.outerHTML ?? ''; const prefix = raw.slice(0, ${maxBytes + 1}); const encoded = new TextEncoder().encode(prefix); let end = Math.min(encoded.length, ${maxBytes}); while (end < encoded.length && (encoded[end] & 192) === 128) end--; return { dom: new TextDecoder().decode(encoded.slice(0, end)), domTruncated: raw.length > prefix.length || end < encoded.length }; })()`;
}

/**
 * Start the desktop-only DOM reader; every request owns a fresh in-memory session.
 * @param options Electron APIs and deployment ceilings; caller limits may only narrow them.
 * @returns Loopback URL, private bearer token, active-window count and quiescent stop operation.
 */
async function startBrowserTestServer({ BrowserWindow, session, timeoutMs, maxDomBytes, maxConcurrentOperations }) {
  if (!integer(timeoutMs, 30_000) || !integer(maxDomBytes, 1024 * 1024) || !integer(maxConcurrentOperations, 2)) throw new Error('Invalid desktop browser limits.');
  const token = randomBytes(32).toString('base64url');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const records = new Map(); const windows = new Set(); const sockets = new Set();
  let stopped = false; let stopping;
  const sweep = () => {
    for (const [id, entry] of records) if (!entry.active && entry.expiresAt <= Date.now()) records.delete(id);
  };
  const reserve = (id, createdAt) => {
    sweep();
    if (records.size >= MAX_REQUEST_RECORDS) throw failure(503, 'The browser request registry is full.');
    const entry = { id, createdAt, expiresAt: Date.now() + RETAIN_REQUEST_MS, active: false, controller: new AbortController(), window: undefined, session: undefined, cleanup: undefined, task: undefined };
    records.set(id, entry); return entry;
  };
  const cleanup = entry => {
    entry.cleanup ??= (async () => {
      const window = entry.window;
      if (window) {
        const closed = destroyed(window, 'closed', () => window.isDestroyed());
        const contentsDestroyed = destroyed(window.webContents, 'destroyed', () => window.webContents.isDestroyed());
        if (!window.isDestroyed()) window.destroy();
        await Promise.all([closed, contentsDestroyed]); windows.delete(window);
      }
      if (entry.session) { await entry.session.clearStorageData(); await entry.session.clearCache(); }
    })();
    return entry.cleanup;
  };
  const cancel = (entry, reason = failure(409, 'The browser request was cancelled.')) => {
    entry.controller.abort(reason);
    return cleanup(entry);
  };
  const readDom = async (entry, input) => {
    const signal = entry.controller.signal;
    signal.throwIfAborted();
    entry.session = session.fromPartition(`qifu-browser-test-${randomUUID()}`, { cache: false });
    entry.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    entry.session.setPermissionCheckHandler(() => false);
    entry.session.setDevicePermissionHandler(() => false);
    entry.session.on('will-download', event => event.preventDefault());
    const window = new BrowserWindow({ show: false, focusable: false, webPreferences: { session: entry.session, offscreen: true, focusOnNavigation: false, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, sandbox: true, contextIsolation: true, webSecurity: true, disableDialogs: true, devTools: false } });
    entry.window = window; windows.add(window);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('login', (event, _details, _auth, callback) => { event.preventDefault(); callback(); });
    window.webContents.on('select-client-certificate', (event, _url, _certificates, callback) => { event.preventDefault(); callback(); });
    const navigation = (event, target) => {
      try { pageUrl(typeof target === 'string' ? target : event.url); }
      catch { event.preventDefault(); void cancel(entry, failure(400, 'The page attempted a forbidden navigation.')).catch(() => undefined); }
    };
    window.webContents.on('will-navigate', navigation);
    window.webContents.on('will-frame-navigate', navigation);
    window.webContents.on('will-redirect', navigation);
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { void cancel(entry, failure(408, 'The browser page timed out.')).catch(() => undefined); }, input.timeoutMs);
    try {
      await Promise.race([window.loadURL(input.url), aborted]); signal.throwIfAborted();
      const result = await Promise.race([window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: domScript(input.maxDomBytes) }]), aborted]);
      signal.throwIfAborted();
      if (!result || typeof result.dom !== 'string' || typeof result.domTruncated !== 'boolean' || Buffer.byteLength(result.dom) > input.maxDomBytes) throw failure(500, 'The renderer returned invalid DOM fields.');
      return { url: input.url, dom: result.dom, domTruncated: result.domTruncated };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  };
  const reply = (response, status, value) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(value === undefined ? undefined : JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (stopped) throw failure(503, 'The browser service is stopping.');
      const authorization = Buffer.from(typeof request.headers.authorization === 'string' ? request.headers.authorization : '');
      if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) throw failure(401, 'Browser authentication is required.');
      if (request.url !== '/qifu-browser-test' || !['POST', 'DELETE'].includes(request.method)) throw failure(404, 'The browser endpoint was not found.');
      if (request.headers['content-type'] !== 'application/json') throw failure(400, 'The browser request requires JSON.');
      const id = request.headers['x-qifu-browser-request-id']; const timestamp = request.headers['x-qifu-browser-created-at'];
      if (typeof id !== 'string' || !UUID.test(id) || typeof timestamp !== 'string' || !/^\d{13}$/u.test(timestamp)) throw failure(400, 'The browser request identity is invalid.');
      const createdAt = Number(timestamp);
      if (request.method === 'DELETE') {
        const input = await body(request, new AbortController().signal);
        if (!input || Object.keys(input).length !== 1 || input.requestId !== id) throw failure(400, 'The cancellation request is invalid.');
        const entry = records.get(id) ?? reserve(id, createdAt);
        await cancel(entry); reply(response, 204); return;
      }
      fresh(createdAt); sweep();
      if (records.has(id)) throw failure(409, 'The browser request was already used or cancelled.');
      if ([...records.values()].filter(entry => entry.active).length >= maxConcurrentOperations) throw failure(429, 'The browser service is busy.');
      const entry = reserve(id, createdAt); entry.active = true;
      response.once('close', () => { if (!response.writableEnded) void cancel(entry).catch(() => undefined); });
      entry.task = (async () => {
        try {
          const input = await body(request, entry.controller.signal);
          fresh(createdAt); entry.controller.signal.throwIfAborted();
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'maxDomBytes,requestId,timeoutMs,url' || input.requestId !== id || !integer(input.timeoutMs, timeoutMs) || !integer(input.maxDomBytes, maxDomBytes)) throw failure(400, 'The browser request fields are invalid.');
          input.url = pageUrl(input.url);
          const result = await readDom(entry, input);
          await cleanup(entry); entry.controller.signal.throwIfAborted(); reply(response, 200, result);
        } catch (error) {
          await cleanup(entry); reply(response, error.status ?? 500, { error: error.status ? error.message : 'The isolated browser could not read the page.' });
        } finally { entry.active = false; entry.expiresAt = Date.now() + RETAIN_REQUEST_MS; }
      })();
      await entry.task;
    })().catch(error => { request.resume(); reply(response, error.status ?? 500, { error: error.status ? error.message : 'The isolated browser request failed.' }); });
  });
  server.maxConnections = 64;
  server.headersTimeout = BODY_TIMEOUT_MS;
  server.requestTimeout = BODY_TIMEOUT_MS;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/qifu-browser-test`, token,
    get activeWindowCount() { return windows.size; },
    stop() {
      stopping ??= (async () => {
        stopped = true;
        const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        const results = await Promise.allSettled([...records.values()].map(async entry => { await cancel(entry); await entry.task; }));
        for (const socket of sockets) socket.destroy();
        await closed;
        records.clear();
        const errors = results.filter(value => value.status === 'rejected').map(value => value.reason);
        if (errors.length) throw new AggregateError(errors, 'The isolated browser could not finish cleanup.');
      })();
      return stopping;
    },
  };
}
module.exports = { startBrowserTestServer };
