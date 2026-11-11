# Asset service implementation plan and personal contract (v1 baseline)

**Goal:** Deliver an independently testable personal asset service without claiming unavailable team/project authorization.
**Architecture:** New `/api/config-vault/asset-library` namespace; authenticated user identity from existing JAPI session. One encrypted atomic snapshot per user includes metadata, binary payload, quota and audit. Filesystem exclusive lock serializes writers across handlers/processes.
**Tech Stack:** Node built-ins, existing encrypted persistence.

## Implementation steps
- [x] Add focused isolation, quota concurrency, deduplication, trash/restore, thumbnail and restart tests.
- [x] Implement asset service and integrate after authentication, before legacy settings routing.
- [x] Run dedicated and existing config-vault Node tests; document limitations and front-end contract.

No frontend changes, deployments, legacy record migration or credentials. Shared checkout is not a Git repository; preserve existing files and do not commit unrelated changes.

## Frontend contract (v1)
All URLs below are relative to `/api/config-vault/asset-library`. Use the existing secure vault session cookie and origin checks. Every mutation requires `X-Config-User` equal to the current session user ID; this header detects stale tabs, never grants identity. No client-supplied owner/team/project fields are accepted in upload JSON. Authorized shared targets use query parameters as defined in `membership-contract.md`. Each request revalidates the active account through JAPI.

| Method / URL | Input / response |
| --- | --- |
| POST `/` (no trailing slash on actual base URL) | JSON `{scope:"personal",name,mimeType,data,metadata?}`; `data` is canonical base64. Returns `{asset,deduplicated}`. |
| GET base URL | `{assets:[metadata...]}` for active assets. Optional `?trash=true` lists trash. |
| GET `/:id` | `{asset}` including trash metadata, owner only. |
| GET `/:id/content` | Original bytes; active assets only. Always attachment/octet-stream with nosniff and CSP sandbox. Fetch authenticated bytes and create a local preview; MIME is untrusted metadata. |
| DELETE `/:id` | Move to trash, `{asset}`. Idempotent. |
| POST `/:id/restore` | Restore stable ID, `{asset}`. Idempotent. No JSON body required. |
| PUT `/:id/thumbnail` | `{thumbnailId: string|null}`; indexed thumbnail must be another active same-owner asset with declared image MIME. Returns `{asset}`. |
| GET `/quota` | `limitBytes,usedBytes,trashCounts,maxFileBytes,maxAssets,scope`. |
| GET `/audit` | Last 1000 successful mutation events, monotonic `lastSequence`; actor, action, assetId and timestamp. No binary/credentials. |

Metadata: `id` (server UUID), `ownerId`, `scope`, `name`, `mimeType`, `bytes`, `sha256`, `createdAt`, `updatedAt`, `deletedAt`, `thumbnailId`, `metadataEntries`. See `asset-metadata-contract.md` for business provenance and migration endpoints. Binary/base64 never appears in metadata responses. IDs are scoped by authenticated owner lookup; another user receives 404 for every object operation, including metadata/delete/restore/thumbnail.

SHA-256 dedup is strictly per owner within this new library. Re-upload returns the original ID without charging content again and may append distinct validated business metadata; it does not rename an existing object. A matching trashed object returns 409 and must be restored explicitly. Same content in different accounts receives different IDs and separate quota charges. No global content-existence oracle. No hard delete in v1.

Defaults: 100 MiB logical bytes per user, 20 MiB per file, 1000 assets including trash. Service factory `assetQuotaBytes` can override the default for embedded integrations/tests. Trash remains charged, preventing delete/restore quota races. Thumbnail binaries count as ordinary assets; deleting one clears every referencing index atomically. This is an index, not thumbnail generation or image validation. Restore refuses if the stored usage exceeds a newly lowered quota.

Status: 400 invalid shape/base64/query; 401 invalid/revoked login; 403 origin, unsupported scope or missing scope permission; 404 missing/foreign/inactive content; 409 stale account header or duplicate in trash; 413 file/count/byte limit; 503 storage lock unavailable. Error body retains the vault's existing generic error envelope. No pagination in this bounded first unit.

## Authorization and compatibility limits (superseded for shared scopes)
Existing `/assets` and `/assets/{personal|team}/{sha256}` remain untouched for configuration compatibility. Existing `settings-team` and administrator IDs describe a deployment-wide rules space, NOT verifiable team membership. Shared scopes are now enabled only through the independent authoritative membership service described in `membership-contract.md`. Global rules administrators still receive no automatic team/project rights. Never label the old global rules attachments as multi-tenant team assets.

Legacy attachments and browser-local assets are not automatically imported, counted, or migrated. New quotas cover this library only, not total deployment capacity. Frontend must explicitly upload local content and persist returned IDs; it must not rewrite old settings URLs to new URLs. No frontend files are changed here.

## Persistence and operational boundaries
One encrypted snapshot `asset-library-user-<id>.enc` contains content, metadata, mutation audit and quota inputs. Existing AES-GCM + fsync + atomic rename is the sole commit point. No separately committed blob/index can diverge. A per-owner exclusive filesystem directory lock protects the entire read/modify/write across processes sharing the same local store. Different owners are independent. Contention waits up to approximately two seconds then returns 503 (caller may retry).

A restart after all requests have completed and drained releases locks and reloads snapshots. The existing CLI does not install SIGTERM/SIGINT request-draining handlers; stopping during a write can leave a lock. Abrupt process death may leave `asset-library-user-<id>.lock`: fail closed, never steal based on age. Recovery requires operator verification that ALL writers for this store are stopped, then removing only the affected lock directory before restart. This implementation does not provide automatic crash-lock recovery, distributed/network-filesystem locking, or HA. Atomic snapshot crash semantics rely on the underlying local filesystem; power-loss testing was not performed.

Each mutation rewrites the entire encrypted per-user snapshot; this is a bounded first unit, not large-scale media storage. Back up the key and snapshots together using existing operational procedures. Audit retains only the newest 1000 successful state changes, not a compliance ledger or denied/read access log. Pure dedup/idempotent replays produce no event; new provenance and migration bindings are audited. Asset library does not replace the existing legacy upload capacity policy.

## Verification
Run from repository root:
`node --test infinite-canvas/config-vault/asset-service.test.mjs infinite-canvas/config-vault/server.test.mjs infinite-canvas/config-vault/settings.test.mjs`

Tests exercise real local HTTP with mocked JAPI authentication, two separately constructed server handlers sharing disk, ownership matrix, unsupported shared scopes, origin/header checks, revocation, duplicates, quota rejection/race, trash/restore, thumbnail ownership/unlink, encrypted persistence/restart and legacy attachments. No production access, browser integration or deployment performed.


Final local result: 14/14 Node tests passed (5 dedicated asset tests and 9 existing vault/settings tests). Independent read-only review completed; malformed Unicode filenames were fixed and regression tested. No frontend, provider-relay, deployment or production changes.



