---
description: "Authenticated employee account at the desktop sidebar foot with Settings revealed from its menu through an allowlisted preload bridge."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-employee-identity

English | [中文](README.zh.md)

## Summary

This package shows the authenticated employee name and designation as the desktop sidebar account control. Choose it for a deployment whose preload bridge exposes the current OA employee from `/auth/session`; the expanded sidebar shows both values, while the collapsed rail keeps an initials avatar with a tooltip. Settings stays hidden until the user opens the account menu. The package validates the gateway response and stores no employee identity in browser storage. It only confirms the active identity visually: the gateway must enforce authentication and per-employee DSH runtime isolation.

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

Mount this plugin with the locale, renderer, and sidebar browser rows in the authenticated desktop composition. The preload bridge must answer `gatewayRequest('/auth/session')` with `{ status: 200, body: { ok: true, employee: { id, name, designation } } }` for the current desktop session.

### When to choose it

Choose this package when a desktop deployment needs visible confirmation of the OA employee who owns the current DSH runtime and a compact account menu at the sidebar foot. The plugin stays inactive when the preload bridge is absent, so ordinary Web surfaces keep the direct Settings trigger from ui-settings-general.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-client-ui-employee-identity'
```

The plugin accepts no configuration fields. The generated [configuration catalog](../../../docs/config-catalog.md) lists it among loadable plugins without a `config:` block.

### Failure behavior

An absent preload bridge or a rejected or invalid `/auth/session` response renders the direct Settings trigger. A gateway or response-read failure also uses that fallback and reports the failure to the browser console; it does not expose stale identity data.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers typed Chinese and English dictionaries and occupies the declaration-aware `settings.account` seat only when the desktop preload bridge exists. `EmployeeIdentityRow` performs one cancellable bridge request when it mounts; the parser accepts only a successful response with non-empty employee id and name plus a string designation. The expanded button renders the profile values, the collapsed button keeps an initials avatar, and the shared Menu primitive reveals Settings above the account control. The settings shell supplies the panel-opening callback and retains panel lifecycle ownership.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Dictionaries and slot registration |
| [`src/client/identity.ts`](src/client/identity.ts) | Gateway response validation and read |
| [`src/client/EmployeeIdentityRow.tsx`](src/client/EmployeeIdentityRow.tsx) | Expanded and collapsed presentation |
| [`src/invariant.ts`](src/invariant.ts) | Package ownership companion; no mutable runtime invariant |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the identity row is not enough. They move from the sidebar seat to the deployment boundary that owns isolation.

- [ui-settings](../ui-settings/README.md) — declares `settings.account` and the other settings slots.
- [Web client architecture](../../../docs/subsystems/web-client.md) — browser plugin loading and slot composition.
- [Employee runtime isolation decision](../../../.agents/notes/implemented/feature/2026-09-01-employee-runtime-isolation-and-identity.md) — gateway ownership, storage boundary, and rejected alternatives.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package reads authenticated employee metadata for browser presentation only; it registers no prompt, tool, Session event, or model input.

#### KV Cache effect

None; the employee identity read and sidebar rendering never alter a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the identity row can guarantee. They are current package constraints, not an authentication backlog.

- **Presentation is not authorization** — the authenticated gateway must select an employee-owned DSH runtime for every HTTP and WebSocket request; this package cannot isolate a shared runtime.
- **One read per login** — a name or designation changed in OA becomes visible after the next successful employee login, not through live profile push.
- **Generic fallback** — an invalid or unavailable gateway profile shows the direct Settings trigger rather than an OA User id or cached identity.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
