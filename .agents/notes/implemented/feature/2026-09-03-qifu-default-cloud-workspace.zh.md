# Agent Note: 企福服务器运行时默认云端工作区

Status: implemented

[English](2026-09-03-qifu-default-cloud-workspace.md) | 中文

## Problem

员工服务器运行时拥有隔离的 `HOME` 和 `DSH_HOME`，但启动时没有注册任何 Harness Workspace。通用 Web 客户端因此禁用输入框并要求员工选择宿主机目录。该提示适用于由员工决定目录的本机内容，但它会在云端工作中暴露服务器文件系统概念，并阻止员工开始首次对话。

完整的[企福员工工作界面提案](../../proposed/feature/2026-09-02-qifu-employee-work-surface.zh.md)要求提供私有默认云端工作区。服务器运行时需要一个真实的 Harness Workspace 来持久化会话，同时不能把共享应用源码目录当成员工内容。

## Decision

员工运行时提供方在员工哈希数据主目录内创建 `cloud-workspace` 目录，并设置仅所有者可访问的权限。它把一次性 DSH 启动令牌交换成 loopback 认证 Cookie 后，调用已认证的 `workspace/create` RPC；需要时再通过 `workspace/rename` 把产品名称设置为 `云端工作区`。这两个操作都在网关向桌面客户端开放运行时前完成。

Workspace 按规范路径幂等创建。再次登录的员工复用同一注册表条目和目录，已有会话继续归属该 Workspace。通用 Workspace 导航服务观察到已注册的 Workspace 后，创建或复用其中的空白 Session 并将其打开，不需要增加企福专用客户端导航分支。

云端工作区初始化属于运行时就绪条件。注册或重命名失败会停止员工进程并使请求失败；网关不会退回 `/root/qifuaigent`、其他员工目录或未注册的当前工作目录。桌面端[默认本机工作区](2026-09-03-qifu-default-local-workspace.zh.md)负责对应的设备侧启动行为。

## Alternatives considered

**在企福客户端隐藏 Workspace 选择器。** 这种方式会在 Session 没有有效 Workspace 路径时启用输入框，削弱文件系统策略和持久化语义；它还会把云端工作行为耦合到视觉覆盖层，而运行时状态仍不完整。

**在进程启动前直接写入 Workspace 注册表文件。** 直接修改存储会绕过 Workspace 注册表对规范路径、顺序、schema 版本和事件所有权的管理。已认证 RPC 使初始化程序始终走受支持的变更路径。

**把应用检出目录作为默认 Workspace。** `/root/qifuaigent` 是共享部署源码，不是员工内容。注册该目录会让对话操作应用源码树，并破坏员工数据主目录边界。

## Consequences

员工首次进入云端工作时拥有真实的员工私有 Workspace 和可用的对话输入框，无需选择目录。现有员工在下一次运行时启动时惰性获得同一个 Workspace，不会通过迁移脚本直接修改其 Session 日志或 Workspace 注册表文件。

运行时启动会执行一次 loopback 创建请求；产品名称尚未设置时，再执行一次重命名请求。任何未认证、格式错误或失败的响应都会使启动快速失败。网关聚焦测试覆盖路径隔离、RPC 信封、幂等名称复用，以及初始化失败时停止进程。

该决策仅实现服务器会话所需的默认 Harness Workspace。OA 云端工作区目录、Work Item 投影、对象存储、传输状态机和团队 ACL 工作仍由完整提案负责。
