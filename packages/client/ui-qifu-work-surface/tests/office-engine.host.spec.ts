import { createServer } from 'node:http'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { createOffice, readOffice } from '../src/office-engine.ts'

const MARKDOWN = '# 企福办公验收\n\n员工文档包含中文内容。\n\n| 姓名 | 金额 |\n| --- | ---: |\n| 陈建新 | 123.45 |\n\n## 工作计划\n\n完成本周任务。\n'
const formats = ['docx', 'pptx', 'xlsx', 'pdf', 'html', 'csv', 'txt', 'md', 'rtf', 'odt', 'odp', 'ods']

describe('Qifu office engine', () => {
  it.each(formats)('creates real %s bytes and reads Chinese content', async (format) => {
    const data = await createOffice(MARKDOWN, format)
    expect(data.byteLength).toBeGreaterThan(20)
    if (['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods'].includes(format)) {
      expect([...data.subarray(0, 2)]).toEqual([0x50, 0x4b])
    }
    if (format === 'pdf') expect(new TextDecoder().decode(data.subarray(0, 5))).toBe('%PDF-')
    const text = (await readOffice(data, `验收.${format}`)).replace(/\s/g, '')
    if (format !== 'csv') expect(text).toContain('企福办公验收')
    expect(text).toContain('陈建新')
    expect(text).toContain('123.45')
  }, 60_000)

  it('keeps HTML scripts and remote resources inert', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.end('unexpected network access')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('missing test address')
      const url = `http://127.0.0.1:${address.port}/must-not-load`
      const html = `<html><script>fetch('${url}')</script><p>正常中文</p><img src="${url}"></html>`
      const text = await readOffice(new TextEncoder().encode(html), '测试.html')
      expect(text).toContain('正常中文')
      expect(text).not.toContain('fetch(')
      await createOffice(`正常中文\n\n![图片](${url})`, 'pdf')
      expect(requests).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  }, 60_000)

  it('rejects corrupt archives instead of returning an empty document', async () => {
    await expect(readOffice(new Uint8Array([0x50, 0x4b, 0, 0, 1]), '损坏.docx')).rejects.toThrow(/OFFICE_READ_FAILED/)
  })

  it('reports PDF pages without extractable text as requiring OCR', async () => {
    const document = await PDFDocument.create()
    document.addPage()
    await expect(readOffice(await document.save(), '扫描件.pdf')).rejects.toThrow(/OFFICE_PDF_TEXT_REQUIRED/)
  }, 60_000)

  it('rejects input above its configured byte cap', async () => {
    await expect(readOffice(new Uint8Array(101), '大文件.txt', { maxInputBytes: 100 })).rejects.toThrow(/OFFICE_INPUT_TOO_LARGE/)
    await expect(createOffice('中文'.repeat(20), 'docx', { maxInputBytes: 100 })).rejects.toThrow(/OFFICE_INPUT_TOO_LARGE/)
  })

  it('rejects inflated archives above its configured decompression cap', async () => {
    const data = await createOffice(MARKDOWN, 'docx')
    await expect(readOffice(data, '大文档.docx', { maxUncompressedBytes: 256 })).rejects.toThrow(/OFFICE_READ_FAILED/)
  }, 60_000)

  it('rejects oversized output and text rather than returning a partial result', async () => {
    await expect(createOffice(MARKDOWN, 'docx', { maxOutputBytes: 100 })).rejects.toThrow(/OFFICE_OUTPUT_TOO_LARGE/)
    await expect(readOffice(new TextEncoder().encode('中文'.repeat(100)), '文档.txt', { maxTextBytes: 100 })).rejects.toThrow(/OFFICE_TEXT_TOO_LARGE/)
  })

  it('ends a worker whose operation exceeds the configured deadline', async () => {
    await expect(createOffice(MARKDOWN, 'docx', { timeoutMs: 1 })).rejects.toThrow(/OFFICE_TIMEOUT/)
  })

  it('cancels an active operation and permits another operation afterwards', async () => {
    const controller = new AbortController()
    const operation = createOffice(MARKDOWN, 'docx', {}, controller.signal)
    controller.abort(new Error('employee cancelled document creation'))
    await expect(operation).rejects.toThrow('employee cancelled document creation')
    expect(await readOffice(new TextEncoder().encode('仍可处理'), '文档.txt')).toBe('仍可处理')
  })

  it('does not carry executable HTML into generated HTML', async () => {
    const markdown = '# 文档\n\n<script>fetch("https://example.invalid")</script>\n\n<img src=x onerror="alert(1)">\n\n'
      + '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>\n\n正常内容'
    const bytes = await createOffice(markdown, 'html')
    const html = new TextDecoder().decode(bytes)
    expect(html).toContain('正常内容')
    expect(html).not.toMatch(/<script|onerror=|<iframe/i)
  })

  it('accepts the common htm extension as HTML', async () => {
    expect(await readOffice(new TextEncoder().encode('<p>网页文档</p>'), '文档.HTM')).toContain('网页文档')
  })

  it('refuses an office worker started with inherited application credentials', async () => {
    const bootstrap = [
      `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
      'register()',
      `await import(${JSON.stringify(new URL('../src/office-worker.ts', import.meta.url).href)})`,
    ].join('\n')
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
      execArgv: [], env: { QIFU_TEST_TOKEN: 'test-only-value' }, workerData: {},
    })
    try {
      const errors: unknown[] = await once(worker, 'error', { signal: AbortSignal.timeout(30_000) })
      expect(String(errors[0])).toContain('OFFICE_WORKER_UNSAFE_ENV')
    } finally {
      await worker.terminate()
    }
  }, 60_000)

  it('rejects unsupported legacy binary formats explicitly', async () => {
    await expect(readOffice(new Uint8Array([1]), '旧文档.doc')).rejects.toThrow(/OFFICE_UNSUPPORTED_FORMAT/)
    await expect(createOffice(MARKDOWN, 'ppt')).rejects.toThrow(/OFFICE_UNSUPPORTED_FORMAT/)
  })
})
