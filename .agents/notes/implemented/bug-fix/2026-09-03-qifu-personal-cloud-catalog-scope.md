# Agent Note: Qifu personal Cloud Work catalog scope

Status: implemented

English | [中文](2026-09-03-qifu-personal-cloud-catalog-scope.zh.md)

## Problem

The employee sidebar rendered every Work Item returned by the cloud catalog as one flat Cloud Work list. The OA backfill also projected every enabled enterprise knowledge source into each employee's private catalog because the Employee role could read those sources. Shared knowledge, personal conversations, designs, files, and explicit publications therefore appeared as equivalent employee work, and a retained projection could stay visible after its source read permission changed.

## Decision

Cloud Work lists only employee-private Conversation, Session, Presentation, and File items. OA stops creating Knowledge Work Items during personal catalog backfill, excludes unsupported kinds from default and kind-filtered list responses, and rechecks the current employee's source-record read permission before returning an Existing OA projection. Existing knowledge metadata remains stored and is not deleted.

The desktop client independently accepts only the same personal kinds and groups them as Sessions, Designs, and Files. Enterprise knowledge rows appear in neither Cloud Work nor Features. Authorized knowledge remains available through its owning OA retrieval and permission mechanisms rather than becoming a navigation item.

## Alternatives considered

**Move enterprise knowledge into Features.** Features represent employee-authorized applications and actions, not data sources. Moving knowledge rows would preserve the category error and could expose hundreds of source records as application navigation.

**Delete existing Knowledge Work Items.** Deletion is unnecessary for presentation correctness and would remove retained metadata without a migration or retention decision. API and client allowlists make the records dormant while preserving reversibility.

**Filter only in the desktop client.** Older clients and direct API consumers would still receive the mixed catalog, and revoked source access could remain visible in list metadata. The OA response owns the authoritative scope; the client allowlist provides defense in depth.

## Consequences

Employees see personal cloud work grouped by content type, while shared enterprise knowledge does not consume sidebar space or appear as a Feature. The list may contain fewer than the requested page size when a retained Existing OA projection fails its current source permission check; the cursor still advances across the scanned records. Knowledge retrieval remains controlled by the Knowledge Source authorization path, and no source content or retained Work Item is deleted.
