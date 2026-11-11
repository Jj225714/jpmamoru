# 全功能诊断日志 Implementation Plan

> **For agentic workers:** Implement the independent frontend and server units with review and regression validation.

**Goal:** Capture safe diagnostics for every frontend network request and major local operation, plus production API status and timing, with user export and bounded retention.

**Architecture:** A fixed-schema browser ring buffer records operation and network lifecycle without free-form content. Same-origin requests correlate with Nginx-generated request IDs; third-party calls receive no additional headers. Nginx logs route categories, status and upstream timing to a private rotated file. Provider relay adds structured upstream failure categories. No bodies, credentials, prompts, personal filenames, query strings or arbitrary error messages are retained.

**Tech Stack:** TypeScript, React, fetch/Axios, Node.js, Nginx, systemd, Vitest.

## Chunk 1: Implementation and release

### Task 1: Browser diagnostics
- [ ] Create `web/src/services/diagnostics.ts` for capped/expiring local events, safe error classification, operation wrapper, network instrumentation and global failures. Export only schema-validated fields.
- [ ] Create `web/src/components/layout/diagnostics-panel.tsx`; integrate in config page with export, clear, and readable recent events.
- [ ] Initialize instrumentation before app startup. Preserve network behavior, cancellation and streaming; no payload cloning, no request header changes on external APIs.
- [ ] Add tests for secret exclusion, retention, storage failure, canceled/failed operations, fetch and Axios outcomes.

### Task 2: Feature coverage
- [ ] Wrap exported async service operations for image/text/video/audio, recognition, storage, background removal, editor tasks, commerce pipeline/import/export, sync and configuration. Use static operation names and preserve signatures, return values and thrown errors.
- [ ] Inventory coverage and explicitly document limits (download handoff vs confirmed disk save, local app vs unrelated services).

### Task 3: Server diagnostics
- [ ] Add `provider-relay/diagnostics.mjs` safe classifiers/logger; instrument upstream status/timeout without logging response content. Test overload classification and credential non-disclosure.
- [ ] Add deployment diagnostic Nginx format/map and logrotate configuration: fixed route groups, generated request IDs, status/upstream status/timing only; private file, 14-day rotation with size limits. Enable API access logs in existing locations without changing routing/auth/timeouts.
- [ ] Keep service logs in dedicated rotated files so global journald behavior remains unchanged. No public log-reading endpoint.

### Task 4: Validation and release
- [ ] Run focused Vitest tests, provider Node tests, TypeScript check, production build; retain exit codes and complete output.
- [ ] Verify browser export/clear, failing request recording and no sensitive data in exported file.
- [ ] Back up production configs and code; validate nginx configuration before reload. Deploy frontend atomically with old release retained. Verify API logs using read-only or rejected synthetic requests without paid generation.
- [ ] Document coverage, retrieval commands, retention and rollback in deployment docs. Update checklist with actual results and disclose any remaining limits.
