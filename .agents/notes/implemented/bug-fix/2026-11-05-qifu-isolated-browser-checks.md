# Agent Note: Isolated Qifu browser checks

Status: implemented

English | [中文](2026-11-05-qifu-isolated-browser-checks.zh.md)

## Problem

Starting a personal browser for an agent check couples page inspection to employee logins and encrypted browser storage. A separate Chrome process can also fail when its native renderer sandbox is initialized inside the command runner's file sandbox. Replacing HOME or disabling sandboxing does not preserve the intended isolation, and model instructions alone cannot guarantee a particular launch or awaited cleanup.

## Decision

The independently enabled Qifu `browser_test` tool accepts only an HTTP(S) URL without embedded credentials. It reads DOM through the desktop application's existing Electron engine, using a fresh sandboxed renderer with Node integration disabled, context isolation enabled, and an in-memory partition. The desktop endpoint denies permissions, downloads, and non-HTTP(S) navigation. No personal browser profile, keychain configuration, separate Chrome installation, or subprocess launch is involved.

The desktop launcher supplies a random bearer token and a fixed-path loopback URL to its local Harness runtime. The Host uses direct HTTP, without ambient proxy routing or redirects, and admits neither endpoint nor credentials as model parameters. UUID and creation-time headers identify each request before its body is complete; cancellation uses the same identity. DOM input and output are bounded and validated at the transport parser. Successful results contain only the requested canonical URL, DOM, and a truncation flag, all recorded through the tool result.

Timeout, cancellation, and disposal wait for the desktop endpoint to acknowledge renderer destruction. Unknown cancellation identities remain cancelled if their POST arrives later; a failed acknowledgement remains an error. The desktop endpoint owns renderer lifecycle and enforces a 30-second deadline, a 1-MiB DOM ceiling, and two concurrent reads. Host configuration can narrow deadline and output limits. This is a sandboxed browser read, not a claim that the Session's DSH filesystem policy confines the renderer.

Browser guidance directs the model to this tool. A separate tool guard rejects statically recognizable direct Chrome, Chromium, or Edge launches in Bash. PowerShell recognition covers only the first literal browser executable, with optional `&` invocation and one preceding literal `$env:HOME` assignment. The guard is not a complete parser for either shell and does not resolve aliases, indirect scripts, dynamic evaluation, later PowerShell commands, or other launch mechanisms. The [Qifu desktop host-operations decision](../architecture/2026-10-30-qifu-desktop-host-operations.md) retains ownership of employee runtime generations, gateway credentials, and native dialogs.

## Alternatives considered

**Use only model instructions.** Guidance cannot establish isolated renderer settings or awaited destruction. The desktop endpoint owns those properties; guidance remains useful for launch paths the guard cannot recognize.

**Launch a separate Chrome or replace HOME.** A second browser duplicates the existing desktop engine and requires platform-specific profile, crash-reporting, temporary-file, and nested-sandbox management. Replacing HOME changes filesystem identity without proving personal browser state is absent.

**Disable browser or host sandboxing.** A launch failure must not become an unconfined retry. The renderer keeps its native sandbox; the tool performs no shell command that requires a broader DSH file policy.

## Consequences

The tool provides DOM evidence without screenshots, layout fidelity, interactive automation, or existing employee browser logins. HTTP(S) navigation has no destination-host allowlist and provides no network isolation. The authenticated desktop bridge is required; a standalone CLI does not silently launch another browser when it is absent.

Loopback HTTP tests cover endpoint and token validation, URL rejection, bounded multibyte DOM, malformed responses, transport failures, cancellation acknowledgement, timeout, disposal, and failed cleanup. They do not establish native renderer settings or the absence of operating-system prompts on a real installation; release acceptance owns that evidence.

The release-test parent owns temporary desktop data and removes it after Electron exits. Removing an active Electron data directory can fail under Windows file locking; teardown errors must remain visible and terminate the test as a failure.
