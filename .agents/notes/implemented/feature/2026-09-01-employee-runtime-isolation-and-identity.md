# Agent Note: Isolate employee runtimes and display authenticated identity

Status: implemented

English | [中文](2026-09-01-employee-runtime-isolation-and-identity.zh.md)

## Problem

An employee-authenticated deployment can validate multiple OA accounts while still proxying every account into one DSH process. Because one process resolves one `DSH_HOME`, every authenticated employee then sees the same durable Sessions, settings, and browser authentication cookie. Filtering rows in the client cannot enforce isolation because the underlying API and WebSocket still expose the shared runtime.

The same deployment also lacks a visible confirmation of which employee is active. A user can authenticate successfully without seeing the employee name or designation returned by the authoritative OA record.

## Decision

The authentication gateway keys runtime ownership by the authenticated OA User id. It derives a non-reversible filesystem-safe key, creates one persistent home under the gateway's user-data root, and lazily starts one loopback DSH process with both `HOME` and `DSH_HOME` set inside that employee directory. Concurrent requests for the same employee share one startup promise and one DSH browser cookie; different employees receive different directories, processes, ports, and cookies. HTTP and WebSocket requests resolve the authenticated gateway session before selecting a runtime.

The OA login response is the identity authority. The gateway retains only the stable User id, employee id, employee name, designation, OA session cookie, and gateway session timing; it never retains the submitted password. `/auth/session` returns the employee display fields for the authenticated browser session.

The settings shell exposes an optional `settings.account` seat at the sidebar foot. In the desktop deployment, `@deepseek-ai/dsh-client-ui-employee-identity` reads `/auth/session` through the allowlisted preload bridge, validates the response, and replaces the direct Settings trigger with the employee name, designation, and initials avatar. Settings appears inside the account menu and opens through a shell-owned callback, so the settings package retains panel lifecycle ownership. The collapsed rail keeps the initials avatar and supplies the two profile values through a tooltip. The package does not persist identity in browser storage; an unavailable profile restores the direct Settings trigger. Ordinary Web deployments do not register the employee identity surface and retain the direct Settings trigger.

This boundary isolates DSH-owned Sessions, settings, credentials, and other data rooted at `DSH_HOME`. It does not create a separate source checkout or filesystem workspace for each employee: the deployment still chooses the working directory and filesystem policy independently.

## Verification

Gateway tests pin stable distinct storage keys, same-employee startup coalescing, different `DSH_HOME` values, runtime teardown, per-user HTTP routing, distinct DSH cookies, and the employee fields returned by `/auth/session`. Client tests pin response validation, expanded name/designation rendering, collapsed rendering, click-to-reveal Settings behavior, unavailable-profile fallback, slot lifecycle, and sidebar snapshots.

## Alternatives considered

**Filter shared Sessions in the browser.** The REST and WebSocket surfaces would remain shared, so a client defect or direct request could cross the apparent boundary.

**Run one DSH process with employee-prefixed Session ids.** DSH owns more durable state than Session ids, including settings and credentials. Prefixing one record type would leave the rest shared and would require employee awareness throughout unrelated packages.

**Create a fixed systemd unit and port for every employee.** Employee inventory changes dynamically, fixed ports require separate allocation, and inactive employees would consume processes. Lazy gateway-owned processes preserve durable homes without pre-provisioning every account.

**Put employee fetching in `ui-sidebar`.** The sidebar is a composition shell. The optional settings account seat keeps deployment authentication outside the generic shell, while deployments without an employee gateway retain the shell's direct Settings trigger.

## Consequences

Two authenticated employees cannot reach each other's DSH-owned Session history through the gateway because their requests terminate in different processes and persistent homes. A gateway restart stops its child processes, while the per-employee homes survive and restart lazily on the next request.

The deployment pays one Node process per active employee until the gateway restarts. Capacity limits and idle eviction can be added at the runtime-provider boundary if real concurrency requires them. Files under the configured shared working directory remain subject to the deployment's existing filesystem permissions and are not covered by Session isolation.
