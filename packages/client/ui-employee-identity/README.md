---
description: "Authenticated employee name and designation at the Web sidebar foot for deployments using a same-origin employee gateway and per-account runtime isolation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-employee-identity

English | [中文](README.zh.md)

## Summary

This package shows the authenticated employee name and designation directly above Settings in the Web sidebar. Choose it for a deployment whose same-origin gateway exposes the current OA employee through `/auth/session`; the expanded sidebar shows both values, while the collapsed rail keeps an identity icon with a tooltip. The package validates the network response, disables HTTP caching, and stores no employee identity in browser storage. It only confirms the active identity visually: the gateway must enforce authentication and per-employee DSH runtime isolation.

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

Mount this plugin with the locale, renderer, and sidebar browser rows in an authenticated Web composition. The gateway must answer `GET /auth/session` with `{ ok: true, employee: { id, name, designation } }` for the current browser session.

### When to choose it

Choose this package when a deployment needs visible confirmation of the OA employee who owns the current DSH runtime. Leave it out when the Web surface has no employee gateway; the optional `sidebar.identity` seat then stays empty.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-client-ui-employee-identity'
```

The plugin accepts no configuration fields. The generated [configuration catalog](../../../docs/config-catalog.md) lists it among loadable plugins without a `config:` block.

### Failure behavior

An absent, rejected, or invalid `/auth/session` response renders no identity row. A network or response-read failure also leaves the row empty and reports the failure to the browser console; it does not expose stale identity data.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers typed Chinese and English dictionaries and occupies the declaration-aware `sidebar.identity` seat. `EmployeeIdentityRow` performs one cancellable same-origin read when it mounts; the parser accepts only a successful response with non-empty employee id and name plus a string designation. The expanded row renders the profile values, and the collapsed row lets the shared Tooltip primitive expose the same values without widening the rail.

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

- [ui-sidebar](../ui-sidebar/README.md) — declares and positions `sidebar.identity` above Settings.
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

- **Presentation is not authorization** — the same-origin gateway must select an employee-owned DSH runtime for every HTTP and WebSocket request; this package cannot isolate a shared runtime.
- **One read per login** — a name or designation changed in OA becomes visible after the next successful employee login, not through live profile push.
- **No standalone fallback** — an invalid or unavailable gateway profile leaves the seat empty rather than displaying the OA User id or cached identity.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
