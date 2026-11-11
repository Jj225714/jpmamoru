# Product Suggestions and Creative Commerce v3 Implementation Plan

> **For agentic workers:** Use disjoint implementation tasks and independent integration review. This checkout has no Git metadata; preserve a source backup rather than creating commits.

**Goal:** Deliver on-demand six-field product suggestions, 32 practical creative recipes, and paired before/after generation without changing historical jobs.

**Architecture:** Shared typed creative briefs are resolved into immutable selection snapshots and deterministic prompts. Structured product suggestions remain drafts until explicitly adopted. Paired generation has two individually tracked sources with strict dependency lineage; only composed outputs count as finals.

**Tech Stack:** TypeScript, React, Ant Design, Zustand, Vitest, Vite, Nginx.

## Chunk 1: Data contracts and implementation

- [x] Extend commerce types with optional creative briefs, recipe strategy, product suggestions and comparison sources; keep old persistence values valid.
- [x] Implement 8 recipes per category (32 total), first 4 enabled, plus pure creative-brief resolution and prompt compilation. No invented specifications or demographic stereotypes.
- [x] Extend product analysis service with structured six-field suggestions and separate uncertainty; preserve original workbench interface/behavior. Tests for known-input precedence, invalid output and cancellation.
- [x] Add manual suggestion editor to new-job and SKU screens, stale-response guards and explicit selected-field adoption; relax only selling-point import/form requirements.
- [x] Add brand/task/recipe shooting controls and immutable v3 task creation; historical jobs copy into v3 rather than modifying the original.
- [x] Extend visual planner, generator, renderer and policy/export checks for before/after pairs, preserving successful before sources on retry and validating exact provenance.

## Chunk 2: Integration and release

- [x] Test all 32 recipes, default 4 selection and counts, option inheritance, no auto API calls, inference/adoption boundaries and changed-input invalidation.
- [x] Test sequential pair generation, first/second failure, stale requests, bilingual/multisite matrices, source-set approval and export.
- [x] Run frontend typecheck, full Vitest suite and production build; independently review integration and browser UI without paid generation. 526 frontend and 5 publication tests passed. Review added pair-panel visibility/geometry enforcement and stale compliance-action guards.
- [x] Publish v5 creative catalog at `catalog-creative-v1.json` via `commerceCreativePolicyCatalogUrl`; retain previous catalog endpoints, images, private data and model gateway.
- [x] Upload checksummed frontend to an independent release directory and atomically switch; verify HTTPS assets/catalog and privacy boundaries.
- [x] Update CLAUDE.md, deployment notes, changelog and manual-verification checklist; report exact tests and distinguish mocked from live model validation. Production browser automation failed to connect; production HTTP/artifact verification passed, local UI and mocked browser inference were checked.

## Required defaults and boundaries

- Single SKU/shared sites: main white + 3 gallery + selected language count × 1 marketing = 4 + L finals; marketing off = 4.
- Optional recipes: second scenario, adult interaction (hands/partial), lighting, before/after; count defaults to 1, bounds 0–4.
- Before/after sources are generated sequentially and composed uncropped side-by-side with editable labels/text; never repeat a source or silently fall back to white.
- Suggestions run only on user click. Existing fields stay unchanged unless selected for explicit replacement. English taxonomy never silently changes internal category; adopting suggestions never certifies product facts.
- Unverified materials, performance and specs remain separate uncertainty, not promotional facts. Default recipes require only normal product identity/images, not irrelevant performance fields.
- All old tasks, references, defaults and custom features remain available. No automatic paid generation or forced migration.
