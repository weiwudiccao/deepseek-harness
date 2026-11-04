# Agent Note: Session-owned Qifu Office documents

Status: implemented

English | [中文](2026-11-03-qifu-office-documents.zh.md)

## Problem

The image attachment protocol cannot represent Office documents, and opening a file on the cloud Host does not download it to the employee. The filesystem service has no binary mutation operation.

## Decision

The Qifu work-surface plugin owns opt-in `office_read` / `office_create` tools and immutable documents below each employee runtime's Harness home. Random document ids belong to one Session; filenames never select host paths. Connection supplies authenticated import, listing, and downloads. Outputs retain originals.

A fixed officeparser version runs in terminable workers with byte, expansion, text, time, and heap limits. Workers receive safe temporary-directory variables rather than employee credentials. Remote assets, macros, scripts, and OCR remain disabled. A bundled Chinese font makes PDF output independent of system fonts. Both Qifu launchers enable the capability; ordinary Harness profiles remain inactive. The mounted document control registers one Session-addressed non-image file intake with Conversation. Drop and paste gestures split images from documents before image validation; the importer processes one batch sequentially and adds references for successful imports to the current draft without opening the panel. The Office files button controls the panel; import errors remain visible when it is closed. The intake's disposer and cancellation stay tied to the mounted Session, so an import cannot insert a reference into another Session.

## Alternatives considered

Extending the image protocol couples Office storage to image normalization and both SDKs. Writing model-selected binary paths bypasses filesystem mutation guards. Requiring Office, Python, or a remote converter adds machine prerequisites or uploads local originals implicitly.

## Consequences

Imports stay in the selected runtime; model-read text still travels through the configured model service. Revisions create new modern-format documents without preserving arbitrary original layout, animation, formula, or macro features. Legacy DOC/XLS/PPT need conversion; scanned PDFs need OCR. Tests cover Chinese format round trips, Session isolation, authenticated downloads, cancellation, and a real Loader tool exchange. Installer and device acceptance remain separate release evidence.
