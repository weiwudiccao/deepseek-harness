/** Scripted external model for the real Office document tool round trip. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

class OfficeModel extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const results = options.messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    let name: string
    let args: string
    if (results.length === 0) {
      name = 'office_create'
      args = JSON.stringify({ name: 'plan.txt', format: 'txt', markdown: '# 工作计划\n\n准备报告\n复核数据' })
    } else if (results.length === 1) {
      const text = results[0]?.content.find(block => block.type === 'text')
      if (text?.type !== 'text') throw new Error('Office create returned no model-visible text')
      const document = JSON.parse(text.text) as { id: string }
      name = 'office_read'
      args = JSON.stringify({ document_id: document.id, offset: 1, limit: 20 })
    } else {
      const reply = '已生成工作计划，文件保留在当前会话的文档列表中。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const id = ToolCallId(`office-fixture-${String(results.length + 1)}`)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
export const name = 'office-fixture-model'
export const inject = ['llm']

/** @param ctx - Loader context owning the scripted external model registration. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['office-fixture'], new OfficeModel())
}
