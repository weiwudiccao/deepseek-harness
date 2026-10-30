# Agent Note: 企福桌面宿主操作

Status: implemented

[English](2026-10-30-qifu-desktop-host-operations.md) | 中文

## Problem

企福桌面客户端内置 DSH SEA 运行时，并通过 HTTPS 模型网关连接员工会话。打包后的运行时不能作为通用 Node 可执行程序启动原生对话框子进程，代理也不能给已经解压的响应体附上游压缩元数据。

## Decision

Electron 预加载层向原生目录流程消费者提供目录选择能力。主进程只接受其受信任的本机运行时渲染器，打开 Electron 目录对话框，并在返回所选路径前再次检查当前本机运行时。取消返回 null。没有该桥接能力的浏览器消费者继续使用宿主原生 RPC 选择器。[单文件运行时决策](2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)继续拥有 SEA 应用入口；目录选择不增加运行时 argv 绕行入口，也不要求系统安装 Node。

模型网关转发 Fetch 提供的响应体，并从上游响应头中移除 content-encoding 与 content-length。Fetch 已经解压压缩字节，这两个字段不再描述实际转发的表示。认证、证书锁定、模型凭据和其余响应头过滤规则继续由既有实现负责。

## Alternatives considered

**通过 SEA 可执行程序启动对话框脚本。** 内置引导程序选择 DSH 应用入口，而不是任意脚本参数。该子进程因此退出，无法发送对话框结果。

**增加任意脚本 SEA 入口或要求安装 Node。** 两者都会改变受支持的应用启动方式，仅为调用 Electron 已经拥有的桌面能力。

**原样转发压缩响应元数据。** 客户端尝试再次解压已经解压的 Brotli 或 Gzip 流，在收到 HTTP 200 后失败。非流式提供方请求成功不能证明流式代理正确。

## Consequences

目录选择保留在员工电脑上，切换到云端模式后不能返回本机路径。桌面桥接之外仍可使用浏览器 RPC 选择器；其普通 Node 工作进程测试不能证明 SEA 兼容性。网关回归测试使用真实压缩 HTTP 响应体，并要求完整的 SSE 完成标记。发布验收除源码测试外，还检查打包客户端身份和运行时；原生 Windows 目录对话框交互仍需要 Windows 设备上的证据。
