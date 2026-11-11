# Commerce Visual Pipeline Implementation Plan

> **For agentic workers:** Use parallel, disjoint implementation tasks and review their integrations before release. No Git metadata exists in this checkout; use the source backup instead of commits.

**Goal:** Generate each selected requirement's actual imagery before text layout, prevent white-image shortcuts, and publish the repaired workflow and all 40 corrected presets.

**Architecture:** Version 2 uses a deterministic visual plan keyed by requirement, sequence, variant and site. Marketing bases are intermediate assets, never final exports. Historical tasks remain readable/exportable and require an explicit revision upgrade for generation.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Vite, Nginx.

## Chunk 1: Independent implementation

- [x] Add `web/src/lib/commerce/visual-plan.ts` and regression tests: deterministic identity, missing inputs, exact source matching and disabled-selection behavior.
- [x] Update `pipeline.ts` and `template-renderer.ts`: generate every planned visual with effective references/overrides, save partial progress, block missing sources, draw a composed visual only once.
- [x] Update `requirement-visuals.ts`, importers, public catalog validation and rule editor: distinguish imagery from copy and repair all 40 presets using audited category/order/source-prompt mappings.
- [x] Update store, generation config and task UI: new-task version, explicit legacy upgrade, safe invalidation and visible intermediate sources.
- [x] Update policy engine and export: exact lineage checks, applicable site rules and final-only counting; preserve legacy exports.

## Chunk 2: Integration and release

- [x] Run focused regressions first; confirm no new model request is needed for tests.
- [x] Run `npm run typecheck`, `npm test -- --testTimeout=20000`, `npm run build` from `web/` (357 tests passed).
- [x] Review all agent changes and add missing cross-module regressions, including the real manual-review action followed by export.
- [x] Back up server catalog/current release; stage a new immutable v4 catalog at `catalog-visual-v2.json`, keep `catalog.json` v3 for old bundles, and use a new runtime key understood only by v2 clients.
- [x] Upload checksummed frontend build to a new release, atomically switch current, verify HTTPS assets, runtime configuration, catalog counts and gateway remain available. All 84 reference image URLs verified; unauthenticated gateway/private archive return 401.
- [x] Update `CLAUDE.md`, `DEPLOYMENT.md`, `CHANGELOG.md`; distinguish mocked request validation from real paid visual generation. Local historical-task UI verified; production browser automation timed out, HTTP and artifact validation passed.

## Acceptance

Marketing-only requirements trigger imagery generation; disabled requirements do not regenerate legacy slots. Site/variant/sequence/source mismatches cannot pass review or export. No implicit white fallback or repeated-image comparison layouts. Old revisions and private data remain unchanged. No credentials in artifacts, public rules or logs.
