---
description: "面向使用同源员工网关和逐账号运行时隔离的部署，在 Web 侧边栏底部显示已认证员工姓名和岗位名称。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-employee-identity

[English](README.md) | 中文

## 概述

该包在 Web 侧边栏的「设置」正上方显示已认证员工的姓名和岗位名称。部署的同源网关通过 `/auth/session` 公开当前 OA 员工时应选择该包；展开的侧边栏显示两个值，折叠轨道则保留带提示框的身份图标。该包校验网络响应、禁用 HTTP 缓存，并且不会在浏览器存储中保存员工身份。它只用于直观确认当前身份：认证和逐员工 DSH 运行时隔离必须由网关落实。

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

在已认证 Web 组合中，把该插件与 locale、renderer 和 sidebar 浏览器条目一起挂载。网关必须针对当前浏览器会话用 `{ ok: true, employee: { id, name, designation } }` 响应 `GET /auth/session`。

### 何时选择

部署需要直观确认当前 DSH 运行时所属的 OA 员工时，应选择该包。Web 表面没有员工网关时应将它移出组合；可选的 `sidebar.identity` 席位会保持为空。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-client-ui-employee-identity'
```

该插件不接受配置字段。生成的[配置目录](../../../docs/config-catalog.zh.md)将它列在不含 `config:` 块的可加载插件中。

### 失败行为

`/auth/session` 响应缺失、被拒绝或无效时，界面不渲染身份行。网络或响应读取失败也会让身份行保持为空，并向浏览器控制台报告失败；它不会展示陈旧的身份数据。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节——点击展开</summary>

浏览器插件注册类型化中英文词典，并占用声明感知的 `sidebar.identity` 席位。`EmployeeIdentityRow` 挂载时执行一次可取消的同源读取；解析器只接受员工 id 和姓名非空、岗位名称为字符串的成功响应。展开行渲染资料值，折叠行则使用共享 Tooltip primitive 提供相同值，而不会加宽轨道。

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 词典和 slot 注册 |
| [`src/client/identity.ts`](src/client/identity.ts) | 网关响应校验和读取 |
| [`src/client/EmployeeIdentityRow.tsx`](src/client/EmployeeIdentityRow.tsx) | 展开和折叠状态展示 |
| [`src/invariant.ts`](src/invariant.ts) | 包所有权 companion；没有可变运行时 invariant |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

身份行不足以回答问题时，请阅读这些页面。它们从侧边栏席位逐步深入到拥有隔离职责的部署边界。

- [ui-sidebar](../ui-sidebar/README.zh.md)——声明 `sidebar.identity` 并将其放在「设置」上方。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——浏览器插件加载和 slot 组合。
- [员工运行时隔离决策](../../../.agents/notes/implemented/feature/2026-09-01-employee-runtime-isolation-and-identity.zh.md)——网关所有权、存储边界和被拒绝的替代方案。

-----

<a id="model-experience"></a>
## 模型体验

无；该包只读取已认证员工元数据用于浏览器展示，不注册提示词、工具、会话事件或模型输入。

#### KV 缓存影响

无；员工身份读取和侧边栏渲染永远不会改变 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定身份行能够保证的范围。它们是当前包约束，不是认证待办列表。

- **展示不等于授权**——同源网关必须为每个 HTTP 和 WebSocket 请求选择员工自有的 DSH 运行时；该包无法隔离共享运行时。
- **每次登录只读取一次**——OA 中的姓名或岗位名称变更会在员工下次成功登录后出现，而不会通过实时资料推送出现。
- **没有独立回退**——网关资料无效或不可用时，席位保持为空，不显示 OA User id 或缓存身份。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
