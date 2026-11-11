# Product Uncertainty Confirmation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users resolve every AI “待确认信息” item as confirmed, edited-and-confirmed, or ignored, and persist confirmed values as product facts.

**Architecture:** Keep the original uncertainty strings for backward compatibility and add optional resolution records keyed by a deterministic item ID. The shared editor owns the row interaction; task details persist confirmed values through the existing fact-update invalidation path, while the new-task form carries resolved facts into the created SKU.

**Tech Stack:** React, TypeScript, Ant Design, Zustand, Vitest.

---

### Task 1: Resolution model and helpers

**Files:** `web/src/types/commerce.ts`, `web/src/lib/commerce/product-suggestions.ts`, `web/src/lib/commerce/product-suggestions.test.ts`

- [x] Add backward-compatible resolution types and deterministic keys/default fact labels.
- [x] Add tests for old drafts, confirmed values, edited values, and ignored items.

### Task 2: Row-level confirmation UI

**Files:** `web/src/pages/commerce/components/product-suggestion-editor.tsx`, `web/src/pages/commerce/components/creative-ui.test.tsx`

- [x] Replace the passive warning list with editable rows and three explicit actions.
- [x] Show persisted status and prevent stale drafts from being resolved.

### Task 3: Persist facts in tasks and new jobs

**Files:** `web/src/stores/use-commerce-store.ts`, `web/src/pages/commerce/job.tsx`, `web/src/pages/commerce/index.tsx`, store tests

- [x] Route task confirmations through product-fact invalidation.
- [x] Carry confirmed facts from the new-job dialog into the created product.
- [x] Verify ignored items do not change product facts.

### Task 4: Verify and publish

- [x] Run focused tests, full tests, typecheck, and build.
- [x] Update changelog/deployment documentation.
- [x] Deploy an immutable frontend release and verify production pages and services.
