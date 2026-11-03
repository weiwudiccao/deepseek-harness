#!/usr/bin/env node
/** Run the Office tool flow through the shipping Web profile and real Loader. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const patch = process.argv[2]
if (patch === undefined) throw new Error('Office fixture requires its patch path')
const ctx = await bootProductionProfile({
  binName: 'office-loader-fixture', profile: 'web', overlayPaths: [resolveConfigPath(patch, undefined)],
  prepare: (host) => { host.provide('webStartup', { host: '127.0.0.1', port: 0, openBrowser: false, trustedHosts: [] }) },
})
try {
  const result = await runFixtureTurn(ctx, { task: '生成一份工作计划，并读回文件确认内容。' })
  const events = [...(ctx.agents.roots()[0]?.session.events ?? [])]
  const results = events.filter(event => event.type === 'tool/result').map((event) => {
    const block = event.data.message.content[0]
    const output = JSON.parse(block.content.filter(part => part.type === 'text').map(part => part.text).join('')) as Record<string, unknown>
    if ('id' in output) output['id'] = '{{document:1}}'
    if ('createdAt' in output) output['createdAt'] = '{{createdAt}}'
    return { callId: block.toolCallId, isError: block.isError, value: output }
  })
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('Office fixture did not receive a browser cookie')
  const call = async (endpoint: string, payload: unknown) => {
    const response = await fetch(`${origin}/qifu-office/${endpoint}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'office-fixture-rpc', method: endpoint, payload }),
    })
    if (!response.ok) throw new Error(`Office fixture RPC HTTP ${String(response.status)}`)
    return response.json() as Promise<{ result: { ok: boolean; value?: { documents?: { id: string }[]; document?: { id: string } } } }>
  }
  const list = await call('list', { sessionId: result.sessionId })
  const id = list.result.value?.documents?.[0]?.id
  if (id === undefined) throw new Error('Office fixture generated no document')
  const downloadUrl = `${origin}/api/qifu.office.download?sessionId=${encodeURIComponent(result.sessionId)}&documentId=${id}`
  const unauthorized = await fetch(downloadUrl)
  const download = await fetch(downloadUrl, { headers: { cookie } })
  const upload = await call('import', { sessionId: result.sessionId, name: 'reference.html', data: Buffer.from('<p>员工资料</p>').toString('base64') })
  const unknownSession = await call('list', { sessionId: 'unknown-session' })
  const report = {
    output: result.output, toolResults: results, downloadStatus: download.status,
    downloadedText: await download.text(), unauthorizedStatus: unauthorized.status,
    imported: upload.result.ok, unknownSessionRejected: !unknownSession.result.ok,
    documentCount: (await call('list', { sessionId: result.sessionId })).result.value?.documents?.length,
  }
  await writeFile(join(process.cwd(), 'office-report.json'), `${JSON.stringify(report)}\n`)
} finally {
  await ctx.fiber.dispose()
}
