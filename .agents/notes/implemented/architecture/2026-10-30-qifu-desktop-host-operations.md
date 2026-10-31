# Agent Note: Qifu desktop host operations

Status: implemented

English | [中文](2026-10-30-qifu-desktop-host-operations.zh.md)

## Problem

The Qifu desktop client embeds the DSH SEA runtime and connects employee sessions to an HTTPS model gateway. A packaged runtime cannot be treated as a general Node executable for a native-dialog child, and a proxy cannot attach upstream compression metadata to a decoded response body.

## Decision

The Electron preload exposes directory selection to the native directory-flow consumer. The main process accepts only its trusted local-runtime renderer, opens Electron's directory dialog, and checks the active local runtime again before returning the selected path. Cancellation returns null. Browser consumers without the bridge keep the Host-native RPC picker. The [single-file runtime decision](2026-07-10-single-file-executable-sdk-runtime-distribution.md) retains ownership of the SEA application entry; directory selection adds no runtime argv escape or system Node requirement.

Each local runtime belongs to one employee id and one gateway login-token generation. Entering local mode revalidates the employee session before reusing a process. Successful login retires the previous generation, including pending starts; failed login preserves the active generation. A retired child cannot publish itself or send the current client back to login when it exits. Login tokens remain in memory and are never included in diagnostic output.

The model gateway forwards the body exposed by Fetch and removes content-encoding and content-length from upstream response headers. Fetch has already decoded compressed bytes, so those two fields no longer describe the forwarded representation. Authentication, certificate pinning, model credentials, and the remaining response-header filters retain their existing owners.

Chat and native web search use separate runtime endpoint variables. Both Qifu runtimes set DEEPSEEK_BASE_URL and DEEPSEEK_SEARCH_BASE_URL to the employee-authenticated /qifu-model/v1 gateway. The messages route uses an independently configured Anthropic upstream and replaces both Bearer and x-api-key credentials with the server-owned key. An absent search upstream fails instead of falling back to the chat origin. Search acceptance requires structured, citeable sources rather than HTTP 200 alone.

## Alternatives considered

**Launch the dialog script through the SEA executable.** The embedded bootstrap selects the DSH application entry rather than arbitrary script arguments. The resulting child exits without sending the dialog result.

**Add an arbitrary-script SEA entry or require installed Node.** Either changes the supported application-launch model merely to reach a desktop capability Electron already owns.

**Forward compressed-response metadata unchanged.** The client tries to decode an already decoded Brotli or Gzip stream and fails after receiving HTTP 200. A successful non-streaming provider request does not establish streaming-proxy correctness.

## Consequences

Directory selections remain on the employee's computer and cannot be returned after switching to cloud mode. The browser RPC picker remains available outside the desktop bridge; its plain-Node worker tests do not establish SEA compatibility. Gateway regression tests use real compressed HTTP bodies and require the complete SSE completion sentinel. Release acceptance checks the packaged desktop identity and runtime in addition to source-level tests; native Windows dialog interaction still requires Windows-device evidence.
