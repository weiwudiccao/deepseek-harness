import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { createFrappeAuthenticator, createGateway, createModelForwarder } from './gateway.mjs'
import { createDshRuntimeProvider } from './runtime.mjs'

function required(name) {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
  return value
}

function decodeYamlScalar(value) {
  const scalar = value.trim()
  if (scalar.startsWith('"')) return JSON.parse(scalar)
  if (scalar.startsWith("'") && scalar.endsWith("'")) return scalar.slice(1, -1).replaceAll("''", "'")
  return scalar
}

async function readCredentialRef(file, ref) {
  const source = await readFile(file, 'utf8')
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^  ${escaped}:\\s*(.+?)\\s*$`, 'mu').exec(source)
  if (match?.[1] === undefined) throw new Error(`${ref} is missing from ${file}`)
  const value = decodeYamlScalar(match[1])
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${ref} is empty in ${file}`)
  return value
}

const host = process.env.QIFU_GATEWAY_HOST ?? '0.0.0.0'
const port = Number(process.env.QIFU_GATEWAY_PORT ?? '3443')
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('QIFU_GATEWAY_PORT must be a TCP port')

const certificatePath = required('QIFU_GATEWAY_TLS_CERT')
const [certificate, privateKey] = await Promise.all([
  readFile(certificatePath),
  readFile(required('QIFU_GATEWAY_TLS_KEY')),
])
const modelApiKey = await readCredentialRef(
  process.env.QIFU_GATEWAY_MODEL_CREDENTIALS ?? '/root/.dsh/.credentials.yaml',
  'DEEPSEEK_API_KEY',
)
const runtimes = createDshRuntimeProvider({
  cliPath: process.env.QIFU_GATEWAY_DSH_CLI ?? '/root/qifuaigent/apps/cli/lib/bin.js',
  cwd: process.env.QIFU_GATEWAY_DSH_CWD ?? '/root/qifuaigent',
  dataRoot: process.env.QIFU_GATEWAY_USER_DATA_ROOT ?? '/var/lib/qifuaigent/users',
  certificatePath,
  contextOrigin: required('QIFU_GATEWAY_PUBLIC_ORIGIN'),
})
const gateway = createGateway({
  authenticator: createFrappeAuthenticator({
    baseUrl: process.env.QIFU_GATEWAY_FRAPPE_ORIGIN ?? 'https://oa.qifuyunai.cn',
  }),
  modelForwarder: createModelForwarder({
    baseUrl: process.env.QIFU_GATEWAY_MODEL_ORIGIN ?? 'https://api.deepseek.com/v1',
    searchBaseUrl: process.env.QIFU_GATEWAY_SEARCH_ORIGIN ?? 'https://api.deepseek.com/anthropic/v1',
    apiKey: modelApiKey,
  }),
  runtimes,
})
const server = createServer({ cert: certificate, key: privateKey }, gateway.handleRequest)
server.on('upgrade', gateway.handleUpgrade)
server.listen(port, host, () => {
  process.stdout.write(`qifuaigent gateway: listening on ${host}:${String(port)}\n`)
})

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  gateway.dispose()
  server.close(() => process.exit(0))
  server.closeAllConnections()
  const timeout = setTimeout(() => process.exit(0), 5_000)
  timeout.unref()
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)
