---
description: "Employee-authorized Qifu OA profile and account-memory request context for operators configuring local and cloud agent runtimes."
kind: "package-reference"
---

# @deepseek-ai/dsh-qifu-account-context

English | [中文](README.zh.md)

## Summary

`dsh-qifu-account-context` adds the current employee's consent-filtered OA profile and account memory to the first model step of each turn. The plugin requests the data through a certificate-validated HTTPS endpoint and stores the accepted sections as one source-attributed user message. Local and cloud processes declare their context type independently, so the Qifu server can enforce the employee's local-context consent. A context request failure does not stop the employee's task.

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

Mount this plugin in a Cordis composition that already provides the `agents` service. Supply environment-variable names for the endpoint, employee session token, and runtime context type instead of placing deployment values in the composition.

### When to choose it

Choose this plugin for Qifu runtimes that may personalize a model turn with employee-authorized server context. Do not mount it in a generic DSH runtime that has no Qifu employee session or consent source.

### Minimal configuration

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

Every field is required and has no package default. The three `*Env` values name uppercase environment variables. The endpoint value must use HTTPS, and the local-context value must be exactly `true` or `false`. Both numeric limits must be positive safe integers.

| Field | Default | Meaning |
|---|---|---|
| `endpointEnv` | required | Environment variable containing the certificate-validated context endpoint |
| `tokenEnv` | required | Environment variable containing the current employee gateway session token |
| `localContextEnv` | required | Environment variable containing `true` for local work or `false` for cloud work |
| `timeoutMs` | required | Maximum duration of one context request |
| `maxResponseBytes` | required | Maximum accepted JSON response size |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-qifu-account-context) is the exhaustive source for accepted fields and their JSDoc.

### Failure behavior

Invalid environment names, missing deployment values, a non-HTTPS endpoint, or invalid limits fail plugin load. A timeout, rejected redirect, non-success response, non-JSON response, invalid payload, or oversized response skips context for that turn and lets the agent continue. TLS certificate trust remains owned by the launching runtime.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin validates process-level deployment configuration when Cordis mounts it. Its prepended first-step listener waits for earlier request preparation, extracts at most 4,000 characters from the current user prompt, and sends the prompt with the local/cloud flag to the configured gateway. A bounded response schema accepts up to two named sections, each with at most 6,000 characters. The plugin joins accepted text with one blank line and appends one durable `snapshot` message whose section provenance retains the server snapshot id.

The optional invariant companion verifies that durable section provenance exactly reconstructs the model-visible message. Mount that companion only in compositions that provide the invariant service.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Configuration validation, bounded HTTPS request, and first-step context injection |
| [`src/invariant.ts`](src/invariant.ts) | Durable snapshot reconstruction invariant |
| [`tests/qifu-account-context.spec.ts`](tests/qifu-account-context.spec.ts) | Request, failure, configuration, and reconstruction coverage |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the surrounding composition and employee-work decisions.

- [Context packages](../README.md) — sibling request-context capabilities.
- [Session subsystem](../../../docs/subsystems/session.md) — durable message and Session ownership.
- [Qifu employee work surface](../../../.agents/notes/proposed/feature/2026-09-02-qifu-employee-work-surface.md) — consent and local/cloud product boundaries.
- [Qifu default Local Workspace](../../../.agents/notes/implemented/feature/2026-09-03-qifu-default-local-workspace.md) — employee-isolated local runtime behavior.

-----

<a id="model-experience"></a>
## Model Experience

### Context injection

#### What the model sees

On step one, the plugin forwards only the current prompt text and the local/cloud context flag. A successful response becomes one `snapshot`-form message with `qifu-employee-profile` and/or `qifu-account-memory` sections. The model sees the exact authorized section text joined with a blank line. The server's context snapshot id is attached to section provenance, not to model-facing prose; the model does not receive the gateway token, internal employee id, consent record, or snapshot id. Later steps reuse the durable first-step message and do not create another server snapshot.

#### Token effect

At most two server-bounded sections are added once per turn, so token use grows only with the authorized profile and relevant memory text.

#### KV Cache effect

Unchanged prior snapshots remain ordinary conversation history and can be compacted by the configured session policy. A new first-step snapshot changes the request prefix for that turn.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package needs another runtime or product-level control.

- **Context type is process-level** — `localContextEnv` is read when the plugin mounts, so one process cannot mix local and cloud sessions with different consent treatment.
- **Gateway failures are fail-open** — the agent continues without personalized context, and this package does not provide a user-visible warning or retry control.
- **Response vocabulary is fixed** — the gateway can return only `qifu-employee-profile` and `qifu-account-memory`, with no more than two bounded sections.
- **No credential storage** — the launching product must supply and rotate the employee session token through the named environment variable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
