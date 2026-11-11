# Reference Image Aspect Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Respect the selected output aspect ratio when general image generation has reference images, without changing canvas-local edits.

**Architecture:** Frame references in a temporary target-ratio canvas only for the general workbench's explicit-size edits. Keep original references and logs unchanged. Compare returned dimensions to selection and warn rather than silently crop or retry a paid request.

**Tech Stack:** React, TypeScript, Vitest, browser Canvas API.

---

## Chunk 1: Reference preparation

### Task 1: Frame geometry and browser transformation

**Files:** `web/src/lib/reference-frame.ts`, `web/src/lib/reference-frame.test.ts`

- [x] Write tests for square/landscape framing, matched ratio, capped canvas, and returned-ratio tolerance.
- [x] Run tests and implement non-cropping framing (4 passing).

### Task 2: Opt-in edit request

**Files:** `web/src/services/api/image.ts`, `web/src/services/api/image.reference-frame.test.ts`

- [x] Test explicit-size framed upload and unchanged default edit.
- [x] Prepare images and aspect instruction before plugin, Gemini, or multipart dispatch; preserve original labels and default behavior.
- [x] Run focused API tests.

## Chunk 2: UI and verification

### Task 3: Workbench result feedback

**Files:** `web/src/pages/image/index.tsx`, locale files.

- [x] Opt in only at general workbench call site.
- [x] Warn on material returned aspect mismatch while retaining the image and showing actual dimensions.
- [x] Run 621 tests, typecheck, and production build; do not invoke a paid image service.
