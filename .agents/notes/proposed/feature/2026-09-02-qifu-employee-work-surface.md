# Agent Note: Qifu employee feature, cloud work, and local content surface

Status: proposed

English | [中文](2026-09-02-qifu-employee-work-surface.zh.md)

## Problem

The Qifu AI desktop client needs to provide three different entry types in one sidebar: features determined by OA permissions, cloud work stored in company infrastructure, and local content stored on an employee computer. These entries do not yet share one identity, authorization, resource-directory, and data-transfer contract, and the visible names cannot accurately identify whether content lives on the employee computer or a server.

The production OA system stores digital-employee conversations, messages, attachment indexes, presentation projects, presentation versions, knowledge sources, and account memory. A read-only inspection on 2026-09-02 observed 403 AI conversations, 4,347 messages, 25 presentation projects, 36 presentation versions, 58 attachment indexes, 7 knowledge sources, 5 account-memory profiles, and 4 memory items; these records belong to different business modules and cannot gain consistency by being copied into one generic table.

The production OA “Brain Center” Workspace is public. `ZKKG AI User` has read, report, and export permissions for AI conversations, messages, agent runs, and attachment indexes, while these DocTypes have no matching record-level query conditions. Employee business APIs filter by `actor_user`, but Desk lists, reports, exports, files, and other generic Frappe entry points still require one owner-authorization contract.

The authentication gateway starts a separate server DSH process for each OA User id and assigns a separate `HOME` and `DSH_HOME`. This [employee runtime isolation](../../implemented/feature/2026-09-01-employee-runtime-isolation-and-identity.md) protects DSH sessions, settings, credentials, and browser cookies, but the working directory remains on the server and cannot represent a local workspace on the employee computer.

The account-memory implementation is fixed to digital employee `b1`, enables reads and automatic extraction by default, and saves conversation candidates that meet its threshold directly as Active. Employee identity, employee work profile, personal long-term memory, customer profile, and project knowledge have different purposes, owners, and authorization rules and need separate management.

## Proposal

The client adopts a product and technical structure of one entry surface, three data domains, one personalization layer, and one explicit publication channel. The sidebar shows “Features,” “Cloud Work,” and “Local Content” in that order; identity and permissions always apply, while employees choose whether their work profile and personal memory enter model requests in the three areas.

“Features” is driven by an employee capability manifest returned by production OA. “Cloud Work” provides an employee-private company resource directory that references authoritative records in existing business DocTypes. “Local Content” uses a desktop local runtime to access real local directories and does not copy sessions or files to Qifu cloud storage by default. Employees explicitly cross the domains through “Publish to Cloud” or “Download Local Copy.”

Qifu-specific implementation lives in independent product plugins and a deployment Overlay; upstream DeepSeek Harness packages carry only generic slots, service interfaces, and runtime extension points. This structure limits future upstream upgrade conflicts to a small set of generic interfaces instead of requiring the complete Qifu business implementation to be merged again.

The first production slice implements the employee-private vertical path: desktop-only employee identity and work-surface plugins, an OA-derived feature manifest, a private default Cloud Workspace and federated Work Item catalog, employee-scoped cloud and device runtimes, explicit publication and versioned download of one local file or one local Session snapshot, four consent controls that default off, memory review and forget actions, and durable profile/memory context snapshots on the first model step of each turn. The OA permission hooks cover the employee-owned AI records and new work-surface records, the gateway revalidates feature access before launch, and the desktop preload exposes only allowlisted operations.

The broader proposal remains active for capabilities that are not part of this slice: team Workspace ACLs, asynchronous malware scanning and object storage, Strict Local Mode, idle runtime eviction and observability objectives, and a signed and accepted Windows distribution. These items cannot be represented as complete by the presence of navigation rows or consent switches.

## Scope and invariants

| Subject | Proposed invariant |
|---|---|
| Features | Production OA is the source of truth for visibility and execution; employees cannot disable or expand their own permissions. |
| Cloud work | Employee content is private by default; each resource retains its business source of truth, and the cloud directory stores only the shared index and relationships. |
| Local content | Local sessions and files remain on the current device by default; any Qifu cloud copy requires an employee operation on one explicit object. |
| Identity | The gateway derives User and Employee from the authenticated session; account fields submitted by a client are never authorization facts. |
| Personalization | Permission decisions do not depend on personalization choices; model reads of profiles, reads of memory, and writes of memory are authorized separately. |
| Transfer | Publication and download create sourced, versioned copies; a cross-domain operation never silently overwrites its source object. |
| Model traffic | “Not stored in Qifu cloud” does not mean “not sent to a model”; the UI must accurately explain the model data path before a request. |

The first version does not provide real-time multi-user collaboration, background bidirectional file sync, CRDT conversation merge, a company-drive replacement, or cross-company resource sharing. Team workspaces can reuse the same access-control model, but they require a separate enablement after employee-private workspaces pass acceptance.

## Product layout

### Sidebar order

The sidebar shows three first-level collapsible groups in a fixed order below “New Conversation.” The account menu remains at the bottom of the sidebar, and settings appear only after the employee clicks the name area.

| Group | Default state | Children | Empty state |
|---|---|---|---|
| Features | Expanded | Apps available to the current employee | “No features are available to this account” |
| Cloud Work | Expanded | Cloud workspaces, recent sessions, designs, files, and knowledge entry points | “No cloud content” |
| Local Content | Expanded | Local workspaces, recent local sessions, and downloaded copies | “Choose a local folder to start work” |

The three collapse states are stored in local UI settings under the employee account and device. Collapse state is not uploaded to OA and does not affect permissions or content existence.

### Apps layout contract

The “Features” group follows the reference Apps layout language: the first-level group row uses a four-square icon, label, and right-side chevron; children use one compact list column rather than large cards or a multi-column grid; each row contains a colored square icon and one-line label; the current item uses a full-row rounded selection background.

| Element | Initial design token | Behavior |
|---|---|---|
| Group row | 40 px height and 12 px horizontal padding | The full row is clickable; the chevron expresses expansion; the row provides `aria-expanded`. |
| App row | 36 px height and 32 px left indent | Click opens the main content area; keyboard arrows move among visible Apps. |
| App icon | 20 × 20 px with 6 px radius | Use a controlled icon key and theme color; do not load an arbitrary remote image supplied by the backend. |
| App label | One line with overflow ellipsis | Hover exposes the full name; color is never the only status signal. |
| Selected row | 8 px radius and semantic selected background | Retain text contrast and a focus ring; dark and light themes use the same semantic token. |
| Attention badge | Optional at the row end | Show only counts the employee may read; omit zero values. |

The backend capability manifest provides `feature_code`, localized label key, icon key, theme color key, route, display order, required actions, and an optional badge source. The client accepts registered icons and route types only and does not execute backend-supplied HTML, script, or arbitrary URLs.

An unauthorized App is absent rather than exposed as a disabled gray entry. When capability loading fails, the client shows a retryable error and does not fall back to a full static App catalog. An administrator-disabled App and an App unavailable to the employee produce the same absent result in the ordinary employee UI.

Feature search examines only the authorized manifest. Employees may pin authorized Apps to the top of the group; pin records remain in employee settings, while backend `display_order` controls unpinned items, and permission revocation immediately removes the matching pin.

### Navigation and state

Each App uses stable `feature_code` as its UI identity, so a label change does not change favorites, badges, or deep links. Internal pages open in the main content area; digital-employee Apps can create or resume a session carrying `feature_code` and `digital_employee`; external links allow only backend-registered HTTPS domains and show an explicit prompt before opening.

Loading uses a three-row skeleton unrelated to the real item count so that it does not reveal permission quantity. Empty, failure, and permission-revoked states are distinct; when the client receives a new `capability_revision`, it closes an invalid page, clears its cache, and explains that permissions changed.

## Identity and feature authorization

### Authorization source and bootstrap

The same-origin gateway provides a versioned `GET /qifu/v1/bootstrap`. The gateway obtains the OA cookie from the current HttpOnly session, queries production OA for employee identity and capabilities, and returns minimal identity, allowed features, allowed actions, a personalization-status summary, and version information; it does not retain the login password.

| Field | Meaning |
|---|---|
| `contract_version` | Client protocol version; an unknown major version fails fast. |
| `employee` | Employee id, display name, designation, and optional avatar key. |
| `capability_revision` | Permission version incremented after a Role, User Permission, feature configuration, or Agent Profile change. |
| `features` | Filtered App manifest; each item contains code, label key, icon key, route, order, and actions. |
| `data_scopes` | Server-side data ranges such as self, department, named employees, or named projects. |
| `personalization` | Current profile-read, memory-read, and memory-write choices without memory content. |

OA Role, User Permission, Employee, Department, Agent Profile employee and department bindings, Agent Profile allowed tools, knowledge scopes, and `ZKKG AI Client Feature` configuration jointly produce the capability manifest. System Administrator status does not automatically grant employee-private content; configuration administration, audit metadata, and emergency content access are separate grants.

Capability results have a maximum 60-second cache and active invalidation through `capability_revision`. The next API or tool call after revocation must reject immediately; client refresh updates presentation and is not a prerequisite for revocation effectiveness.

### Enforcement points

The server adds `permission_query_conditions` and `has_permission` for Conversation, Message, Agent Run, Attachment Index, Cloud Workspace, Work Item, Session Binding, Sync Transfer, and related File records. Lists, details, reports, exports, search, file download, WebSocket subscriptions, and background jobs resolve one owner and data-scope policy before entering business logic.

Tool schemas expose only tools the current employee may call. The tool executor validates the action, target record, and `capability_revision` again on every call, so an old session, old prompt, or handcrafted HTTP request cannot bypass current authorization.

The default employee-private rule is `owner_user == frappe.session.user`. Team resources require an explicit Workspace ACL. A manager who needs employee content uses reasoned, time-limited, approved, and fully audited emergency access; ordinary `ZKKG AI Manager` permission manages configuration and runtime health only.

## Cloud work

### Federated catalog

Cloud Work is a shared resource directory, not a shared body-content table. Each business module continues to own its records and state machine, while `ZKKG AI Work Item` points to the original record through a controlled Dynamic Link and stores the list projection, owner, workspace, origin, version, and security classification.

| Resource kind | Authoritative content | Cloud work projection |
|---|---|---|
| Digital-employee conversation | `ZKKG AI Conversation` and `ZKKG AI Message` | Title, digital employee, recent activity, summary, and permission status |
| Harness session | Versioned DSH event log | Title, runtime, session format, recovery status, and normalized transcript projection |
| Presentation and design | Presentation Project, Version, Slide, and Source | Project status, current version, preview, and delivery files |
| File and attachment | Private object storage, Frappe File, and Attachment Index | File name, type, size, digest, scan state, and source relation |
| Knowledge content | Knowledge Source, Chunk, Entity, and Relation | Source state, index version, and authorization scope |

The system lazily creates one private default workspace when an employee first opens Cloud Work. The first version permits employees to own their private workspaces only; the data model reserves `visibility` and an ACL table for later department or project sharing without changing the owner contract of private records.

Work Item is a rebuildable index and does not store business body content. Original-record updates refresh projections through DocType events, and failures enter a retry queue. List reads filter by Workspace and employee permission before reading the projection and never run full-text or vector retrieval before permission filtering.

### Session persistence

A cloud Harness session retains a versioned raw event log and a normalized transcript. The raw log owns exact resume, tool state, and audit behavior; the normalized transcript owns cross-version lists, search, and user export. Session Binding, event digest, and last sequence connect them, and they are not independently editable sources of truth.

Active logs continue to use [per-session JSONL persistence](../../../../packages/session/session-persistence-jsonl/README.md). An employee-specific server data volume stores hot logs, while encrypted checkpoints are copied to private object storage. Session Binding records Harness version, Session format version, last committed sequence, log digest, object version, and recovery state. Every upgrade verifies existing-format reads or runs an explicit migration first.

OA digital-employee conversations are not forced into DSH event logs. They retain the existing Conversation/Message source of truth and appear in Cloud Work through the same Work Item and Session Binding directory.

### Objects, search, and lineage

Large files and generated artifacts enter private object storage, while the database stores metadata, content digest, object key, version, and references only. Object keys are not returned to ordinary clients; download uses short-lived signed URLs created after employee authorization. A Work Item does not become Ready until server-side encryption, malware scanning, and MIME content probing succeed.

A content digest provides integrity and idempotency and is not an authorization credential. Deduplication is restricted to one company and equal security classification and uses a company-scoped HMAC digest to avoid a cross-company content-existence side channel.

Immutable relation records establish lineage among sessions, source files, design versions, generated artifacts, and memories. Search indexes and vectors are derived data; reduced permissions, deleted source content, or forgotten memory enqueue derived-index invalidation and removal within the declared period.

## Local content

### Local runtime

The desktop application owns a local loopback DSH runtime and a cloud-gateway connection. The Local Content page connects to the local runtime only, and the Cloud Work page connects to the cloud runtime only. The title area and session header continuously display “Local” or “Cloud” and never infer runtime location from the current route.

The local runtime uses a data directory derived from employee account and device id. macOS uses the Qifu directory under Application Support, and Windows uses the Qifu directory under LocalAppData; the directory name uses an irreversible employee key. The encryption master key resides only in macOS Keychain or Windows DPAPI, and OA passwords, OA cookies, and long-lived cloud tokens never enter local session logs.

A local workspace is a real directory explicitly selected through the native directory picker. The [Workspace registry](../../../../packages/workspace/workspace/README.md) owns directory and session grouping, while the operating-system sandbox and DSH permission policy still determine the readable and writable range. Different employees on one device have different DSH_HOME directories, Workspace registries, sessions, attachments, settings, and credentials.

Sign-out revokes the cloud session and clears short-term tokens and temporary profile cache, but retains encrypted local content by default for the same employee's next login. Settings provides “Also delete local content on this device” and shows directories, object count, estimated space, and an irreversible warning before deletion.

### Network disclosure

“Stored locally” describes Qifu persistence only. When a local session uses a cloud model, web search, OA tool, or another remote service, relevant request content leaves the device. The send area shows the current model data path, and the first use of each new path displays a short explanation.

Strict Local Mode permits local models and local tools only and disables cloud profiles, cloud memory, web search, and OA writes. Ordinary local mode lets an employee selectively read a cloud profile or call company features, but it does not upload the full transcript, workspace directory, or unselected files.

A local OA operation that creates an approval, task, or another company record is an explicit business write and is not “local content sync.” Its confirmation UI names the record type and target system that will be created.

## Explicit transfer

### Transfer contract

The UI avoids the ambiguous term “automatic sync.” `Publish to Cloud` creates a cloud version from one local session or file; `Download Local Copy` creates a local copy from one cloud object; `Refresh Cloud Information` reads remote metadata only; `Temporarily Use Profile and Memory` reads authorized context into a short-lived cache only.

Publication follows a fixed order: the employee selects one object and inclusion scope; the client creates a reviewable manifest and removes local absolute paths; the employee confirms; the client hashes and uploads chunks; the server validates capability, quota, MIME, malware, and sensitivity policy; the server atomically commits the business record, Work Item, lineage, and audit record.

A session publication includes the visible transcript, selected attachments, selected deliverables, and required lineage by default. It excludes environment variables, credentials, hidden reasoning, local absolute paths, unselected workspace files, and other sessions. The employee may deselect each attachment and artifact on the confirmation page.

| Transfer state | Meaning |
|---|---|
| Initiated | The server validated current capability and returned upload id, chunk policy, and expiry. |
| Uploading | The client uploads missing chunks; retries use the same transfer id and chunk digests. |
| Scanning | The server verifies the complete digest, file type, malware state, and sensitivity policy. |
| Ready | Every object is ready, but no cloud business record is visible yet. |
| Committed | Metadata, object references, Work Item, lineage, and audit are atomically published. |
| Failed or Cancelled | Temporary objects are collected after 24 hours; failure creates no visible partial Work Item. |

Write operations require `Idempotency-Key`. The same employee, operation, and request digest return the same result; the same key with a different digest returns a conflict. The server does not trust owner, company, employee, or permission scope supplied by the client.

### Versions and conflicts

File publication creates a new version by content digest. The same digest can reuse an existing version owned by the current employee, while a different digest never overwrites an old version. Session publication freezes one source sequence; later local and cloud continuation creates two forks whose UI shows the common source.

When a downloaded cloud object is changed and published again, the client submits `base_version`. If the cloud already has a newer version, the server rejects overwrite and offers “Save as New Version” or “Create Copy”; the first version does not automatically merge text, binaries, or conversations.

## Personalization and memory

### Data classes

| Data class | Owner and source | Model use |
|---|---|---|
| Identity and permission facts | OA User, Employee, Department, Role, and User Permission | Always used for authorization and audit; the model receives only minimum task-required fields. |
| Employee work profile | OA-managed fields and employee-editable preferences | Injected by current feature and task after employee choice. |
| Personal long-term memory | Explicit employee records or confirmed conversation candidates | Injected by relevance after employee choice. |
| Project knowledge | Authorized resources in the current Workspace | Selected by the employee in a session or project and never expanded implicitly by the personal-memory choice. |
| Customer profile | Customer business module | Used only when the employee has customer access and the current task explicitly concerns that customer. |

Employee identity and permissions have no off switch. Settings provides four independent choices: “Use My Work Profile to Assist Responses,” “Allow Reading My Cloud Memory,” “Allow New Memory Extraction from Cloud Conversations,” and “Temporarily Read Cloud Profile and Memory in Local Sessions.” Each choice records consent version, time, device, policy version, and revocation time.

A read choice does not authorize writes, and cloud-session publication does not automatically authorize memory extraction. After an employee revokes reads, the next model request contains no matching context; after an employee revokes writes, the system stops generating candidates but retains existing memory the employee has not deleted.

### Memory lifecycle and context evidence

Automatic extraction creates a Proposed candidate rather than Active memory. Employee confirmation moves it to Confirmed/Active; an explicit “remember” may create Active directly; correction creates a new version and marks the replaced item; “forget” immediately prevents retrieval and starts derived cache and vector removal.

Memory admission combines an allowed category, sensitive-data detection, source evidence, confidence, and expiry. Passwords, tokens, cookies, bank cards, national ids, medical information, biometrics, and complete salary data cannot enter personal memory; credentials can enter only the existing credential service or operating-system secure storage.

Every model request creates a Context Snapshot containing profile, memory, and project-resource ids, policy version, capability version, source digests, and the exact encrypted rendered content. The Session event records Snapshot id and digest to satisfy reconstruction of model-visible content; Agent Run stops copying the complete context into multiple JSON fields.

Employees can inspect “Sources Used for This Request” in session details, while the model need not explain internal retrieval in its answer. Deleting memory immediately invalidates future requests and search indexes; historical used context is retained, redacted, or cryptographically erased according to company retention policy, with a body-free audit digest remaining.

## Data model

| Record | Key fields | Ownership and purpose |
|---|---|---|
| `ZKKG AI Client Feature` | feature_code, label_key, icon_key, route_type, route, display_order, enabled, actions | Manages publishable Apps; Role, Department, Employee, and Agent Profile child tables define candidate ranges. |
| `ZKKG AI Cloud Workspace` | workspace_id, company, owner_user, owner_employee, visibility, retention_policy | Employee-private cloud space; a separate ACL child table can support team space later. |
| `ZKKG AI Work Item` | item_id, workspace, resource_doctype, resource_name, kind, origin, title, version, classification, status | Rebuildable resource directory and list projection without original body content. |
| `ZKKG AI Session Binding` | binding_id, workspace, owner_user, oa_conversation, dsh_session_id, runtime, harness_version, format_version, last_seq, digest | Connects OA conversation, DSH log, normalized transcript, and cloud directory. |
| `ZKKG AI Sync Transfer` | transfer_id, owner_user, device_id, direction, source_id, base_version, digest, state, idempotency_key, expires_at | Owns upload, download, retry, conflict, and collection state. |
| `ZKKG AI Work Relation` | relation_id, from_item, to_item, relation_type, source_version, digest | Stores source, generation, attachment, version, and fork relations. |
| `ZKKG AI Personalization Consent` | owner_user, profile_read, memory_read, memory_write, local_context_read, policy_version, granted_at, revoked_at | Stores four choices and their audit facts. |
| Existing Account Memory and Context Snapshot | actor_user, scope, category, value, source, status, expiry, snapshot payload, policy revision | Extends existing memory without creating a competing source of truth. |

Every employee-content record explicitly stores `owner_user` and `company`; Employee supports business display and organization queries and is not the permanent login identity. Client-facing ids are random opaque identifiers and never encode email, phone number, User id, Employee id, or server path.

Database constraints enforce a unique resource reference per Work Item, a unique runtime session per Session Binding, an idempotency key unique within employee and operation, and a monotonic resource-scoped version. A background job uses the owner and capability digest frozen in its job record and cannot reselect data from an Administrator-wide view.

## API contracts

Every interface is exposed by the same-origin gateway under major version `/qifu/v1`. The gateway exchanges a browser session or desktop device session for short-lived internal credentials and places authoritative OA identity in server request context; owner fields in a request body are display data only.

| Method and path | Purpose | Required enforcement |
|---|---|---|
| `GET /bootstrap` | Return employee identity, features, data scopes, personalization summary, and versions | Authenticated; no cache; signed response or same-origin integrity protection. |
| `GET /cloud/workspaces` | List cloud workspaces available to the employee | Owner/ACL query conditions. |
| `GET /cloud/items` | List Work Items by workspace, type, and cursor | Permission filter before search and pagination. |
| `GET /cloud/items/{id}` | Return the safe detail projection for one resource | Double authorization on Work Item and original record. |
| `POST /cloud/sessions` | Create a cloud Harness session and binding | Feature action, Workspace write permission, and idempotency key. |
| `POST /transfers` | Initialize publication or download | Source permission, target permission, quota, device state, and capability version. |
| `PUT /transfers/{id}/parts/{part}` | Upload one chunk | Transfer owner, digest, size, and expiry. |
| `POST /transfers/{id}/commit` | Scan and atomically commit a cloud version | Full digest, policy scans, idempotency, and transactional commit. |
| `GET /personalization` | Return settings and reviewable profile/memory metadata | Current employee only; sensitive fields redacted. |
| `PATCH /personalization` | Update the four choices or profile preferences | Consent version, CSRF, audit, and immediate invalidation. |
| `GET/PATCH/DELETE /memories/{id}` | View, correct, or forget one personal memory | Current employee ownership, version conflict, and derived-data invalidation. |

Lists use stable cursors rather than unbounded `limit_page_length`. Write interfaces return stable error codes including `CAPABILITY_CHANGED`, `PERMISSION_DENIED`, `IDEMPOTENCY_CONFLICT`, `BASE_VERSION_CHANGED`, `CONTENT_REJECTED`, and `TRANSFER_EXPIRED`; clients recover by error code and do not parse Chinese error text.

WebSocket and SSE authenticate on connection, authorize on subscription, and revalidate after each permission revision. Background completion events publish only to the current employee and explicit ACL members and do not use guessable room names.

## Deployment topology and upgrade isolation

The production OA `zkkg_ai` application owns DocTypes, authorization policy, cloud directory, personalization, transfer metadata, and business-resource adapters. The authentication gateway owns OA session exchange, the certificate-pinned entry point, employee cloud-runtime selection, short-lived device tokens, chunk-transfer proxying, and WebSocket routing. Private object storage owns encrypted event checkpoints and file bytes.

The desktop application owns local-runtime lifecycle, native directory picking, Keychain/DPAPI, local data roots, publication preview, and network-path notices. DeepSeek Harness product plugins own the feature-manifest consumer, tool filter, Cloud Work UI, personalization context provider, and transfer client.

The controlled fork keeps the product-specific desktop and gateway sources under `qifu/` as a versioned deployment Overlay and pins an accepted DeepSeek Harness commit. Product plugins use the stable `/qifu/v1` protocol and do not import private OA Python implementation. If the product later moves the Overlay into a dedicated private repository, that repository must preserve the same pin and release gates. If upstream lacks a generic slot or service interface, the upstream change stays minimal, reusable, and free of Qifu business terms.

The upgrade checks compare upstream in an independent worktree, back up current code and data, run plugin compatibility tests, read every supported Session format, complete real macOS and Windows acceptance, verify a canary employee, and retain a bootable old version and a data-format rollback path. If a migration writes a new format, the old version must retain read-only export or the irreversible migration must receive explicit approval before cutover.

## Migration and rollout

| Phase | Estimated effort | Work | Exit criteria |
|---|---:|---|---|
| 0. Employee content authorization | 4–6 engineer-days | Add record query and detail permissions; close ordinary employee report/export bypasses; protect File, search, and real-time subscriptions; create two-employee fixtures. | Employee A cannot observe employee B's existence or content through any generic or business entry point; revocation is immediate. |
| 1. Features and cloud directory | 7–10 engineer-days | Add Client Feature, bootstrap, Cloud Workspace, Work Item, Session Binding, and existing-content adapters; deliver the Apps-style feature list. | Feature presentation matches server actions; existing conversations, presentations, attachments, and knowledge sources appear through indexes without copied body content. |
| 2. Local runtime | 10–15 engineer-days | Start local DSH from desktop, create employee and device data roots, native directory selection, encrypted keys, runtime-location labels, and Strict Local Mode. | Local sessions and files work offline; two employees cannot read each other's local data; cloud has no new content records. |
| 3. Explicit publication | 8–12 engineer-days | Add transfer state, preview, chunks, scanning, idempotency, versions, lineage, local downloads, and conflict handling. | Only selected objects upload; retry does not duplicate; conflict does not overwrite; failure leaves no visible partial record. |
| 4. Profile and memory | 6–9 engineer-days | Split four choices, candidate confirmation, Context Snapshot, derived-data invalidation, used-source UI, and historical retention policy. | The next request omits disabled context; forgetting invalidates retrieval and indexes; model input is audit-reconstructable. |

Phase 0 completes first, and later phases cannot substitute UI hiding for authorization repair. Phase 1 uses lazy creation and batch backfill for existing data: a script creates a default Workspace per owner and idempotent Work Items for existing Conversation, Presentation, Attachment, and Knowledge records; bodies do not move, and existing URLs and business state machines remain valid.

Existing account memory receives `consent_state = Review Required` during migration. The system keeps the records but pauses automatic injection and extraction until the employee opens personalization settings and chooses each option; absence of a choice is not inferred consent. Existing Context Snapshot and audit records remain read-only.

Existing per-employee server DSH_HOME directories become Cloud Session Bindings through the employee mapping held by the gateway; the system does not reverse an irreversible directory key. A directory without a reliable mapping enters a quarantine inventory for administrator read-only verification before association or archival.

Each Phase enters an independent test environment first and completes API, permission, migration, browser, and desktop acceptance with sanitized data; production publication starts only after user acceptance. Production migration backs up the database, object inventory, and server DSH_HOME before running repeatable, interruptible batch jobs with checkpoints.

## Operational readiness

The gateway and OA record structured metrics for bootstrap latency and failure, capability-revision propagation, permission denials, employee cloud-runtime counts, session-persistence latency, transfer throughput and failure, scan rejection, Context Snapshot creation and invalidation, and object-storage capacity. Logs contain trace id, irreversible employee key, opaque resource id, error code, and timing only and omit passwords, cookies, tokens, full prompts, and file bodies.

Recommended initial objectives are: permission revocation propagates within 60 seconds and every write validates immediately; bootstrap 95th percentile is below 500 ms; same-region cloud-session recovery 95th percentile is below 5 seconds; committed cloud metadata has at most 15-minute RPO and 4-hour RTO. Configuration and runbooks own these objectives; plugins do not hardcode them.

Production OA data uses the existing database backup system; object storage enables versioning, lifecycle, server-side KMS encryption, and cross-failure-domain copies; employee cloud DSH_HOME creates encrypted checkpoints. A quarterly sample restore verifies Workspace, Session Binding, logs, file versions, and permission relations together.

Local content has no company-cloud recovery promise. Settings shows the local data directory, space use, last local backup, and publication state and lets an employee export an encrypted backup. Device revocation after loss blocks cloud tokens but cannot claim to erase an offline disk remotely.

TLS certificate pinning configures the current and next public-key fingerprints together, releases a dual-pin client before the server certificate rotates, and removes the old fingerprint last. The client rejects unknown certificates, and certificate rotation does not place private keys or fixed tokens in the repository.

## Acceptance criteria

### Feature area

- The “Features” group uses a single-column Apps layout at desktop width and in the collapsed rail and supports expansion, keyboard navigation, focus rings, selection, complete-name hints, and high-contrast themes.
- Employees with different permissions receive different App manifests; an unauthorized App is absent from search, deep-link suggestions, badge subscriptions, and model tool schemas.
- After an administrator revokes a feature, an old page closes, the next tool/API call rejects, and the client does not require sign-in again.
- App order, icon, and route accept controlled backend values only; malicious icons, script, HTML, and unauthorized external domains are rejected.

### Cloud work

- An employee can list and open only their private Workspace, Work Items, original business records, files, and search results.
- Existing Conversation, Presentation, Attachment, and Knowledge content appears through adapters, with body digests equal to original records and no competing body copies.
- A Harness session provides both a resumable event log and a normalized transcript, and upgrade tests read every supported format.
- Deletion or reduced authorization invalidates lists, full-text indexes, vector indexes, signed URLs, and real-time subscriptions within the declared period.

### Local content and transfer

- Creating a local session, registering a local directory, and generating a local file does not create Cloud Workspace, Work Item, Sync Transfer, or cloud attachment records.
- Two employees on one device have different encrypted data roots; sign-out and sign-in never show one employee's local session to another.
- Publication preview lists transcript, attachments, and artifacts accurately; network inspection and server audit prove that unselected objects did not upload.
- Network interruption, duplicate submission, and process restart preserve transfer idempotency; a base-version conflict never overwrites an existing cloud version.
- The UI distinguishes Qifu persistence from model network transfer accurately; Strict Local Mode has no remote model, search, profile, memory, or OA call.

### Personalization and memory

- Identity and permission still execute correctly with every choice off, and the model receives minimum task-required identity facts only.
- Profile read, memory read, memory write, and temporary local read can be enabled and revoked independently, and the server records consent version and time.
- Automatic extraction creates Proposed only, and employee confirmation or explicit “remember” is required for Active.
- Every model request links an exact Context Snapshot, and Agent Run and business JSON do not duplicate unmanaged complete personalization content.
- “Forget” immediately stops future retrieval and removes caches, full-text/vector indexes, and erasable historical snapshot content according to retention policy.

### Security, operations, and upgrade

- Employee A cannot obtain Employee B's record through REST, Desk, reports, export, file URLs, search, WebSocket, background jobs, or guessable ids.
- Configuration administrators do not see employee content by default; emergency access requires reason, approval, and expiry and creates employee-, administrator-, and auditor-visible records.
- Logs, metrics, crash reports, client storage, and the repository contain no passwords, cookies, tokens, private keys, or complete sensitive bodies.
- Restore exercises for the database, objects, Session logs, and permission relations meet the declared RPO/RTO and retain employee isolation after recovery.
- The independent Overlay passes plugin tests, documentation checks, real macOS and Windows flows, and canary employee acceptance on the target upstream commit before upgrade.

## Alternatives considered

**Copy every OA record into one Cloud Work table.** This creates multiple body-content sources of truth, breaks existing presentation, knowledge, and digital-employee state machines, and divides permission, version, and deletion behavior. A shared index with controlled adapters provides a consistent entry point while keeping each business module's ownership.

**Keep the server working directory and label it “Local Content.”** A browser or desktop wrapper cannot give a server process the real filesystem semantics of an employee computer, and the label would make a false privacy and location promise. Local Content requires a runtime on the device.

**Provide background bidirectional sync in the first version.** Automatic sync expands upload scope, creates overwrite conflicts, and makes the authoritative version unclear to employees. Explicit publication, local-copy download, and fork semantics provide auditable movement, while collaboration sync can be evaluated as a separate requirement later.

**Control work profile and memory with one master switch.** Reading existing information, creating memory from conversations, and fetching remote information into a local request have different directions and risks. Four independent choices allow specific employee consent while keeping authorization mandatory.

**Continue writing Qifu logic directly into upstream core packages.** Product fields, OA APIs, and UI rules would expand every upstream upgrade merge. Product plugins and the controlled `qifu/` Overlay preserve Qifu delivery speed and restrict upstream changes to reusable extension points.

## Risks

- One Node process per active cloud employee consumes memory and ports; the gateway needs a concurrency cap, idle collection, startup single-flight, and capacity metrics before a shared worker pool is introduced at measured scale.
- Users may interpret “stored locally” as completely offline; persistent location labels, model-path notices, and Strict Local Mode must ship with the local runtime.
- The prerelease DSH Session format can change; Session Binding, format-read tests, normalized transcripts, and pre-upgrade migration are necessary costs of long-term cloud readability.
- A generic Work Item adapter can drift from business-record permissions; every resource kind needs permission-parity tests, and an adapter failure must hide the projection and alert rather than return stale content.
- Memory forgetting conflicts with historical reconstruction; company retention policy must define categories that remain, are redacted, or are cryptographically erased before launch, and the UI must explain the result accurately.
