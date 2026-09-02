/** Qifu employee work-surface dictionaries. */

export const NS = 'qifuWorkSurface'

/** Simplified Chinese dictionary. */
export const zh = {
  'features': '功能',
  'cloud': '云端工作',
  'local': '本机内容',
  'empty.features': '当前账号暂无可用功能',
  'empty.cloud': '暂无云端内容',
  'loading': '正在加载…',
  'unavailable': '暂时无法读取',
  'switch.cloud': '切换到云端工作',
  'switch.local': '切换到本机内容',
  'sync.file': '选择文件同步到云端',
  'sync.session': '同步当前会话到云端',
  'sync.session.empty': '请先选择一个本机会话',
  'sync.done': '已同步到我的云端工作',
  'sync.error': '同步失败，请重试。',
  'personalization.nav': '画像与记忆',
  'personalization.title': '账号画像与记忆',
  'personalization.description': '以下能力默认关闭，仅在你明确开启后用于企福AI智脑。关闭后立即停止后续读取或提取。',
  'personalization.workProfile': '使用员工工作画像',
  'personalization.workProfile.help': '读取正式 OA 中与当前员工账号关联的岗位、偏好和工作画像。',
  'personalization.memoryRead': '读取云端记忆',
  'personalization.memoryRead.help': '在后续相关对话中使用已经确认的长期记忆。',
  'personalization.memoryWrite': '提取新记忆',
  'personalization.memoryWrite.help': '从对话中提出记忆候选，候选需要确认后才会生效。',
  'personalization.localContext': '允许本机会话临时读取',
  'personalization.localContext.help': '本机内容仍不自动上传；仅允许当前本机会话临时读取已授权的画像和记忆。',
  'personalization.saved': '设置已保存',
  'personalization.error': '设置保存失败，请重试。',
  'kind.Conversation': '对话',
  'kind.Harness Session': '会话',
  'kind.Presentation': '设计',
  'kind.File': '文件',
  'kind.Knowledge': '知识',
} satisfies Record<string, string>

/** Qifu work-surface dictionary key union. */
export type QifuWorkSurfaceKey = keyof typeof zh

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'features': 'Features',
  'cloud': 'Cloud work',
  'local': 'On this device',
  'empty.features': 'No features are available for this account',
  'empty.cloud': 'No cloud content yet',
  'loading': 'Loading…',
  'unavailable': 'Temporarily unavailable',
  'switch.cloud': 'Switch to cloud work',
  'switch.local': 'Switch to local content',
  'sync.file': 'Choose a file to sync to cloud',
  'sync.session': 'Sync current session to cloud',
  'sync.session.empty': 'Select a local session first',
  'sync.done': 'Synced to my cloud work',
  'sync.error': 'Sync failed. Try again.',
  'personalization.nav': 'Profile and memory',
  'personalization.title': 'Account profile and memory',
  'personalization.description': 'These capabilities are off by default and are used only after you enable them. Turning them off stops future reads and extraction immediately.',
  'personalization.workProfile': 'Use employee work profile',
  'personalization.workProfile.help': 'Read job, preference, and work-profile data associated with the current employee in the formal OA service.',
  'personalization.memoryRead': 'Read cloud memory',
  'personalization.memoryRead.help': 'Use confirmed long-term memories in later relevant conversations.',
  'personalization.memoryWrite': 'Extract new memories',
  'personalization.memoryWrite.help': 'Create memory proposals from conversations; proposals take effect only after confirmation.',
  'personalization.localContext': 'Allow temporary local-session reads',
  'personalization.localContext.help': 'Local content is still not uploaded automatically; this only lets the current local session temporarily read authorized profile and memory data.',
  'personalization.saved': 'Settings saved',
  'personalization.error': 'Could not save settings. Try again.',
  'kind.Conversation': 'Conversation',
  'kind.Harness Session': 'Session',
  'kind.Presentation': 'Design',
  'kind.File': 'File',
  'kind.Knowledge': 'Knowledge',
} satisfies Record<QifuWorkSurfaceKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Qifu employee work-surface copy. */
    qifuWorkSurface: QifuWorkSurfaceKey
  }
}
