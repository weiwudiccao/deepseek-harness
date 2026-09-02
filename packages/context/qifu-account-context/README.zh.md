---
description: "在每轮首个模型步骤中注入员工授权的企福 OA 画像与账号记忆。"
kind: "package"
---

# @deepseek-ai/dsh-qifu-account-context

[English](README.md) | 中文

## 概述

这个需主动启用的宿主插件通过证书校验的企福网关，读取当前员工已授权的 OA 画像与账号记忆，并在每轮首个模型步骤中写入一条持久、来源明确的 user 消息。本机和云端运行时分别声明上下文类型，服务端据此执行员工对本机上下文的授权。

## 配置

所有字段均必填。`endpointEnv`、`tokenEnv` 与 `localContextEnv` 只填写环境变量名，profile 文件不承载凭据或部署值。接口必须使用 HTTPS；本机标记只能是 `true` 或 `false`；`timeoutMs` 与 `maxResponseBytes` 必须是正安全整数。

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

## 失败行为

部署配置无效时插件启动失败。单轮请求超时、非成功响应、JSON 不合法或响应过大时，本轮不注入账号上下文，但员工任务继续执行。TLS 证书校验仍由运行时配置的证书信任负责。

## 模型体验

### 上下文注入

#### 模型会看到什么

第一步只转发当前提示文本及本机／云端标记。成功响应会成为一条 `snapshot` 形式的消息，包含 `qifu-employee-profile` 和／或 `qifu-account-memory` 区段。模型只看到员工已授权区段的原文，区段间以空行分隔。服务端上下文快照编号只附在来源信息中，不进入模型可见文本；网关令牌、员工内部编号、授权记录与快照编号均不会进入提示文本。后续步骤复用已持久化的首步消息，不再创建服务端快照。

#### Token 影响

每轮最多新增两个由服务端限制长度的区段，且仅注入一次，因此 Token 增量只来自已授权画像与相关记忆文本。

#### KV 缓存影响

之前的快照作为普通对话历史保留，并可由会话压缩策略处理。每轮新的首步快照会改变该轮请求前缀。
