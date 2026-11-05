const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  createLocalRuntimeOwner,
  ensureEmployeeLocalWorkspace,
  ensureLocalWebProfile,
  exchangeDshToken,
  localRuntimeCookie,
  pickLocalDirectory,
  validateRuntimeOrigin,
} = require('./local-runtime-support.cjs');

const { startBrowserTestServer } = require('./browser-test-support.cjs');

const PRODUCTION_GATEWAY_URL = 'https://47.106.208.2:3443';
const PRODUCTION_GATEWAY_CERT_SHA256 = 'SHA256/VO2JrTSIZg0T9sCJSOlB0jcMWjyp5yOIsVRTl4hIqlA=';
const GATEWAY_URL = !app.isPackaged && process.env.QIFUAI_GATEWAY_URL
  ? process.env.QIFUAI_GATEWAY_URL
  : PRODUCTION_GATEWAY_URL;
const GATEWAY_ORIGIN = new URL(GATEWAY_URL).origin;
const GATEWAY_HOSTNAME = new URL(GATEWAY_URL).hostname;
const GATEWAY_CERT_SHA256 = !app.isPackaged && process.env.QIFUAI_GATEWAY_CERT_SHA256
  ? process.env.QIFUAI_GATEWAY_CERT_SHA256
  : PRODUCTION_GATEWAY_CERT_SHA256;
const GATEWAY_SESSION_COOKIE = 'qifuai_gateway_session';
const READY_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/)\?token=([A-Za-z0-9_-]+)/u;
const MAX_STARTUP_OUTPUT = 64 * 1024;
const MAX_SYNC_BYTES = 25 * 1024 * 1024;
const LOCAL_WORKSPACE_DIRECTORY = 'local-workspace';
const GATEWAY_ROUTES = new Map([
  ['GET /auth/session', true],
  ['GET /qifu/v1/bootstrap', true],
  ['GET /qifu/v1/cloud/workspaces', true],
  ['GET /qifu/v1/cloud/items', true],
  ['GET /qifu/v1/cloud/item', true],
  ['GET /qifu/v1/cloud/item/versions', true],
  ['GET /qifu/v1/personalization', true],
  ['POST /qifu/v1/cloud/item/download', true],
  ['POST /qifu/v1/cloud/transfers/start', true],
  ['POST /qifu/v1/cloud/transfers/part', true],
  ['POST /qifu/v1/cloud/transfers/commit', true],
  ['POST /qifu/v1/cloud/transfers/cancel', true],
  ['POST /qifu/v1/personalization', true],
  ['POST /qifu/v1/personalization/memory/confirm', true],
  ['POST /qifu/v1/personalization/memory/forget', true],
  ['POST /qifu/v1/personalization/context', true],
]);

let mainWindow;
let browserTestBridge;
let browserTestStartup;
let loggingIn = false;
let runtimeMode = 'cloud';
const localRuntimeOwner = createLocalRuntimeOwner({
  authorize: authorizeLocalRuntime,
  launch: launchLocalRuntime,
  onExit: () => {
    if (runtimeMode === 'local') void showLogin('本机运行时已停止，请重新登录。');
  },
});

function accountPath() {
  return path.join(app.getPath('userData'), 'employee-login.json');
}

function legacyCredentialsPath() {
  return path.join(app.getPath('userData'), 'server-credentials.json');
}

function devicePath() {
  return path.join(app.getPath('userData'), 'device.json');
}

function readSavedAccount() {
  try {
    const record = JSON.parse(fs.readFileSync(accountPath(), 'utf8'));
    return record.version === 1 && typeof record.account === 'string' ? record.account : '';
  } catch {
    return '';
  }
}

function saveAccount(account) {
  const target = accountPath();
  const temporary = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, account })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function deviceId() {
  try {
    const record = JSON.parse(fs.readFileSync(devicePath(), 'utf8'));
    if (record.version === 1 && typeof record.id === 'string' && record.id !== '') return record.id;
  } catch {
    // A missing or invalid local device record is replaced atomically below.
  }
  const target = devicePath();
  const temporary = `${target}.tmp`;
  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, id })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return id;
}

function forgetAccount() {
  try { fs.unlinkSync(accountPath()); } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

function forgetLegacySshPassword() {
  try { fs.unlinkSync(legacyCredentialsPath()); } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().startsWith('sha256/') ? `SHA256/${value.slice(7)}` : value;
}

function isLoginSender(event) {
  return event.senderFrame && event.senderFrame.url.startsWith('file://');
}

function isAppSender(event) {
  if (!event.senderFrame) return false;
  try {
    const origin = new URL(event.senderFrame.url).origin;
    return origin === GATEWAY_ORIGIN || origin === localRuntimeOwner.current?.origin.origin;
  } catch {
    return false;
  }
}

function assertLoginSender(event) {
  if (!isLoginSender(event)) throw new Error('该操作只能从本地登录页面调用');
}

function assertAppSender(event) {
  if (!isAppSender(event)) throw new Error('该操作只能从企福AI智脑页面调用');
}

function sendStatus(window, kind, message) {
  if (window && mainWindow === window && !window.isDestroyed()) window.webContents.send('desktop:status', { kind, message });
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/certificate|CERT_/i.test(message)) return '无法验证企福AI智脑网关证书，请联系管理员。';
  if (/ETIMEDOUT|Timed out|timeout/i.test(message)) return '连接企福AI智脑网关超时，请检查当前网络。';
  if (/ECONNREFUSED|fetch failed/i.test(message)) return '企福AI智脑网关暂时不可用，请稍后重试。';
  return message || '操作失败，请稍后重试。';
}

async function responseMessage(response, fallback) {
  try {
    const value = await response.json();
    return value && typeof value.message === 'string' ? value.message : fallback;
  } catch {
    return fallback;
  }
}

async function showLogin(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const options = message ? { query: { error: message } } : undefined;
  await mainWindow.loadFile(path.join(__dirname, 'login.html'), options);
}

async function gatewayFetch(route, init = {}) {
  return session.defaultSession.fetch(`${GATEWAY_URL}${route}`, {
    method: init.method || 'GET',
    headers: init.body === undefined ? { accept: 'application/json' } : {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    credentials: 'include',
    cache: 'no-store',
  });
}

async function gatewayJson(route, init = {}) {
  const response = await gatewayFetch(route, init);
  const body = await response.json().catch(() => ({ ok: false, message: '服务器响应格式不正确。' }));
  if (!response.ok) {
    const error = new Error(body && typeof body.message === 'string' ? body.message : `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function loginEmployee(account, password, remember) {
  if (loggingIn) return { ok: false, message: '登录正在进行，请稍候。' };
  if (typeof account !== 'string' || account.trim().length === 0) return { ok: false, message: '请输入员工账号。' };
  if (typeof password !== 'string' || password.length === 0) return { ok: false, message: '请输入登录密码。' };
  const window = mainWindow;
  loggingIn = true;
  sendStatus(window, 'working', '正在使用正式 OA 验证员工身份…');
  try {
    const response = await gatewayFetch('/auth/login', {
      method: 'POST',
      body: { account: account.trim(), password },
    });
    if (!response.ok) return { ok: false, message: await responseMessage(response, '员工账号或密码不正确。') };
    if (mainWindow !== window || window.isDestroyed()) return { ok: false, message: '登录窗口已关闭，请在当前窗口重新登录。' };
    await localRuntimeOwner.retire();
    await gatewayJson('/auth/session');
    if (mainWindow !== window || window.isDestroyed()) return { ok: false, message: '登录窗口已关闭，请在当前窗口重新登录。' };
    if (remember) saveAccount(account.trim()); else forgetAccount();
    sendStatus(window, 'working', '身份验证成功，正在进入企福AI智脑…');
    setTimeout(async () => {
      if (mainWindow === window && !window.isDestroyed()) {
        try {
          await switchRuntime('local');
        } catch (error) {
          sendStatus(window, 'error', friendlyError(error));
        }
      }
    }, 120);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: friendlyError(error) };
  } finally {
    loggingIn = false;
  }
}

function isAllowedNavigation(value) {
  if (value.startsWith('file://')) return true;
  try {
    const origin = new URL(value).origin;
    return origin === GATEWAY_ORIGIN || origin === localRuntimeOwner.current?.origin.origin;
  } catch {
    return false;
  }
}

function configureGatewayCertificate() {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.hostname !== GATEWAY_HOSTNAME) {
      callback(-3);
      return;
    }
    callback(normalizeFingerprint(request.certificate.fingerprint) === GATEWAY_CERT_SHA256 ? 0 : -2);
  });
}

function runtimePaths() {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'dsh-runtime')
    : (process.env.QIFUAI_DSH_ROOT || path.join(__dirname, '..', 'resources', 'dsh-runtime'));
  const runtimeName = process.platform === 'win32'
    ? 'deepseek-harness-sdk-runtime-win-x64.exe'
    : 'deepseek-harness-sdk-runtime-macos-arm64';
  return {
    root,
    cli: process.env.QIFUAI_DSH_CLI || path.join(root, runtimeName),
    certificate: app.isPackaged
      ? path.join(process.resourcesPath, 'certs', 'qifu-gateway.pem')
      : (process.env.QIFUAI_GATEWAY_CA || path.join(__dirname, '..', 'resources', 'certs', 'qifu-gateway.pem')),
  };
}

async function gatewaySessionToken() {
  const cookies = await session.defaultSession.cookies.get({ url: GATEWAY_URL, name: GATEWAY_SESSION_COOKIE });
  const token = cookies[0]?.value;
  if (!token) throw new Error('登录已失效，请重新登录。');
  return token;
}

async function authorizeLocalRuntime() {
  const previousToken = await gatewaySessionToken();
  const identity = await gatewayJson('/auth/session');
  const token = await gatewaySessionToken();
  if (previousToken !== token) throw new Error('本机登录状态已更新，请重新进入本机内容。');
  const user = typeof identity.user === 'string' ? identity.user : identity.employee?.id;
  if (typeof user !== 'string' || user === '') throw new Error('员工身份信息不完整。');
  return { user, token };
}

function launchLocalRuntime({ user, token }, signal) {
  signal.throwIfAborted();
  if (!browserTestBridge) throw new Error('本机浏览器组件尚未就绪。');
  const storageKey = crypto.createHash('sha256').update(user).digest('hex');
  const dataRoot = path.join(app.getPath('userData'), 'local-runtime', storageKey);
  const { root, cli, certificate } = runtimePaths();
  if (!fs.existsSync(cli)) throw new Error('本机运行时组件缺失，请重新安装客户端。');
  if (!fs.existsSync(certificate)) throw new Error('网关证书组件缺失，请重新安装客户端。');
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const localWorkspace = path.join(dataRoot, LOCAL_WORKSPACE_DIRECTORY);
  fs.mkdirSync(localWorkspace, { recursive: true, mode: 0o700 });
  const dshHome = path.join(dataRoot, '.dsh');
  ensureLocalWebProfile(dshHome);
  const child = spawn(cli, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: localWorkspace,
    env: {
      ...process.env,
      CI: 'true',
      NODE_ENV: 'production',
      DSH_HOME: dshHome,
      DEEPSEEK_API_KEY: token,
      DEEPSEEK_BASE_URL: `${GATEWAY_URL}/qifu-model/v1`,
      DEEPSEEK_SEARCH_BASE_URL: `${GATEWAY_URL}/qifu-model/v1`,
      NODE_EXTRA_CA_CERTS: certificate,
      QIFUAI_DSH_ROOT: root,
      QIFUAI_CONTEXT_URL: `${GATEWAY_URL}/qifu/v1/personalization/context`,
      QIFUAI_CONTEXT_TOKEN: token,
      QIFUAI_CONTEXT_LOCAL: 'true',
      QIFUAI_OFFICE_ENABLED: 'true',
      QIFUAI_BROWSER_TEST_ENABLED: 'true',
      QIFUAI_BROWSER_TEST_URL: browserTestBridge.url,
      QIFUAI_BROWSER_TEST_TOKEN: browserTestBridge.token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let initializing = false;
    const timeout = setTimeout(() => fail(new Error('本机运行时启动超时。')), 30_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('error', fail);
      signal.removeEventListener('abort', aborted);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const aborted = () => fail(signal.reason);
    const onData = (chunk) => {
      if (settled) return;
      output = `${output}${String(chunk)}`.slice(-MAX_STARTUP_OUTPUT);
      const match = READY_PATTERN.exec(output);
      if (!match || initializing) return;
      initializing = true;
      let origin;
      try {
        origin = validateRuntimeOrigin(match[1]);
      } catch (error) {
        fail(error);
        return;
      }
      void (async () => {
        const cookie = await exchangeDshToken(origin, match[2]);
        signal.throwIfAborted();
        await ensureEmployeeLocalWorkspace(origin, cookie, localWorkspace);
        signal.throwIfAborted();
        await session.defaultSession.cookies.set(localRuntimeCookie(origin, cookie));
        signal.throwIfAborted();
        if (settled) return;
        settled = true;
        output = '';
        cleanup();
        child.stdout.resume();
        child.stderr.resume();
        resolve({ child, origin });
      })().catch(fail);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', fail);
    signal.addEventListener('abort', aborted, { once: true });
    child.once('exit', (code, signal) => {
      if (!settled) fail(new Error(`本机运行时启动失败（${String(code ?? signal)}）。`));
    });
  });
  return { child, ready };
}

async function switchRuntime(target) {
  if (target !== 'local' && target !== 'cloud') throw new Error('运行区域不正确。');
  const window = mainWindow;
  if (!window || window.isDestroyed()) return { ok: false };
  if (target === 'cloud') {
    runtimeMode = 'cloud';
    await window.loadURL(GATEWAY_URL);
    return { ok: true };
  }
  const runtime = await localRuntimeOwner.get();
  if (mainWindow !== window || window.isDestroyed() || localRuntimeOwner.current !== runtime) {
    throw new Error('本机登录状态已更新，请重新进入本机内容。');
  }
  runtimeMode = 'local';
  await window.loadURL(runtime.origin.href);
  return { ok: true };
}

async function uploadArtifact({ sourceKind, sourceId, sourceTitle, contentType, content }) {
  if (!Buffer.isBuffer(content) || content.length > MAX_SYNC_BYTES) throw new Error('单次同步内容不能超过 25 MiB。');
  const workspaces = await gatewayJson('/qifu/v1/cloud/workspaces');
  const workspaceId = workspaces.items?.[0]?.id;
  if (typeof workspaceId !== 'string') throw new Error('云端工作区不可用。');
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  const id = deviceId();
  const started = await gatewayJson('/qifu/v1/cloud/transfers/start', {
    method: 'POST',
    body: {
      workspace_id: workspaceId,
      direction: 'Publish',
      source_kind: sourceKind,
      source_id: sourceId,
      source_title: sourceTitle,
      content_type: contentType,
      content_size: content.length,
      content_digest: digest,
      device_id: id,
      idempotency_key: crypto.createHash('sha256').update(`${id}\0${sourceKind}\0${sourceId}\0${digest}`).digest('hex'),
    },
  });
  const transfer = started.transfer;
  if (!transfer || typeof transfer.id !== 'string' || !Number.isSafeInteger(transfer.part_size)) {
    throw new Error('云端传输初始化失败。');
  }
  for (let partNo = 0; partNo < transfer.part_count; partNo += 1) {
    const part = content.subarray(partNo * transfer.part_size, (partNo + 1) * transfer.part_size);
    await gatewayJson('/qifu/v1/cloud/transfers/part', {
      method: 'POST',
      body: {
        transfer_id: transfer.id,
        part_no: partNo,
        part_digest: crypto.createHash('sha256').update(part).digest('hex'),
        content_base64: part.toString('base64'),
      },
    });
  }
  return gatewayJson('/qifu/v1/cloud/transfers/commit', {
    method: 'POST',
    body: { transfer_id: transfer.id },
  });
}

async function syncFile() {
  const selection = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
  if (selection.canceled || selection.filePaths.length !== 1) return { ok: false, cancelled: true };
  const file = selection.filePaths[0];
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_SYNC_BYTES) throw new Error('请选择不超过 25 MiB 的单个文件。');
  await uploadArtifact({
    sourceKind: 'File',
    sourceId: crypto.createHash('sha256').update(file).digest('hex'),
    sourceTitle: path.basename(file),
    contentType: 'application/octet-stream',
    content: fs.readFileSync(file),
  });
  return { ok: true, message: '文件已同步到我的云端工作。' };
}

async function syncSession(sessionId, title) {
  const localRuntime = localRuntimeOwner.current;
  if (runtimeMode !== 'local' || !localRuntime) throw new Error('请先进入本机内容并打开一个会话。');
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('请先选择需要同步的本机会话。');
  const exportUrl = new URL('/api/session.export', localRuntime.origin);
  exportUrl.searchParams.set('sessionId', sessionId);
  exportUrl.searchParams.set('includeDescendants', 'true');
  const response = await session.defaultSession.fetch(exportUrl.href, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error('本机会话导出失败，请确认会话已保存。');
  const content = Buffer.from(await response.arrayBuffer());
  await uploadArtifact({
    sourceKind: 'Session',
    sourceId: sessionId,
    sourceTitle: `${String(title || sessionId).slice(0, 120)}.zip`,
    contentType: 'application/zip',
    content,
  });
  return { ok: true, message: '会话快照已同步到我的云端工作。' };
}

function safeDownloadName(value) {
  const name = path.basename(String(value || 'cloud-content.bin')).replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '_');
  return name.slice(0, 180) || 'cloud-content.bin';
}

async function downloadCloudItem(itemId, title) {
  if (typeof itemId !== 'string' || itemId === '') throw new Error('云端内容标识不正确。');
  const result = await gatewayJson('/qifu/v1/cloud/item/download', {
    method: 'POST',
    body: { item_id: itemId, device_id: deviceId() },
  });
  const download = result?.download;
  if (!download
    || typeof download.content_base64 !== 'string'
    || typeof download.content_digest !== 'string'
    || !Number.isSafeInteger(download.content_size)
    || download.content_size < 0
    || download.content_size > MAX_SYNC_BYTES) {
    throw new Error('云端下载内容格式不正确。');
  }
  const content = Buffer.from(download.content_base64, 'base64');
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  if (content.length !== download.content_size || digest !== download.content_digest) {
    throw new Error('云端下载内容校验失败。');
  }
  const defaultName = safeDownloadName(download.title || title);
  const selection = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('downloads'), defaultName),
  });
  if (selection.canceled || typeof selection.filePath !== 'string') return { ok: false, cancelled: true };
  fs.writeFileSync(selection.filePath, content, { mode: 0o600 });
  return { ok: true, message: `已下载到 ${selection.filePath}` };
}

async function openFeature(feature) {
  const bootstrap = await gatewayJson('/qifu/v1/bootstrap');
  const authorized = Array.isArray(bootstrap.features)
    ? bootstrap.features.find(item => item.feature_code === feature?.feature_code)
    : undefined;
  if (!authorized || typeof authorized.route !== 'string') throw new Error('该功能当前不可用。');
  const target = URL.canParse(authorized.route)
    ? new URL(authorized.route)
    : new URL(authorized.route, 'https://oa.qifuyunai.cn');
  if (target.protocol !== 'https:' || (target.hostname !== 'qifuyunai.cn' && !target.hostname.endsWith('.qifuyunai.cn'))) {
    throw new Error('该功能地址未通过安全校验。');
  }
  await shell.openExternal(target.href);
  return { ok: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: '企福AI智脑',
    backgroundColor: '#0e1014',
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) void mainWindow.loadURL(url);
    else void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

ipcMain.handle('desktop:initial-state', (event) => {
  assertLoginSender(event);
  return { savedAccount: readSavedAccount() };
});

ipcMain.handle('desktop:login', async (event, input) => {
  assertLoginSender(event);
  return loginEmployee(input && input.account, input && input.password, Boolean(input && input.remember));
});

ipcMain.handle('desktop:gateway-request', async (event, input) => {
  assertAppSender(event);
  const method = input?.method === 'POST' ? 'POST' : 'GET';
  const url = new URL(String(input?.path || ''), GATEWAY_URL);
  if (url.origin !== GATEWAY_ORIGIN || !GATEWAY_ROUTES.has(`${method} ${url.pathname}`)) {
    throw new Error('网关接口不在客户端允许范围内。');
  }
  const response = await gatewayFetch(`${url.pathname}${url.search}`, { method, body: input?.body });
  return { status: response.status, body: await response.json().catch(() => null) };
});

ipcMain.handle('desktop:runtime-info', (event) => {
  assertAppSender(event);
  return { mode: runtimeMode };
});

ipcMain.handle('desktop:pick-directory', (event) => pickLocalDirectory(
  () => {
    assertAppSender(event);
    return {
      mode: runtimeMode,
      runtimeOrigin: localRuntimeOwner.current?.origin,
      senderUrl: event.senderFrame.url,
    };
  },
  () => dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }),
));

ipcMain.handle('desktop:switch-runtime', async (event, target) => {
  assertAppSender(event);
  try { return await switchRuntime(target); } catch (error) { return { ok: false, message: friendlyError(error) }; }
});

ipcMain.handle('desktop:open-feature', async (event, feature) => {
  assertAppSender(event);
  try { return await openFeature(feature); } catch (error) { return { ok: false, message: error.message }; }
});

ipcMain.handle('desktop:sync-file', async (event) => {
  assertAppSender(event);
  try { return await syncFile(); } catch (error) { return { ok: false, message: error.message }; }
});

ipcMain.handle('desktop:sync-session', async (event, input) => {
  assertAppSender(event);
  try { return await syncSession(input?.sessionId, input?.title); } catch (error) { return { ok: false, message: error.message }; }
});

ipcMain.handle('desktop:download-cloud-item', async (event, input) => {
  assertAppSender(event);
  try {
    return await downloadCloudItem(input?.itemId, input?.title);
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

app.whenReady().then(async () => {
  if (retiringForQuit) return;
  browserTestStartup = startBrowserTestServer({ BrowserWindow, session, timeoutMs: 30_000, maxDomBytes: 1024 * 1024, maxConcurrentOperations: 2 });
  browserTestBridge = await browserTestStartup;
  if (retiringForQuit) return;
  forgetLegacySshPassword();
  configureGatewayCertificate();
  createWindow();
  await showLogin();
}).catch(() => app.exit(1));

app.on('activate', () => {
  if (browserTestBridge && !retiringForQuit && (!mainWindow || mainWindow.isDestroyed())) {
    createWindow();
    void showLogin();
  }
});

let retiringForQuit;
let retiredForQuit = false;
app.on('before-quit', (event) => {
  if (retiredForQuit) return;
  event.preventDefault();
  retiringForQuit ??= (async () => {
    await localRuntimeOwner.retire();
    await browserTestStartup;
    await browserTestBridge?.stop();
    retiredForQuit = true;
    app.quit();
  })().catch(() => app.exit(1));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
