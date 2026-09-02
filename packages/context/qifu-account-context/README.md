---
description: "Employee-authorized Qifu profile and account-memory context for the first model step of each turn."
kind: "package"
---

# @deepseek-ai/dsh-qifu-account-context

English | [中文](README.zh.md)

## Summary

This opt-in host plugin requests the current employee's consent-filtered OA profile and account memory from the certificate-validated Qifu gateway. It adds the returned sections to the first model step of each turn as one durable, source-attributed user message. Local and cloud runtimes declare their context kind independently, so the server can enforce the employee's local-context consent.

## Configuration

All fields are required. `endpointEnv`, `tokenEnv`, and `localContextEnv` name environment variables rather than carrying credentials or deployment values in profile files. The endpoint must use HTTPS. The local-context value must be exactly `true` or `false`. `timeoutMs` and `maxResponseBytes` are positive safe integers.

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

## Failure behavior

Invalid deployment configuration fails plugin load. Request timeouts, non-success responses, malformed JSON, and oversized responses fail open for that turn: no account context is added, while the employee's task continues. TLS verification remains owned by the runtime's configured certificate trust.

## Model Experience

### Context injection

#### What the model sees

On step one, the plugin forwards only the current prompt text and the local/cloud context flag. A successful response becomes one `snapshot`-form message with `qifu-employee-profile` and/or `qifu-account-memory` sections. The model sees the exact authorized section text joined with a blank line. The server's context snapshot id is attached to section provenance, not to model-facing prose; the model does not receive the gateway token, internal employee id, consent record, or snapshot id. Later steps reuse the durable first-step message and do not create another server snapshot.

#### Token effect

At most two server-bounded sections are added once per turn, so token use grows only with the authorized profile and relevant memory text.

#### KV Cache effect

Unchanged prior snapshots remain ordinary conversation history and can be compacted by the configured session policy. A new first-step snapshot changes the request prefix for that turn.
