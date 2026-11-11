# Commerce Review Error Navigation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make commerce review errors clickable so the page scrolls to and focuses the field or section that must be corrected.

**Architecture:** Add a small pure resolver that maps existing validation messages to stable review target IDs. Render validation messages as buttons in the job page, add IDs to requirement, fact, copy, image, and review controls, then scroll/focus and briefly highlight the resolved target.

**Tech Stack:** React 19, TypeScript, Ant Design, Vitest.

---

## Chunk 1: Error target resolution

### Task 1: Add the navigation resolver

**Files:**

- Create: `web/src/pages/commerce/review-error-navigation.ts`
- Test: `web/src/pages/commerce/review-error-navigation.test.ts`

- [x] Write focused tests for requirement, fact, product-confirmation, marketing-copy, image, and fallback errors.
- [x] Run the test and verify it fails before implementation.
- [x] Implement stable DOM target helpers and message-to-target resolution.
- [x] Run the focused test and verify it passes.

## Chunk 2: Clickable errors and anchors

### Task 2: Wire navigation into the commerce task page

**Files:**

- Modify: `web/src/pages/commerce/job.tsx`

- [x] Render each review error as a clickable button.
- [x] Add stable target IDs to current images, requirement rows, product facts, confirmation, marketing selection, and marketing copy.
- [x] On click, smoothly scroll, focus the first editable control, and briefly highlight the target.
- [x] Expose the preview-blocking message in the same clickable error list without duplicating messages.
- [x] Run typecheck and relevant tests.
- [x] Run the production build.
