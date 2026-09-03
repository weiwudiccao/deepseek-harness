# Agent Note: 企福桌面运行时默认本机工作区

Status: implemented

[English](2026-09-03-qifu-default-local-workspace.md) | 中文

## Problem

员工桌面运行时拥有隔离的 `DSH_HOME`，但启动时的 Workspace 注册表为空。通用 Web 客户端因此没有创建新 Session 所需的路径，切换到本机内容后“新会话”仍不可用。运行时切换失败也只通过桌面桥返回，侧边栏不会展示失败原因。

完整的[企福员工工作界面提案](../../proposed/feature/2026-09-02-qifu-employee-work-surface.zh.md)要求本机内容留在员工设备上，除非员工明确发布单个对象。桌面端需要一个立即可用的本机路径，同时不能默认注册用户的“文稿”目录或其他账号的目录。

## Decision

桌面端在当前员工哈希应用数据主目录内创建 `local-workspace` 目录，并设置仅所有者可访问的权限。它把本机 DSH 进程启动令牌交换为签名 loopback Cookie 后，调用已认证的 `workspace/create` RPC；需要时再通过 `workspace/rename` 把产品名称设置为 `本机工作区`。Workspace 注册和 Electron Cookie 写入均在窗口从云端工作切换到本机来源前完成。

桌面端把产品自有 Web profile overlay 规范化为只包含企福账号上下文插件。Web profile 不提供 invariant 服务，因此不挂载该插件的 invariant companion。打包 profile 的客户端发现会沿每个 app-boot 模块代理进入 VFS 中的源 package manifest，使本机 Web 启动图包含真实浏览器名册。封装后的 macOS 运行时可能在 loopback 监听器接受连接前一瞬间公布来源地址，所以令牌交换只在连接被拒绝或重置时进行有限重试。已认证的 Workspace RPC 使用 Node loopback HTTP 客户端并设置五秒响应上限，不依赖 Electron 面向渲染进程的 fetch 栈；HTTP、Cookie 和 RPC 失败仍立即终止启动。

受管目录、进程工作目录与 Workspace 注册表都使用同一个员工派生存储键。本机进程从该受限目录启动，避免通用 Web 在公布 loopback 来源前检查范围过大的“文稿”目录。打包后的 preset 发现会枚举条目名称并使用 `lstat`，不依赖原生 `Dirent` 方法，使 Session 创建能在可执行文件 VFS 中解析所选 preset，同时不跟随符号链接。再次登录的员工复用规范 Workspace 注册和归属其中的 Session；同一设备上的不同 OA 用户获得不同数据主目录。本机会话和文件留在设备上；模型请求仍可能使用已配置的网关，只有员工明确执行会话或文件发布操作时才会生成企福云端副本。

桌面桥把初始化失败结果返回企福侧边栏。一次切换进行期间禁用切换操作；切换失败时展示桌面端返回的具体错误或本地化兜底文案，不再静默无响应。

## Alternatives considered

**要求每名员工开始本机工作前先选择原生目录。** 该方式适合由员工明确选择外部项目目录，但会阻止空账号创建首次 Session，并使本机会话持久化依赖目录选择器。员工仍可另行添加明确选择的目录；受管默认目录负责提供安全的初始 Workspace。

**自动注册用户的“文稿”目录。** 同一操作系统用户下的所有 OA 账号共享该目录，其中还可能包含无关个人文件。哈希应用数据主目录能把默认访问范围限制为当前账号。

**在没有注册 Workspace 时启用输入框。** Session 会缺少文件系统策略、会话分组和持久 Workspace 所有权所需的真实路径。运行时初始化通过真实注册表条目解决问题，不覆盖通用客户端状态。

## Consequences

员工首次切换到本机内容时会看到一个真实的 `本机工作区`，“新会话”无需预先选择目录即可创建或复用其中的空白 Session。本机 Web 进程在该目录中启动，因此过大或由云存储提供商承载的“文稿”目录不会延迟就绪。打包运行时验收必须在 Workspace 注册后创建一个 Session，从而同时覆盖 Web 启动图和 preset 发现，而不是只检查 HTTP 已就绪。已有员工主目录在下次本机运行时启动时幂等获得该注册，不会通过迁移直接修改 Workspace JSON 存储。

默认 Workspace 位于应用受管存储，而不是显眼的“文稿”目录。员工要把现有项目目录加入为另一个 Workspace 时，仍需要独立目录选择流程。本机运行时就绪条件包括规范 profile 准备、有限 loopback 监听就绪等待、令牌交换、Workspace 创建或重命名及 Electron Cookie 写入；任何失败都会停止本机进程，并在侧边栏中可见。
