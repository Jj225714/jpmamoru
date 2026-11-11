# Image MIME Reuse Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent generated or uploaded raster images from being rejected when their declared MIME type differs from their actual PNG/JPEG/WebP/GIF bytes.

**Architecture:** Detect raster type from magic bytes when converting base64 model output and again before constructing an upload `File`. The first layer keeps stored/exported metadata correct; the second layer repairs already-saved historical images before managed-gateway validation.

**Tech Stack:** TypeScript, browser File/Data URL APIs, Vitest, Vite.

---

### Task 1: Add signature-based MIME detection

**Files:**
- Modify: `web/src/lib/image-utils.ts`
- Create: `web/src/lib/image-utils.test.ts`

- [x] Detect PNG, JPEG, WebP, and GIF magic bytes.
- [x] Normalize `image/jpg` to `image/jpeg`.
- [x] Make `dataUrlToFile` prefer detected bytes over a stale declared MIME type.

### Task 2: Correct model base64 responses at ingestion

**Files:**
- Modify: `web/src/services/api/image.ts`
- Modify: `web/src/services/api/image.managed.test.ts`

- [x] Build base64 Data URLs with the detected actual MIME type.
- [x] Test JPEG bytes returned through `b64_json` and reused by image editing.

### Task 3: Verify and publish

- [x] Run focused tests, full frontend tests, typecheck, and production build.
- [x] Deploy a new immutable frontend release without changing model credentials or gateway state.
- [x] Re-run zero-quota server validation to prove the repaired multipart reaches quota admission instead of `invalid_request`.
