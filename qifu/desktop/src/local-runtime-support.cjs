const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { request: httpRequest } = require('node:http');
const { dirname, isAbsolute, join } = require('node:path');

const LOCAL_WORKSPACE_TITLE = '本机工作区';
const LOOPBACK_RESPONSE_BYTES = 1024 * 1024;
const LOOPBACK_RESPONSE_TIMEOUT_MS = 5000;
const TOKEN_EXCHANGE_ATTEMPTS = 21;
const TOKEN_EXCHANGE_RETRY_DELAY_MS = 50;
const QIFU_CONTEXT_PLUGIN_VERSION = '0.1.2-alpha.3';
const QIFU_CONTEXT_PATCH = `- insert:
    - id: qifu-account-context
      name: '@deepseek-ai/dsh-qifu-account-context'
      config:
        endpointEnv: QIFUAI_CONTEXT_URL
        tokenEnv: QIFUAI_CONTEXT_TOKEN
        localContextEnv: QIFUAI_CONTEXT_LOCAL
        timeoutMs: 5000
        maxResponseBytes: 16384
`;

function writeAtomic(file, content, mode = 0o600) {
  const temporary = `${file}.tmp`;
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, content, { mode });
  fs.renameSync(temporary, file);
}

/** Keep the desktop-owned Web profile on its supported Qifu context composition. */
function ensureLocalWebProfile(home) {
  const profileDir = join(home, 'profiles', 'web');
  const manifestPath = join(profileDir, 'package.json');
  const manifest = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh-qifu-account-context': QIFU_CONTEXT_PLUGIN_VERSION,
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        patchReload: 'startup',
      },
    },
  };
  writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const files = new Map([
    ['cordis.yml', '[]\n'],
    ['pnpm-workspace.yaml', 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'],
  ]);
  for (const [name, content] of files) {
    const file = join(profileDir, name);
    if (!fs.existsSync(file)) writeAtomic(file, content);
  }
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const existingPatch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
  if (existingPatch !== QIFU_CONTEXT_PATCH) writeAtomic(patchPath, QIFU_CONTEXT_PATCH);
}

function validateRuntimeOrigin(value) {
  const origin = value instanceof URL ? value : new URL(value);
  const port = Number(origin.port);
  if (origin.protocol !== 'http:'
    || origin.hostname !== '127.0.0.1'
    || origin.pathname !== '/'
    || origin.search !== ''
    || origin.hash !== ''
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65535) {
    throw new Error('本机运行时返回了不安全的地址。');
  }
  return origin;
}

/** Own one employee/token generation and wait for retired child processes to exit. */
function createLocalRuntimeOwner({ authorize, launch, onExit }) {
  let generation = 0;
  let current;
  let starting;
  let retirement = Promise.resolve();
  const obsolete = () => new Error('本机登录状态已更新，请重新进入本机内容。');
  const alive = child => child.exitCode === null && child.signalCode === null;

  function stop(entry) {
    if (entry === undefined) return Promise.resolve();
    entry.controller.abort(obsolete());
    if (entry.stopping !== undefined) return entry.stopping;
    if (entry.child === undefined || !alive(entry.child)) return Promise.resolve();
    const child = entry.child;
    entry.stopping = new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('exit', exited);
        child.off('error', failed);
      };
      const exited = () => { cleanup(); resolve(); };
      const failed = error => { cleanup(); reject(error); };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (error) { failed(error); }
      }, 5000);
      timer.unref?.();
      child.once('exit', exited);
      child.once('error', failed);
      try { child.kill('SIGTERM'); } catch (error) { failed(error); }
    });
    return entry.stopping;
  }

  async function retire() {
    generation += 1;
    const previous = current;
    const pending = starting;
    current = undefined;
    starting = undefined;
    retirement = Promise.all([retirement, stop(previous), stop(pending)]).then(() => {});
    await retirement;
  }

  async function get() {
    const authorizedGeneration = generation;
    const authorization = await authorize();
    if (authorizedGeneration !== generation) throw obsolete();
    const key = createHash('sha256').update(JSON.stringify([authorization.user, authorization.token])).digest('hex');
    if (current?.key === key && alive(current.child)) return current.runtime;
    if (starting?.key === key) return starting.promise;
    const retired = current !== undefined || starting !== undefined ? retire() : retirement;
    const entry = { key, generation, controller: new AbortController(), child: undefined, promise: undefined };
    starting = entry;
    entry.promise = (async () => {
      try {
        await retired;
        if (starting !== entry || entry.generation !== generation) throw obsolete();
        const launched = launch(authorization, entry.controller.signal);
        entry.child = launched.child;
        const runtime = await launched.ready;
        if (starting !== entry || entry.generation !== generation || entry.controller.signal.aborted) throw obsolete();
        if (!alive(entry.child)) throw new Error('本机运行时在启动完成前已停止。');
        entry.runtime = runtime;
        current = entry;
        starting = undefined;
        entry.child.once('exit', () => {
          if (current !== entry) return;
          current = undefined;
          onExit?.(runtime);
        });
        return runtime;
      } catch (error) {
        const superseded = entry.controller.signal.aborted || entry.generation !== generation;
        await stop(entry);
        throw superseded ? obsolete() : error;
      } finally {
        if (starting === entry) starting = undefined;
      }
    })();
    return entry.promise;
  }

  return {
    get current() { return current?.runtime; },
    get,
    retire,
  };
}

/** Open a local folder dialog only while its caller still belongs to the device runtime. */
async function pickLocalDirectory(readState, showDialog) {
  const authorize = () => {
    const state = readState();
    if (state.mode !== 'local' || state.runtimeOrigin === undefined) {
      throw new Error('请先进入本机内容，再选择工作区。');
    }
    const origin = validateRuntimeOrigin(state.runtimeOrigin);
    if (new URL(state.senderUrl).origin !== origin.origin) {
      throw new Error('该操作只能从当前本机工作区调用。');
    }
  };
  authorize();
  const selection = await showDialog();
  authorize();
  if (selection.canceled || selection.filePaths.length === 0) return null;
  return selection.filePaths[0];
}

function exchangeDshTokenOnce(origin, token, requestImpl) {
  return new Promise((resolve, reject) => {
    const request = requestImpl({
      hostname: origin.hostname,
      port: origin.port,
      method: 'GET',
      path: `/?token=${encodeURIComponent(token)}`,
      headers: { host: origin.host },
    }, (response) => {
      response.resume();
      if (response.statusCode !== 303) {
        reject(new Error(`本机运行时认证失败（HTTP ${String(response.statusCode)}）。`));
        return;
      }
      const values = response.headers['set-cookie'];
      const cookies = Array.isArray(values) ? values : (typeof values === 'string' ? [values] : []);
      const cookie = cookies.map(value => value.split(';', 1)[0]).find(value => value.startsWith('dsh-auth-'));
      if (cookie === undefined) reject(new Error('本机运行时认证未返回会话 Cookie。'));
      else resolve(cookie);
    });
    request.once('error', reject);
    request.end();
  });
}

/** Exchange one process launch token after the announced loopback listener becomes reachable. */
async function exchangeDshToken(origin, token, requestImpl = httpRequest, options = {}) {
  validateRuntimeOrigin(origin);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new Error('本机运行时启动令牌不正确。');
  }
  const attempts = options.attempts ?? TOKEN_EXCHANGE_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? TOKEN_EXCHANGE_RETRY_DELAY_MS;
  const delayImpl = options.delayImpl ?? (delay => new Promise(resolve => setTimeout(resolve, delay)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await exchangeDshTokenOnce(origin, token, requestImpl);
    } catch (error) {
      if (attempt === attempts || (error?.code !== 'ECONNREFUSED' && error?.code !== 'ECONNRESET')) throw error;
      await delayImpl(retryDelayMs);
    }
  }
  throw new Error('本机运行时认证失败。');
}

function localRuntimeCookie(origin, cookie) {
  validateRuntimeOrigin(origin);
  const separator = typeof cookie === 'string' ? cookie.indexOf('=') : -1;
  const name = separator === -1 ? '' : cookie.slice(0, separator);
  const value = separator === -1 ? '' : cookie.slice(separator + 1);
  if (!name.startsWith('dsh-auth-') || value === '' || value.includes(';')) {
    throw new Error('本机运行时会话 Cookie 不正确。');
  }
  return {
    url: origin.href,
    name,
    value,
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
  };
}

function loopbackFetch(url, init, requestImpl = httpRequest) {
  const target = validateRuntimeOrigin(new URL(url).origin);
  const path = new URL(url).pathname;
  return new Promise((resolve, reject) => {
    const request = requestImpl({
      hostname: target.hostname,
      port: target.port,
      method: init.method,
      path,
      headers: { ...init.headers, host: target.host },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > LOOPBACK_RESPONSE_BYTES) {
          request.destroy(new Error('本机运行时响应过大。'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          json: async () => JSON.parse(body),
        });
      });
    });
    request.once('error', reject);
    request.setTimeout?.(LOOPBACK_RESPONSE_TIMEOUT_MS, () => {
      request.destroy(new Error('本机运行时响应超时。'));
    });
    request.end(init.body);
  });
}

async function dshRpc(origin, cookie, endpoint, args, fetchImpl) {
  const rpcId = `qifu-desktop-${randomUUID()}`;
  const response = await fetchImpl(new URL(`/api/${endpoint}`, origin), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    }),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`本机运行时 ${endpoint} 失败（HTTP ${String(response.status)}）。`);
  const body = await response.json();
  if (body?.type !== 'server-response' || body.rpcId !== rpcId || body.result?.ok !== true) {
    const failure = body?.result?.error;
    const detail = typeof failure?.code === 'string' && typeof failure?.message === 'string'
      ? `${failure.code}: ${failure.message}`
      : '响应格式不正确';
    throw new Error(`本机运行时 ${endpoint} 失败：${detail}`);
  }
  return body.result.value;
}

/** Register the employee-isolated on-device directory before exposing the local runtime. */
async function ensureEmployeeLocalWorkspace(origin, cookie, workspacePath, fetchImpl = loopbackFetch) {
  validateRuntimeOrigin(origin);
  if (typeof cookie !== 'string' || !cookie.startsWith('dsh-auth-')) {
    throw new Error('本机运行时会话 Cookie 缺失。');
  }
  if (typeof workspacePath !== 'string' || !isAbsolute(workspacePath)) {
    throw new Error('本机工作区目录必须是绝对路径。');
  }
  const created = await dshRpc(
    origin,
    cookie,
    'workspace/create',
    { request: { path: workspacePath } },
    fetchImpl,
  );
  const workspace = created?.workspace;
  if (typeof workspace?.workspaceId !== 'string' || typeof workspace.title !== 'string') {
    throw new Error('本机运行时未返回已创建的工作区。');
  }
  if (workspace.title === LOCAL_WORKSPACE_TITLE) return workspace;
  const renamed = await dshRpc(origin, cookie, 'workspace/rename', {
    request: { workspaceId: workspace.workspaceId, title: LOCAL_WORKSPACE_TITLE },
  }, fetchImpl);
  if (typeof renamed?.workspace?.workspaceId !== 'string'
    || renamed.workspace.workspaceId !== workspace.workspaceId
    || renamed.workspace.title !== LOCAL_WORKSPACE_TITLE) {
    throw new Error('本机运行时未返回已命名的工作区。');
  }
  return renamed.workspace;
}

module.exports = {
  createLocalRuntimeOwner,
  ensureEmployeeLocalWorkspace,
  ensureLocalWebProfile,
  exchangeDshToken,
  localRuntimeCookie,
  pickLocalDirectory,
  validateRuntimeOrigin,
};
