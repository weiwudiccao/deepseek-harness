const { strict: assert } = require('node:assert');
const { EventEmitter } = require('node:events');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  ensureEmployeeLocalWorkspace,
  ensureLocalWebProfile,
  exchangeDshToken,
  localRuntimeCookie,
} = require('../src/local-runtime-support.cjs');

test('local Web profile removes the unsupported invariant entry from existing employee homes', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'qifu-local-profile-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const profileDir = join(root, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `- insert:
    - id: qifu-account-context
      name: '@deepseek-ai/dsh-qifu-account-context'
    - id: qifu-account-context-invariant
      name: '@deepseek-ai/dsh-qifu-account-context/invariant'
`);

  ensureLocalWebProfile(root);
  ensureLocalWebProfile(root);

  const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  assert.equal(patch.match(/id: qifu-account-context$/gmu)?.length, 1);
  assert.ok(!patch.includes('qifu-account-context-invariant'));
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-qifu-account-context'], '0.1.2-alpha.3');
});

function requestFixture(statusCode, cookies, calls) {
  return (options, callback) => {
    calls.push(options);
    const request = new EventEmitter();
    request.end = () => {
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = statusCode;
        response.headers = { 'set-cookie': cookies };
        callback(response);
        response.end();
      });
    };
    return request;
  };
}

test('launch-token exchange returns the DSH session cookie', async () => {
  const calls = [];
  const cookie = await exchangeDshToken(
    new URL('http://127.0.0.1:43127/'),
    'launch-token',
    requestFixture(303, ['dsh-auth-cookie=signed-value; Path=/; HttpOnly'], calls),
  );

  assert.equal(cookie, 'dsh-auth-cookie=signed-value');
  assert.deepEqual(calls, [{
    hostname: '127.0.0.1',
    port: '43127',
    method: 'GET',
    path: '/?token=launch-token',
    headers: { host: '127.0.0.1:43127' },
  }]);
});

test('launch-token exchange fails without a signed DSH cookie', async () => {
  await assert.rejects(
    exchangeDshToken(
      new URL('http://127.0.0.1:43128/'),
      'launch-token',
      requestFixture(303, ['other=value; Path=/'], []),
    ),
    /未返回会话 Cookie/u,
  );
});

test('launch-token exchange retries while the announced listener is not reachable yet', async () => {
  let attempts = 0;
  const requestImpl = (options, callback) => {
    attempts += 1;
    if (attempts > 1) {
      return requestFixture(303, ['dsh-auth-cookie=signed; Path=/'], [])(options, callback);
    }
    const request = new EventEmitter();
    request.end = () => {
      queueMicrotask(() => {
        const error = new Error('not listening');
        error.code = 'ECONNREFUSED';
        request.emit('error', error);
      });
    };
    return request;
  };

  const cookie = await exchangeDshToken(
    new URL('http://127.0.0.1:43128/'),
    'launch-token',
    requestImpl,
    { attempts: 2, retryDelayMs: 0, delayImpl: async () => {} },
  );

  assert.equal(cookie, 'dsh-auth-cookie=signed');
  assert.equal(attempts, 2);
});

test('Electron receives only the parsed loopback session cookie', () => {
  assert.deepEqual(
    localRuntimeCookie(new URL('http://127.0.0.1:43129/'), 'dsh-auth-cookie=v1.body.signature'),
    {
      url: 'http://127.0.0.1:43129/',
      name: 'dsh-auth-cookie',
      value: 'v1.body.signature',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
    },
  );
});

test('employee local Workspace is registered idempotently and receives its product title', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url: String(url), init, request });
    const workspace = request.method === 'workspace/create'
      ? { workspaceId: 'local', title: 'local-workspace' }
      : { workspaceId: 'local', title: '本机工作区' };
    return Response.json({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value: { workspace } },
    });
  };

  const workspace = await ensureEmployeeLocalWorkspace(
    new URL('http://127.0.0.1:43130/'),
    'dsh-auth-cookie=signed',
    '/Users/employee/Library/Application Support/qifu/local-workspace',
    fetchImpl,
  );

  assert.deepEqual(workspace, { workspaceId: 'local', title: '本机工作区' });
  assert.deepEqual(calls.map(call => call.url), [
    'http://127.0.0.1:43130/api/workspace/create',
    'http://127.0.0.1:43130/api/workspace/rename',
  ]);
  assert.equal(calls[0].init.headers.cookie, 'dsh-auth-cookie=signed');
  assert.deepEqual(calls[0].request.payload, {
    args: {
      request: {
        path: '/Users/employee/Library/Application Support/qifu/local-workspace',
      },
    },
  });
});

test('employee local Workspace keeps its managed title without a rename', async () => {
  let calls = 0;
  const workspace = await ensureEmployeeLocalWorkspace(
    new URL('http://127.0.0.1:43131/'),
    'dsh-auth-cookie=signed',
    '/Users/employee/Library/Application Support/qifu/local-workspace',
    async (_url, init) => {
      calls += 1;
      const request = JSON.parse(init.body);
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: { workspace: { workspaceId: 'local', title: '本机工作区' } },
        },
      });
    },
  );

  assert.equal(workspace.title, '本机工作区');
  assert.equal(calls, 1);
});
