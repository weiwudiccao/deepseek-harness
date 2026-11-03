/** Real Loader/HTTP and logged model-output acceptance for Office documents. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const fixture = fileURLToPath(new URL('./fixtures/office-loader/', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('Qifu Office through the real Web Loader', () => {
  it('logs create/read model results and serves authenticated employee-session downloads', async () => {
    let report: Record<string, unknown> | undefined
    await runLoaderSmoke({
      label: 'Qifu Office real Loader', tempDirPrefix: 'qifu-office-loader-',
      binScript: join(fixture, 'driver.host.ts'), libBinScript: join(fixture, 'driver.host.ts'),
      configPath: join(fixture, 'office.patch.yml'), tsconfigPath: repoTsconfig,
      processTimeoutMs: 90_000, env: { QIFUAI_OFFICE_ENABLED: 'true' },
      inspect: async (cwd) => { report = JSON.parse(await readFile(join(cwd, 'office-report.json'), 'utf8')) as Record<string, unknown> },
    })
    expect(report).toMatchObject({
      output: '已生成工作计划，文件保留在当前会话的文档列表中。',
      downloadStatus: 200, unauthorizedStatus: 401, imported: true, unknownSessionRejected: true, documentCount: 2,
    })
    expect(report?.['downloadedText']).toContain('工作计划')
    const expectedPath = fileURLToPath(new URL('./expected/office-tool-roundtrip.expected.json', import.meta.url))
    expect(report).toEqual(JSON.parse(await readFile(expectedPath, 'utf8')))
  }, 105_000)
})
