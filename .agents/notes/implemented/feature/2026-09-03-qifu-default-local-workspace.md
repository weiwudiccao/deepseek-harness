# Agent Note: Qifu desktop runtime default Local Workspace

Status: implemented

English | [中文](2026-09-03-qifu-default-local-workspace.zh.md)

## Problem

An employee desktop runtime has an isolated `DSH_HOME` but starts with an empty Workspace registry. The generic Web client therefore has no path for a new Session, so switching to Local Content cannot make “New session” usable. A failed runtime switch also returns only through the desktop bridge and leaves no visible explanation in the sidebar.

The broader [Qifu employee work-surface proposal](../../proposed/feature/2026-09-02-qifu-employee-work-surface.md) requires Local Content to remain on the employee device unless the employee explicitly publishes one object. The desktop needs an immediately usable local path without registering the user's Documents directory or another account's directory implicitly.

## Decision

The desktop creates a `local-workspace` directory inside the current employee's hashed application data root with owner-only permissions. After exchanging the local DSH process launch token for its signed loopback cookie, the desktop calls the authenticated `workspace/create` RPC and assigns the product title `本机工作区` through `workspace/rename` when necessary. Workspace registration and the Electron cookie installation complete before the window switches from Cloud Work to the local origin.

The desktop rewrites its product-owned Web profile overlay to the Qifu account-context plugin alone. It does not mount the plugin's invariant companion because the Web profile does not provide the invariant service. Packaged-profile client discovery follows each app-boot module proxy to the source package manifest in the VFS, so the local Web boot graph contains its real browser roster. A packaged macOS runtime may announce its origin immediately before the loopback listener accepts connections, so token exchange retries only refused or reset connections for a bounded interval. Authenticated Workspace RPC uses Node's loopback HTTP client with a five-second response limit instead of Electron's renderer-oriented fetch stack; HTTP, cookie, and RPC failures still fail immediately.

The managed directory, process working directory, and Workspace registry are all selected by the same employee-derived storage key. Starting the local process in that narrow directory prevents the generic Web boot from inspecting a broad Documents tree before it can announce its loopback origin. Packaged preset discovery enumerates entry names and uses `lstat` instead of relying on native `Dirent` methods, so Session creation can resolve the selected preset inside the executable VFS without following symlinks. Returning employees reuse the canonical Workspace registration and attached Sessions, while different OA users on one device receive different data roots. Local Sessions and files remain on the device; model requests may still use the configured gateway, and only the explicit session or file publication operations create a Qifu cloud copy.

The desktop bridge returns initialization failures to the Qifu sidebar. The switch action is disabled while one transition is in flight, and a failed transition shows the concrete desktop error or a localized fallback instead of remaining silent.

## Alternatives considered

**Require a native directory selection before every employee can start locally.** This preserves explicit control for external project directories but prevents an empty-account first Session and makes local conversation persistence depend on a chooser. Employees can add explicitly selected directories separately; the managed default supplies the safe initial Workspace.

**Register the user's Documents directory automatically.** That directory is shared by every OA account using the same operating-system profile and may contain unrelated personal files. The hashed application data root keeps the default narrow and account-specific.

**Enable the composer without a registered Workspace.** A Session would lack the concrete path required by filesystem policy, session grouping, and durable Workspace ownership. Runtime initialization creates the real registry entry instead of overriding generic client state.

## Consequences

The first Local Content transition exposes one real `本机工作区`, and “New session” can create or reuse its blank Session without a preliminary directory choice. The local Web process starts inside that directory, so a large or provider-backed Documents directory cannot delay readiness. Packaged-runtime acceptance must create a Session after Workspace registration, which covers both the Web boot graph and preset discovery instead of stopping at an HTTP-ready check. Existing employee homes receive the registration idempotently on their next local runtime start; no migration edits the Workspace JSON store directly.

The default Workspace lives in application-managed storage rather than a prominent Documents folder. Employees need a separate directory-picker flow when they want an existing project tree to become another Workspace. Runtime readiness includes canonical profile preparation, bounded loopback listener readiness, token exchange, Workspace creation or rename, and Electron cookie installation; any failure stops the local process and remains visible in the sidebar.
