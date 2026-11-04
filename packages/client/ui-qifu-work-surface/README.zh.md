---
description: "面向桌面端员工的导航界面，展示权限功能、云端工作和本机内容，并提供明确发布及画像与记忆授权。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-qifu-work-surface

[English](README.md) | 中文

## 概述

该包为已认证企福桌面端员工提供一个包含三个明确区域的侧边栏：权限决定的「功能」、员工私有的「云端工作」和当前设备上的「本机内容」。云端工作分组展示个人对话与会话、设计、文件和明确发布的本机内容；企业知识源不会出现在该侧边栏，也不会迁入「功能」。该包把标准工作区和会话浏览器放在当前活动运行区域内，因此本机内容会保留在员工专属的设备运行时中，直到员工发布单个文件或会话快照。设置页提供四项相互独立且在 OA 中默认关闭的画像与记忆授权。只有具备企福桌面预加载桥和已认证网关时才应选择该包；普通 Web 组合不会注册企福界面。

## 目录

- [使用该包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用该包

在企福桌面 Web bundle 中，将该插件挂载在侧边栏、会话控制器、locale、renderer 和设置服务之后。桌面预加载层必须公开类型化 `qifuDesktop` 桥，网关必须针对已认证员工响应版本化 `/qifu/v1` 路由。

### 何时选择

具备员工专属云端和本机运行时的证书锁定企福桌面部署应选择该包。普通 Web 部署或不含企福网关的部署应将它移出组合；标准侧边栏随后会直接渲染工作区浏览器。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-client-ui-qifu-work-surface'
```

Host 接受 `enabledEnv`（默认 `QIFUAI_OFFICE_ENABLED`）、`dshHome`、`maxDocumentBytes`（25 MiB）、`maxTextBytes`（1 MiB）、`maxDocumentsPerSession`（100）和 `maxReadLines`（2000）和 `maxConcurrentOperations`（2）；只有指定环境变量为 `true` 时才注册办公操作。网关负责功能、员工私有云端元数据、授权、传输策略和授权记录；桌面桥负责运行时切换、功能打开、本机文件选择和明确发布。

### 办公文档

可将文档拖入或粘贴到会话输入框，也可使用「办公文件」选择器。非图片文件进入当前会话的文档导入器，图片保留原附件流程。文档面板会自动展开，显示导入状态、转换错误及下载入口。同一批文件顺序导入；同时发起另一批导入时会明确提示繁忙。会话输入框可导入 DOCX、PPTX、XLSX、文字 PDF、HTML/HTM、CSV、TXT、Markdown、RTF、ODT、ODP 和 ODS。模型通过 `office_read` 读取选中文档，并通过 `office_create` 生成这些现代格式。文件保存在当前员工运行时的 `DSH_HOME` 中，以会话和随机文档 ID 隔离。产物不覆盖原件或模型指定的工作区路径；输入框提供鉴权下载列表。本机导入保留在本机运行时，提取内容仍可能随员工模型请求发送。

解析和生成在可终止的 worker 中执行，不继承员工环境凭据，并限制字节、时间、堆内存、XML、压缩包和文本大小。远程资源、文档宏、HTML 脚本和 OCR 均停用。PDF 生成使用随包提供、采用 SIL Open Font License 的 Noto Sans SC 字体，不依赖系统字体。文件名选择受支持的解析器；损坏或加密的内容会报错，不会作为二进制直接发送模型。

### 失败行为

bootstrap 失败时，该包绝不替换为静态完整功能目录。它显示不可用或空状态，把本机工作区和会话数据留在当前活动设备运行时中，并报告运行时切换与发布失败，不会把任一操作视为成功。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节——点击展开</summary>

浏览器插件注册类型化中英文词典，替换可选的 `sidebar.workSurface` 组合席位，并增加一个 `settings.section` occupant。侧边栏 owner 提供已经渲染的标准工作区浏览器；`QifuWorkSurface` 根据桌面运行模式把它放到「云端工作」或「本机内容」下。网关响应被解析为受控功能字段和个人云端类型白名单，再按会话、设计和文件分组。企业知识条目会被丢弃，不会渲染，也不会重新归入「功能」。每项特权操作都通过预加载层接口白名单。`PersonalizationSection` 读取并写入完整的四字段授权记录，写入失败时恢复先前值。

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 仅桌面端启用的 locale 与 slot 注册 |
| [`src/client/QifuWorkSurface.tsx`](src/client/QifuWorkSurface.tsx) | 功能、云端工作、本机内容、运行时切换和发布操作 |
| [`src/client/PersonalizationSection.tsx`](src/client/PersonalizationSection.tsx) | 四项相互独立的画像与记忆授权控件 |
| [`src/client/api.ts`](src/client/api.ts) | 类型化桌面网关桥与响应校验 |
| [`src/invariant.ts`](src/invariant.ts) | 包所有权 companion；没有可变运行时 invariant |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

以下页面说明该包所组合的通用席位和企福部署决策。

- [ui-sidebar](../ui-sidebar/README.zh.md)——拥有 `sidebar.workSurface` 和标准工作区浏览器 handoff。
- [ui-settings](../ui-settings/README.zh.md)——拥有设置 section 生命周期。
- [员工运行时隔离](../../../.agents/notes/implemented/feature/2026-09-01-employee-runtime-isolation-and-identity.zh.md)——分离员工云端会话和身份展示。
- [企福桌面端默认本机工作区](../../../.agents/notes/implemented/feature/2026-09-03-qifu-default-local-workspace.zh.md)——负责员工隔离的初始目录和运行时就绪行为。
- [企福员工工作界面方案](../../../.agents/notes/proposed/feature/2026-09-02-qifu-employee-work-surface.zh.md)——拥有更完整的数据、传输、个性化和升级决策。

-----

<a id="model-experience"></a>
## 模型体验

### 办公文档工具

#### 模型看到的内容

启用后，`office_read` 返回调用会话中导入或生成文档的有界行窗口。`office_create` 接受文件名、Markdown 内容和输出格式，返回新文档的 ID、大小和摘要。文档引用加入员工草稿；提取文本和产物元数据通过持久化工具结果进入上下文。文档文字属于数据，不作为部署指令。

#### Token 影响

启用的工具加入固定定义和办公指引。读取结果和完整的 Markdown 创建参数会增加对话 token；该包不直接调用模型。

#### KV 缓存影响

相同配置下工具定义保持稳定，结果追加在可复用的请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制用于区分已交付浏览器界面与网关、OA、桌面运行时和后续方案阶段各自负责的能力。

- **仅限桌面端**——缺少 `qifuDesktop` 预加载桥时，该包会有意保持停用。
- **云端列表是近期个人投影**——首个界面最多读取 50 条个人 Conversation、Session、Presentation 或 File Work Item，没有浏览器分页或搜索控件。
- **办公输出为新文档**——内容修改不保证保留任意原件的排版、动画、宏、公式和批注。旧二进制 DOC/XLS/PPT 和扫描 PDF 需要预先转换或 OCR；不提供后台同步。
- **授权展示不会注入上下文**——OA 和运行时 provider 必须在组装模型输入时落实每项选择；该浏览器包只读取和写入权威授权记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
