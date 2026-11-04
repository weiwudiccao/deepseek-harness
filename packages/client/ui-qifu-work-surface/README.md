---
description: "Desktop employee navigation for permission-derived features, cloud work, device-local work, explicit publication, and profile or memory consent."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-qifu-work-surface

English | [中文](README.zh.md)

## Summary

This package gives an authenticated Qifu desktop employee one sidebar with three explicit areas: permission-derived Features, employee-private Cloud Work, and content on this device. Cloud Work groups personal conversations and Sessions, designs, files, and explicit local publications; enterprise knowledge sources do not appear in this sidebar or move into Features. The package preserves the standard Workspace and Session browser inside the active runtime area, so local content stays in the employee-specific device runtime until the employee publishes one file or Session snapshot. The Settings contribution exposes four independent profile and memory choices that default off in OA. Choose it only with the Qifu desktop preload bridge and authenticated gateway; ordinary Web compositions register no Qifu surface.

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

The Host accepts `enabledEnv` (default `QIFUAI_OFFICE_ENABLED`), `dshHome`, `maxDocumentBytes` (25 MiB), `maxTextBytes` (1 MiB), `maxDocumentsPerSession` (100), and `maxReadLines` (2000), and `maxConcurrentOperations` (2). Office operations register only when the selected environment variable is `true`. The gateway owns features, employee-private cloud metadata, authorization, transfer policy, and consent; the desktop bridge owns runtime switching, feature launch, native file selection, and explicit publication.

### Office documents

Drop or paste documents into the session composer, or use its Office files picker. Non-image files enter the Session-owned document importer; images retain their attachment path. The document panel opens for import status, conversion errors, and downloads. A batch imports sequentially; a concurrent batch is refused visibly. The session composer imports DOCX, PPTX, XLSX, text PDF, HTML/HTM, CSV, TXT, Markdown, RTF, ODT, ODP, and ODS. Models read selected documents with `office_read` and generate those modern formats with `office_create`. Files live below the runtime's employee-specific `DSH_HOME`, keyed by Session and random document id. An output never overwrites an original or a model-supplied workspace path; the composer lists authenticated downloads. A local import stays on the local runtime; extracted content may still travel with the employee's model request.

Parsing and generation run in terminable workers without employee environment credentials, with byte, time, heap, XML, archive, and text limits. Remote assets, document macros, HTML scripts, and OCR are disabled. PDF generation includes the bundled SIL Open Font License Noto Sans SC font, avoiding a system-font prerequisite. A file name selects a supported parser; malformed or encrypted content fails instead of being sent as binary model input.

### Failure behavior

The package never substitutes a static feature catalog when bootstrap fails. It shows an unavailable or empty state, leaves local Workspace and Session data under the active device runtime, and reports failed runtime switches and publication without treating either operation as successful.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers typed Chinese and English dictionaries, replaces the optional `sidebar.workSurface` composition seat, and adds one `settings.section` occupant. The sidebar owner supplies the already-rendered standard Workspace browser; `QifuWorkSurface` places it under Cloud Work or Local Content according to the desktop runtime mode. Gateway responses are parsed into controlled feature fields and an allowlist of personal cloud kinds, then grouped as Sessions, Designs, and Files. Enterprise knowledge rows are discarded instead of being rendered or reclassified as Features. Every privileged action crosses the allowlisted preload bridge. `PersonalizationSection` reads and writes the complete four-field consent record and restores the previous value when a write fails.

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

### Office document tools

#### What the model sees

When enabled, `office_read` returns a bounded line window from an imported or generated document belonging to the calling Session. `office_create` accepts a filename, Markdown content, and output format, returning a new document's id, size, and digest. References enter the employee's draft; extracted text and output metadata enter context through logged tool results. Document text is data, never deployment instructions.

#### Token effect

The enabled tools add stable definitions and document guidance. Read results and complete Markdown creation arguments increase conversation tokens; the package does not call a model directly.

#### KV Cache effect

Tool definitions remain stable for a configuration. Results append to the conversation after the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits distinguish the shipped browser surface from responsibilities owned by the gateway, OA, desktop runtime, and later proposal phases.

- **Desktop only** — the package deliberately stays inactive when the `qifuDesktop` preload bridge is absent.
- **The cloud list is a recent personal projection** — the first surface reads at most 50 personal Conversation, Session, Presentation, or File Work Items and has no browser pagination or search control.
- **Office output is a new document** — content changes do not preserve arbitrary original layout, animations, macros, formulas, or comments. Binary DOC/XLS/PPT and scanned PDFs require prior conversion or OCR. Background synchronization is not exposed.
- **Consent presentation does not inject context** — OA and runtime providers must enforce each choice when they assemble model input; this browser package only reads and writes the authoritative consent record.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
