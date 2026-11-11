# Retired Category Login Implementation Plan

> **For agentic workers:** Implement the scoped steps below; review independently before delivery.

**Goal:** Remove the unusable retired access-code entry and give users an accurate category view and existing local editing path.

**Architecture:** Replace CategoryConfigPanel's legacy CategoryAdmin mount with a catalog view and the existing PIN-protected PolicyEditor. Do not grant server privileges or revive retired managed endpoints. Shared publishing remains unavailable until a supported server authorization service exists.

**Tech Stack:** React, TypeScript, Ant Design, Vitest, existing commerce store.

## Chunk 1: Settings entry and regression coverage

- [x] Replace `web/src/pages/commerce/components/category-config-panel.tsx`: loading/error/empty states, catalog preview, local edit entry, explicit local scope.
- [x] Update `web/src/pages/commerce/settings.tsx` to remove the inaccurate all-platform publishing promise.
- [x] Add a render regression test proving the settings entry contains no retired login or managed request path.
- [x] Run focused tests, TypeScript check and production build.
- [x] Record cause, behavior and remaining shared-publishing limitation in `DEPLOYMENT.md`.

No deployment or server configuration change is included. No Git metadata is present in this checkout, so commits are unavailable.

