# Agent Note: 会话所属的企福办公文档

Status: implemented

[English](2026-11-03-qifu-office-documents.md) | 中文

## Problem

图片附件协议不能表达 Office 文档；在云端 Host 打开文件也不等于下载到员工电脑。文件系统服务尚无二进制写入操作。

## Decision

企福工作界面插件拥有按需启用的 `office_read` / `office_create` 工具和员工运行时 Harness home 下的不可变文档。随机文档 ID 归属单个会话，文件名不能选择宿主路径。Connection 提供鉴权导入、列表和下载。产物保留原件。

固定版本 officeparser 在可终止的 worker 中运行，限制字节、解压膨胀、文本、时间和堆内存。worker 仅接收安全的临时目录变量，不继承员工凭据。远程资源、宏、脚本和 OCR 均停用。随包中文字体让 PDF 生成不依赖系统字体。两种企福启动器启用该能力；普通 Harness profile 保持停用。

## Alternatives considered

扩展图片协议会让 Office 存储与图片规范化及两套 SDK 耦合。向模型指定路径写二进制文件会绕过文件系统写入保护。要求 Office、Python 或远程转换器会增加机器依赖，或隐式上传本机原件。

## Consequences

原件留在用户选择的运行时；模型读取的文本仍经配置的模型服务传输。内容修改生成新的现代格式文档，不保留任意原件的版式、动画、公式或宏特性。旧 DOC/XLS/PPT 需要转换；扫描 PDF 需要 OCR。测试覆盖中文格式往返、会话隔离、鉴权下载、取消和真实 Loader 工具交互。安装包与真机验收仍是单独的发布证据。
