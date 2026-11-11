# Latest Policy Only Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current creative v5 server catalog the only selectable policy while keeping historical job snapshots readable and preventing retired or local legacy packs from being used for new work.

**Architecture:** Treat the server catalog as the authoritative active policy. Catalog synchronization prunes obsolete unreferenced packs, retains referenced packs only as hidden historical dependencies, and all new-job/UI selectors use one explicit active-policy helper rather than “highest version wins.” The production runtime exposes only the creative catalog endpoint.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Vite, Python deployment checks, Nginx static hosting.

---

## Chunk 1: Policy selection and cleanup

### Task 1: Add authoritative policy filtering

**Files:**
- Modify: `web/src/services/commerce-policy-catalog.ts`
- Test: `web/src/services/commerce-policy-catalog.test.ts`

- [ ] Add tests proving only the incoming latest creative server pack is active.
- [ ] Preserve obsolete packs only when an existing job references them, marking them retired.
- [ ] Remove unreferenced built-in, local, and old server packs from synchronized state.
- [ ] Expose a helper for selecting the sole active creative policy.

### Task 2: Apply filtering throughout the store

**Files:**
- Modify: `web/src/stores/use-commerce-store.ts`
- Test: `web/src/stores/use-commerce-store.catalog.test.ts`

- [ ] Pass historical job references into catalog merge.
- [ ] Prevent retired, legacy, or local packs from being selected for new tasks.
- [ ] Migrate persisted policy lists after successful catalog loading.
- [ ] Keep historical jobs readable without showing their dependency packs as usable schemes.

## Chunk 2: Interface and deployment

### Task 3: Show only the latest usable policy

**Files:**
- Modify: `web/src/pages/commerce/settings.tsx`

- [ ] Render only the authoritative current policy card.
- [ ] Remove rollback/retire controls that can make obsolete schemes usable again.
- [ ] Clarify that historical task snapshots are retained but unavailable for new tasks.

### Task 4: Remove legacy public catalog entry points

**Files:**
- Modify: `deploy/runtime-config.js`
- Modify: `DEPLOYMENT.md`

- [ ] Configure production to use only `/public-rules/catalog-creative-v1.json`.
- [ ] Back up then remove legacy catalog JSON endpoints from the public server directory.
- [ ] Build, test, deploy, and verify the active catalog and settings page.
