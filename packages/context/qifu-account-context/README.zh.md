---
description: "面向本机与云端 agent 运行时配置方的员工授权企福 OA 画像与账号记忆请求上下文。"
kind: "package-reference"
---

# @deepseek-ai/dsh-qifu-account-context

[English](README.md) | 中文

## 概述

`dsh-qifu-account-context` 把当前员工经同意过滤后的 OA 画像与账号记忆加入每轮的第一个模型步骤。插件通过证书校验的 HTTPS 接口请求数据，并把通过校验的区段存为一条带来源的 user 消息。本机与云端进程分别声明上下文类型，因此企福服务端可以执行员工对本机上下文的授权。上下文请求失败不会中断员工任务。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已经提供 `agents` 服务的 Cordis 组合中挂载此插件。配置接口、员工会话令牌和运行时上下文类型对应的环境变量名，不要把部署值写入组合。

### 何时选择

需要使用员工授权服务端上下文个性化模型轮次的企福运行时应选择此插件。没有企福员工会话或授权来源的通用 DSH 运行时不要挂载它。

### 最小配置

```yaml
- insert:
    - id: qifu-account-context
      name: '@deepseek-ai/dsh-qifu-account-context'
      config:
        endpointEnv: QIFUAI_CONTEXT_URL
        tokenEnv: QIFUAI_CONTEXT_TOKEN
        localContextEnv: QIFUAI_CONTEXT_LOCAL
        timeoutMs: 5000
        maxResponseBytes: 16384
```

所有字段都必填，且本包不提供默认值。三个 `*Env` 值必须是大写环境变量名。接口值必须使用 HTTPS，本机上下文值必须严格为 `true` 或 `false`。两个数字限制都必须是正安全整数。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `endpointEnv` | 必填 | 包含经证书校验上下文接口的环境变量 |
| `tokenEnv` | 必填 | 包含当前员工网关会话令牌的环境变量 |
| `localContextEnv` | 必填 | 包含本机工作 `true` 或云端工作 `false` 的环境变量 |
| `timeoutMs` | 必填 | 单次上下文请求的最长时间 |
| `maxResponseBytes` | 必填 | 可接受 JSON 响应的最大大小 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-qifu-account-context)是受支持字段及其 JSDoc 的穷尽式真源。

### 失败行为

环境变量名无效、部署值缺失、接口不是 HTTPS 或限制值无效时，插件加载失败。超时、重定向被拒绝、非成功响应、非 JSON 响应、载荷无效或响应过大时，本轮跳过上下文并让 agent 继续。TLS 证书信任仍由启动运行时负责。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Cordis 挂载插件时，插件会校验进程级部署配置。其前置首步监听器等待更早的请求准备，从当前用户提示中提取最多 4,000 个字符，并把提示与本机／云端标记发往已配置网关。受限响应 schema 接受最多两个具名区段，每段不超过 6,000 个字符。插件用一个空行连接通过校验的文本，并追加一条持久 `snapshot` 消息；区段来源保留服务端快照编号。

可选 invariant 伴生插件会验证持久区段来源能够精确重建模型可见消息。只在提供 invariant 服务的组合中挂载该伴生插件。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置校验、受限 HTTPS 请求与首步上下文注入 |
| [`src/invariant.ts`](src/invariant.ts) | 持久快照重建 invariant |
| [`tests/qifu-account-context.spec.ts`](tests/qifu-account-context.spec.ts) | 请求、失败、配置与重建覆盖 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面说明周边组合方式与员工工作决策。

- [上下文包](../README.zh.md)——同类请求上下文能力。
- [Session 子系统](../../../docs/subsystems/session.zh.md)——持久消息与 Session 所有权。
- [企福员工工作界面](../../../.agents/notes/proposed/feature/2026-09-02-qifu-employee-work-surface.zh.md)——授权与本机／云端产品边界。
- [企福默认本机工作区](../../../.agents/notes/implemented/feature/2026-09-03-qifu-default-local-workspace.zh.md)——员工隔离的本机运行时行为。

-----

<a id="model-experience"></a>
## 模型体验

### 上下文注入

#### 模型会看到什么

第一步只转发当前提示文本及本机／云端标记。成功响应会成为一条 `snapshot` 形式的消息，包含 `qifu-employee-profile` 和／或 `qifu-account-memory` 区段。模型只看到员工已授权区段的原文，区段间以空行分隔。服务端上下文快照编号只附在来源信息中，不进入模型可见文本；网关令牌、员工内部编号、授权记录与快照编号均不会进入提示文本。后续步骤复用已持久化的首步消息，不再创建服务端快照。

#### Token 影响

每轮最多新增两个由服务端限制长度的区段，且仅注入一次，因此 Token 增量只来自已授权画像与相关记忆文本。

#### KV Cache 影响

之前的快照作为普通对话历史保留，并可由会话压缩策略处理。每轮新的首步快照会改变该轮请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包何时需要另一种运行时或产品级控制。

- **上下文类型属于进程**——`localContextEnv` 在插件挂载时读取，因此一个进程不能混合采用不同授权处理的本机会话与云端会话。
- **网关失败时开放执行**——agent 会在没有个性化上下文的情况下继续，本包不提供用户可见警告或重试控制。
- **响应类别固定**——网关只能返回 `qifu-employee-profile` 与 `qifu-account-memory`，最多两个受限区段。
- **不存储凭据**——启动产品必须通过具名环境变量提供并轮换员工会话令牌。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
