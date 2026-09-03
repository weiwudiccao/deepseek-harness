# Agent Note: Qifu server runtime default Cloud Workspace

Status: implemented

English | [中文](2026-09-03-qifu-default-cloud-workspace.zh.md)

## Problem

An employee server runtime starts with an isolated `HOME` and `DSH_HOME` but no registered Harness Workspace. The generic Web client therefore disables the composer and asks the employee to choose a host directory. That prompt is valid for Local Content, where the employee owns the directory choice, but it exposes a server filesystem concept in Cloud Work and prevents a first conversation from starting.

The broader [Qifu employee work-surface proposal](../../proposed/feature/2026-09-02-qifu-employee-work-surface.md) requires a private default Cloud Workspace. The server runtime needs a concrete Harness Workspace for session persistence without treating the shared application source directory as employee content.

## Decision

The employee runtime provider creates a `cloud-workspace` directory inside the employee's hashed data home with owner-only permissions. After exchanging the one-time DSH launch token for the loopback authentication cookie, it calls the authenticated `workspace/create` RPC and assigns the product title `云端工作区` through `workspace/rename` when necessary. Both operations complete before the gateway exposes the runtime to the desktop client.

Workspace creation is idempotent by canonical path. Returning employees reuse the same registry entry and directory, so their existing sessions remain attached. The generic Workspace navigation service observes the registered Workspace, creates or reuses its blank Session, and opens it without a product-specific client navigation fork.

Cloud Workspace initialization is part of runtime readiness. A registration or rename failure stops the employee process and fails the request; the gateway does not fall back to `/root/qifuaigent`, another employee directory, or an unregistered current working directory. Local Content continues to use the desktop local runtime and its explicit native directory picker.

## Alternatives considered

**Hide the Workspace picker in the Qifu client.** This would enable a composer without giving the Session a valid Workspace path and would weaken filesystem policy and persistence semantics. It would also couple Cloud Work behavior to a visual override while leaving runtime state incomplete.

**Write the Workspace registry files before process startup.** Direct storage edits would bypass the Workspace registry's canonical-path, ordering, schema-version, and event ownership. The authenticated RPC keeps the initializer on the supported mutation path.

**Use the application checkout as the default Workspace.** `/root/qifuaigent` is shared deployment source rather than employee content. Registering it would let conversations operate on the application tree and would defeat the employee data-home boundary.

## Consequences

The first Cloud Work screen has a real employee-private Workspace and an enabled conversation composer without a directory choice. Existing employees receive the same Workspace lazily on their next runtime start, and no migration edits their Session logs or Workspace registry files directly.

Runtime startup performs one loopback create request and, until the product title is present, one rename request. Startup fails closed if either response is unauthenticated, malformed, or unsuccessful. Focused gateway tests cover path isolation, RPC envelopes, idempotent title reuse, and process termination on initialization failure.

This decision implements only the default Harness Workspace required for server conversations. The OA Cloud Workspace catalog, Work Item projection, object storage, transfer state machine, and team ACL work remain owned by the broader proposal.
