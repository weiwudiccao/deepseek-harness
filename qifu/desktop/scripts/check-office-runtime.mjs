/**
 * Isolated Office or managed-browser acceptance for a packaged SEA or an installed DSH CLI.
 * node qifu-office-runtime-accept.mjs --runtimePath /abs/runtime --DSH_ROOT /abs/runtime-dir
 * node qifu-office-runtime-accept.mjs --runtimePath /usr/bin/node --cli /abs/apps/cli/lib/bin.js --DSH_ROOT /abs/repo
 * Source debugging only: add --source for a TypeScript CLI entry.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const argumentsList = process.argv.slice(2);
function argument(name) { const at = argumentsList.indexOf(`--${name}`); return at < 0 ? undefined : argumentsList[at + 1]; }
const runtimePath = argument('runtimePath');
const runtimeRoot = argument('DSH_ROOT');
const cliPath = argument('cli');
const officePlugin = argument('officePlugin');
const browserOnly = argumentsList.includes('--browser');
assert.ok(runtimePath && isAbsolute(runtimePath), '--runtimePath must be absolute');
assert.ok(runtimeRoot && isAbsolute(runtimeRoot), '--DSH_ROOT must be absolute');
if (cliPath !== undefined) assert.ok(isAbsolute(cliPath), '--cli must be absolute');
await access(runtimePath);
const scratch = await mkdtemp(join(tmpdir(), 'qifu-office-runtime-accept-'));
const home = join(scratch, 'home');
const dshHome = join(home, '.dsh');
const workspace = join(scratch, 'workspace');
const temporary = join(scratch, 'tmp');
const controller = new AbortController();
const interrupt = () => controller.abort(new Error('Office acceptance interrupted'));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const formats = ['docx', 'pptx', 'xlsx', 'pdf', 'html', 'csv'];
const markdown = '# 企福验收\n\n员工中文办公文档测试。\n\n| 名称 | 数量 |\n| --- | --- |\n| 企福验收 | 3 |';
const fakeKey = `office-diagnostic-${randomUUID()}`;
let child;
let server;
let requests = 0;
let report;
const readBack = new Map();
const childErrors = [];
let browserUrl;
let browserResult;
let guardDenied = false;
const fixturePath = `/qifu-browser-${randomUUID()}`;
const fixtureMarker = `QIFU_BROWSER_DOM_${randomUUID()}`;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
const activeSockets = new Set();
function sendModel(response, model, message, finish) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  const packet = value => response.write(`data: ${JSON.stringify({ id: 'office-diagnostic', object: 'chat.completion.chunk', created: 0, model, choices: value })}\n\n`);
  packet([{ index: 0, delta: { role: 'assistant', ...message }, finish_reason: null }]);
  packet([{ index: 0, delta: {}, finish_reason: finish }]);
  response.write('data: [DONE]\n\n'); response.end();
}
function resultText(message) {
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
}
function tools(values) {
  return values.map((value, index) => ({ index, id: `office_accept_${value.name}_${index}`, type: 'function', function: { name: value.name, arguments: JSON.stringify(value.arguments) } }));
}
async function stopChild() {
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    const kill = value => {
      try { if (process.platform === 'win32') child.kill(value); else process.kill(-child.pid, value); }
      catch (error) { if (error?.code !== 'ESRCH') throw error; }
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }

}
try {
  await Promise.all([home, workspace, temporary, join(dshHome, 'profiles', 'web')].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } } }), { mode: 0o600 });
  await writeFile(join(dshHome, 'profiles', 'web', 'cordis.yml'), '[]\n', { mode: 0o600 });
  await writeFile(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), officePlugin === undefined ? '[]\n' : `- id: ui-qifu-work-surface\n  disabled: true\n- insert:\n    - id: qifu-office-candidate\n      name: ${JSON.stringify(officePlugin)}\n`, { mode: 0o600 });
  server = createServer(async (request, response) => {
    try {
      if (browserOnly && request.method === 'GET' && request.url === fixturePath) {
        assert.equal(request.headers.authorization, undefined, 'Desktop bearer leaked to the page');
        assert.equal(request.headers.cookie, undefined, 'Browser read reused existing cookies');
        assert.equal(Object.keys(request.headers).some(name => name.startsWith('x-qifu-')), false, 'Desktop transport headers leaked to the page');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': 'qifu_browser_owned=temporary; SameSite=Lax' });
        response.end(`<!doctype html><html><body><script>alert("must-not-open"); localStorage.setItem("qifu-browser-owned", "temporary")</script><main id="browser-acceptance">${fixtureMarker}</main></body></html>`);
        return;
      }
      if (browserOnly && request.method === 'GET') {
        response.writeHead(404); response.end(); return;
      }
      assert.equal(request.headers.authorization, `Bearer ${fakeKey}`, 'Unexpected diagnostic credential');
      assert.ok(request.url?.endsWith('/chat/completions'), 'Unexpected model endpoint');
      const buffers = []; let received = 0;
      for await (const bytes of request) { received += bytes.length; assert.ok(received < 8 * 1024 * 1024, 'Unexpectedly large model request'); buffers.push(bytes); }
      const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
      requests++;
      const relevant = body.messages.some(message => message.role === 'user' && resultText(message).includes(browserOnly ? 'BROWSER_RUNTIME_ACCEPTANCE' : 'OFFICE_RUNTIME_ACCEPTANCE'));
      const outcomes = body.messages.filter(message => message.role === 'tool').map(resultText).map(text => { try { return JSON.parse(text); } catch { return { text }; } });
      if (!relevant || !Array.isArray(body.tools)) { sendModel(response, body.model, { content: '办公文档验收' }, 'stop'); return; }
      if (browserOnly) {
        const result = outcomes.find(value => typeof value.dom === 'string' && typeof value.domTruncated === 'boolean');
        if (result === undefined) {
          const attempted = body.messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.function?.name === 'browser_test'));
          assert.equal(attempted, false, `browser_test did not return a DOM result: ${JSON.stringify(outcomes).slice(0, 4096)}`);
          assert.ok(body.tools.some(tool => tool.function?.name === 'browser_test'), 'browser_test was not in model-visible schemas');
          sendModel(response, body.model, { tool_calls: tools([{ name: 'browser_test', arguments: { url: browserUrl } }]) }, 'tool_calls');
        } else if (!JSON.stringify(outcomes).includes('QIFU_BROWSER_DIRECT_LAUNCH')) {
          assert.equal(result.url, browserUrl); assert.equal(result.domTruncated, false);
          assert.deepEqual(Object.keys(result).sort(), ['dom', 'domTruncated', 'url']);
          assert.ok(result.dom.includes(fixtureMarker), 'Isolated Electron renderer omitted the served DOM marker');
          browserResult = result;
          const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
          assert.ok(body.tools.some(tool => tool.function?.name === shell), `${shell} was not in normal model-visible schemas`);
          assert.ok(!body.messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.function?.name === shell)), `Direct Chrome launch was not refused: ${JSON.stringify(outcomes).slice(0, 4096)}`);
          const profile = join(workspace, 'guard-probe-profile');
          const command = process.platform === 'win32'
            ? `& 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' --headless --dump-dom --user-data-dir='${profile.replaceAll("'", "''")}' '${browserUrl}'`
            : `HOME=${JSON.stringify(join(workspace, 'guard-probe-home'))} '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless --use-mock-keychain --dump-dom --user-data-dir=${JSON.stringify(profile)} ${JSON.stringify(browserUrl)}`;
          sendModel(response, body.model, { tool_calls: tools([{ name: shell, arguments: { command, description: 'Verify that direct Chrome startup is refused' } }]) }, 'tool_calls');
        } else {
          guardDenied = true;
          sendModel(response, body.model, { content: 'BROWSER_RUNTIME_ACCEPTANCE_OK' }, 'stop');
        }
        return;
      }
      const created = outcomes.filter(value => value.kind === 'generated' && typeof value.id === 'string');
      const read = outcomes.filter(value => typeof value.text === 'string' && typeof value.totalLines === 'number');
      if (created.length === 0) {
        assert.ok(body.tools.some(tool => tool.function?.name === 'office_create'), 'office_create was not in model-visible schemas');
        sendModel(response, body.model, { tool_calls: tools(formats.map(format => ({ name: 'office_create', arguments: { name: `企福验收.${format}`, markdown, format } }))) }, 'tool_calls');
      } else if (read.length === 0) {
        assert.equal(created.length, formats.length, `Some Office creates failed: ${JSON.stringify(outcomes.filter(value => value.kind !== 'generated'))}`);
        sendModel(response, body.model, { tool_calls: tools(created.map(value => ({ name: 'office_read', arguments: { document_id: value.id, offset: 1, limit: 2000 } }))) }, 'tool_calls');
      } else {
        assert.equal(read.length, formats.length, `Some Office reads failed: ${JSON.stringify(outcomes.filter(value => typeof value.totalLines !== 'number' && value.kind !== 'generated'))}`);
        for (const value of read) { assert.ok(value.text.includes('企福验收'), `Chinese text missing from ${value.name}`); readBack.set(value.name, value); }
        sendModel(response, body.model, { content: 'OFFICE_RUNTIME_ACCEPTANCE_OK' }, 'stop');
      }
    } catch (error) {
      childErrors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Diagnostic Office model rejected request', type: 'diagnostic_failure' } }));
    }
  });
  server.on('connection', socket => { activeSockets.add(socket); socket.on('close', () => activeSockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  browserUrl = `http://127.0.0.1:${port}${fixturePath}`;
  const argv = cliPath === undefined ? [] : [cliPath];
  if (argumentsList.includes('--source')) {
    const require = createRequire(join(runtimeRoot, 'package.json'));
    argv.unshift('--import', require.resolve('tsx/esm'));
  }
  argv.push('web', '--host', '127.0.0.1', '--port', '0', '--no-open');
  child = spawn(runtimePath, argv, { cwd: workspace, detached: process.platform !== 'win32', windowsHide: true,
    env: {
      PATH: process.env.PATH, LANG: 'zh_CN.UTF-8', HOME: browserOnly ? process.env.HOME : home, USERPROFILE: browserOnly ? process.env.USERPROFILE : home,
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, LOCALAPPDATA: join(home, 'AppData', 'Local') } : {}),
      DSH_HOME: dshHome, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local', 'share'),
      CI: 'true', NODE_ENV: 'production', NO_COLOR: '1',
      ...(argumentsList.includes('--source') ? { TSX_TSCONFIG_PATH: join(runtimeRoot, 'tsconfig.json') } : {}),
      DEEPSEEK_API_KEY: fakeKey, DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`, DEEPSEEK_SEARCH_BASE_URL: `http://127.0.0.1:${port}/v1`,
      ...(browserOnly ? { QIFUAI_BROWSER_TEST_URL: process.env.QIFUAI_BROWSER_TEST_URL, QIFUAI_BROWSER_TEST_TOKEN: process.env.QIFUAI_BROWSER_TEST_TOKEN } : {}),
      QIFUAI_OFFICE_ENABLED: browserOnly ? 'false' : 'true', QIFUAI_BROWSER_TEST_ENABLED: browserOnly ? 'true' : 'false', QIFUAI_DSH_ROOT: runtimeRoot,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = await new Promise((resolve, reject) => {
    let output = ''; let finished = false;
    const finish = error => { if (finished) return; finished = true; clearTimeout(timer); child.stdout.off('data', data); child.stderr.off('data', data); child.off('error', failed); child.off('exit', exited); if (error) reject(error); };
    const data = chunk => {
      output = `${output}${chunk}`.slice(-65536);
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/)\?token=([A-Za-z0-9_-]+)/u.exec(output);
      if (match) { const value = { origin: new URL(match[1]), token: match[2] }; output = ''; finish(); child.stdout.resume(); child.stderr.resume(); resolve(value); }
    };
    const failed = error => finish(error);
    const exited = code => finish(new Error(`Office runtime exited before readiness (${code}): ${output.replace(/token=[A-Za-z0-9_-]+/gu, 'token=[redacted]')}`));
    const timer = setTimeout(() => finish(new Error('Office runtime startup exceeded 90 seconds')), 90_000);
    child.stdout.on('data', data); child.stderr.on('data', data); child.once('error', failed); child.once('exit', exited);
  });
  const origin = ready.origin;
  const get = (path, cookie) => fetch(new URL(path, origin), { headers: cookie ? { cookie } : {}, redirect: 'manual', signal: signal() });
  const noAuth = await get('/'); assert.equal(noAuth.status, 401); await noAuth.arrayBuffer();
  const login = await get(`/?token=${ready.token}`); ready.token = '';
  assert.equal(login.status, 303); await login.arrayBuffer();
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]; assert.ok(cookie?.startsWith('dsh-auth-'));
  const authenticated = await get('/', cookie); assert.equal(authenticated.status, 200); const html = await authenticated.text();
  assert.ok(html.includes('@deepseek-ai/dsh-client-ui-qifu-work-surface'), 'Qifu Office host/client package was absent from boot graph');
  const rpc = async (channel, endpoint, payload, authenticatedCookie = cookie) => {
    const response = await fetch(new URL(`${channel}/${endpoint}`, origin), { method: 'POST', headers: { cookie: authenticatedCookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload }), redirect: 'manual', signal: signal() });
    assert.equal(response.status, 200, `${endpoint} returned HTTP ${response.status}`); const body = await response.json(); assert.equal(body.result.ok, true, body.result.error?.message); return body.result.value;
  };
  const createSession = () => rpc('/api', 'session/create', { args: { request: { cwd: workspace } } });
  if (browserOnly) {
    const sessionId = (await createSession()).sessionId;
    const before = (await readdir(workspace)).sort();
    await rpc('/api', 'session/prompt', { args: { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'BROWSER_RUNTIME_ACCEPTANCE: inspect the owned page and refuse a direct Chrome command.' }] } } });
    for (let at = 0; at < 120; at++) {
      if (childErrors.length) throw new Error(childErrors.join('; '));
      if (guardDenied) break;
      if (at === 119) throw new Error('Browser flow did not complete');
      await pause(500);
    }
    assert.ok(browserResult);
    assert.deepEqual((await readdir(workspace)).sort(), before, 'Browser check or guard left a local profile');
    report = { browserLoaded: true, domMarker: true, pageTransportHeadersAbsent: true, directLaunchRefused: true, localProfileUnchanged: true, fakeModelRequests: requests, realModelRequests: 0, realEmployeeDataAccessed: false };

  } else {
  const sessionA = (await createSession()).sessionId;
  const sessionB = (await createSession()).sessionId;
  assert.deepEqual((await rpc('/qifu-office', 'list', { sessionId: sessionB })).documents, []);
  await rpc('/api', 'session/prompt', { args: { request: { requestId: randomUUID(), sessionId: sessionA, mode: 'queue', content: [{ type: 'text', text: 'OFFICE_RUNTIME_ACCEPTANCE：生成六种格式并读取验证中文。' }] } } });
  let documents;
  for (let at = 0; at < 120; at++) {
    if (childErrors.length) throw new Error(childErrors.join('; '));
    documents = (await rpc('/qifu-office', 'list', { sessionId: sessionA })).documents;
    if (readBack.size === formats.length && documents.length === formats.length) break;
    if (at === 119) throw new Error(`Office flow incomplete: ${documents.length} generated, ${readBack.size} read back`);
    await pause(500);
  }
  const validated = [];
  for (const document of documents) {
    const path = `/api/qifu.office.download?sessionId=${encodeURIComponent(sessionA)}&documentId=${document.id}`;
    const rejected = await get(path); assert.equal(rejected.status, 401); await rejected.arrayBuffer();
    const other = await get(`/api/qifu.office.download?sessionId=${encodeURIComponent(sessionB)}&documentId=${document.id}`, cookie); assert.equal(other.status, 404); await other.arrayBuffer();
    const response = await get(path, cookie); assert.equal(response.status, 200); assert.ok(response.headers.get('content-disposition')?.includes('attachment')); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, document.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), document.sha256);
    if (['docx', 'pptx', 'xlsx'].includes(document.format)) assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    if (document.format === 'pdf') assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    const imported = await rpc('/qifu-office', 'import', { sessionId: sessionB, name: document.name, data: bytes.toString('base64') });
    assert.notEqual(imported.document.id, document.id); assert.equal(imported.document.sha256, document.sha256);
    validated.push({ format: document.format, bytes: bytes.length, sha256: document.sha256, chineseReadBack: true });
  }
  assert.equal((await rpc('/qifu-office', 'list', { sessionId: sessionB })).documents.length, formats.length);
  const largeBytes = Buffer.from('<!doctype html><!--' + 'x'.repeat(20 * 1024 * 1024) + '--><p>大附件验收</p>');
  const sessionC = (await createSession()).sessionId;
  const large = await rpc('/qifu-office', 'import', { sessionId: sessionC, name: '大附件验收.html', data: largeBytes.toString('base64') });
  const largeResponse = await get(`/api/qifu.office.download?sessionId=${encodeURIComponent(sessionC)}&documentId=${large.document.id}`, cookie);
  assert.equal(largeResponse.status, 200);
  assert.equal(large.document.bytes, largeBytes.length);
  assert.equal(createHash('sha256').update(Buffer.from(await largeResponse.arrayBuffer())).digest('hex'), createHash('sha256').update(largeBytes).digest('hex'));
  report = { officeLoaded: true, largeDocumentBytes: largeBytes.length, unauthenticatedStatus: 401, crossSessionDownloadStatus: 404, immutableDocumentIds: true, samples: validated.sort((a, b) => a.format.localeCompare(b.format)), fakeModelRequests: requests, realModelRequests: 0, realEmployeeDataAccessed: false };
  }
} finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  try { await stopChild(); }
  finally {
    for (const socket of activeSockets) socket.destroy();
    try { if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { await rm(scratch, { recursive: true, force: true }); }
  }
}
process.stdout.write(`${JSON.stringify({ ...report, temporaryFilesRemoved: true })}\n`);
