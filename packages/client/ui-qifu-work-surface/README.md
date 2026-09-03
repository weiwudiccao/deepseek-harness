---
description: "Desktop employee navigation for permission-derived features, cloud work, device-local work, explicit publication, and profile or memory consent."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-qifu-work-surface

English | [中文](README.zh.md)

## Summary

This package gives an authenticated Qifu desktop employee one sidebar with three explicit areas: permission-derived Features, company Cloud Work, and content on this device. It preserves the standard Workspace and Session browser inside the active runtime area, so local content stays in the employee-specific device runtime until the employee publishes one file or Session snapshot. The Settings contribution exposes four independent profile and memory choices that default off in OA. Choose it only with the Qifu desktop preload bridge and authenticated gateway; ordinary Web compositions register no Qifu surface.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in the Qifu desktop Web bundle after the sidebar, session controller, locale, renderer, and settings services. The desktop preload must expose the typed `qifuDesktop` bridge, and the gateway must answer the versioned `/qifu/v1` routes for the authenticated employee.

### When to choose it

Choose this package for the certificate-pinned Qifu desktop deployment that has employee-scoped cloud and local runtimes. Leave it out of ordinary Web deployments and deployments without the Qifu gateway; the standard sidebar then renders its Workspace browser directly.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-client-ui-qifu-work-surface'
```

The plugin accepts no configuration fields. The gateway owns features, cloud metadata, authorization, transfer policy, and consent; the desktop bridge owns runtime switching, feature launch, native file selection, and explicit publication.

### Failure behavior

The package never substitutes a static feature catalog when bootstrap fails. It shows an unavailable or empty state, leaves local Workspace and Session data under the active device runtime, and reports failed runtime switches and publication without treating either operation as successful.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers typed Chinese and English dictionaries, replaces the optional `sidebar.workSurface` composition seat, and adds one `settings.section` occupant. The sidebar owner supplies the already-rendered standard Workspace browser; `QifuWorkSurface` places it under Cloud Work or Local Content according to the desktop runtime mode. Gateway responses are parsed into controlled feature and cloud-item fields, while every privileged action crosses the allowlisted preload bridge. `PersonalizationSection` reads and writes the complete four-field consent record and restores the previous value when a write fails.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Desktop-only locale and slot registration |
| [`src/client/QifuWorkSurface.tsx`](src/client/QifuWorkSurface.tsx) | Features, Cloud Work, Local Content, runtime switching, and publication actions |
| [`src/client/PersonalizationSection.tsx`](src/client/PersonalizationSection.tsx) | Four independent profile and memory consent controls |
| [`src/client/api.ts`](src/client/api.ts) | Typed desktop-gateway bridge and response validation |
| [`src/invariant.ts`](src/invariant.ts) | Package ownership companion; no mutable runtime invariant |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages describe the generic seats and the Qifu deployment decisions that this package composes.

- [ui-sidebar](../ui-sidebar/README.md) — owns `sidebar.workSurface` and the standard Workspace browser handoff.
- [ui-settings](../ui-settings/README.md) — owns the settings section lifecycle.
- [Employee runtime isolation](../../../.agents/notes/implemented/feature/2026-09-01-employee-runtime-isolation-and-identity.md) — separates employee cloud Sessions and identity presentation.
- [Qifu desktop default Local Workspace](../../../.agents/notes/implemented/feature/2026-09-03-qifu-default-local-workspace.md) — owns the employee-isolated initial directory and runtime readiness behavior.
- [Qifu employee work-surface proposal](../../../.agents/notes/proposed/feature/2026-09-02-qifu-employee-work-surface.md) — owns the wider data, transfer, personalization, and upgrade decisions.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side employee navigation and consent presentation that registers nothing model-facing.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits distinguish the shipped browser surface from responsibilities owned by the gateway, OA, desktop runtime, and later proposal phases.

- **Desktop only** — the package deliberately stays inactive when the `qifuDesktop` preload bridge is absent.
- **The cloud list is a recent projection** — the first surface reads at most 50 Work Items and has no browser pagination or search control.
- **Publication is one-way in this slice** — the bridge publishes one local file or one local Session snapshot; cloud-to-local download and background synchronization are not exposed.
- **Consent presentation does not inject context** — OA and runtime providers must enforce each choice when they assemble model input; this browser package only reads and writes the authoritative consent record.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
