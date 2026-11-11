# Asset metadata and migration contract

Implementation plan (writing-plans workflow, within assigned backend scope):
- [x] Validate bounded versioned metadata with closed fields and same-container UUID references.
- [x] Preserve multiple provenance records under one content-deduplicated stable asset ID.
- [x] Atomically commit actor/local-ID mapping with asset, quota and audit; reject conflicting retries.
- [x] Test ACL, bounds, two-process migration, old records, restart and failure retention; document frontend handoff.

## Business metadata

Upload accepts optional `metadata` alongside the existing `{scope,name,mimeType,data}`. It is a closed JSON schema:

```json
{
  "version": 1,
  "kind": "generated",
  "source": {"taskId":"task-123", "nodeId":"node-456", "localId":"asset-old-789"},
  "generation": {
    "version": 1,
    "prompt": "White background with soft studio lighting",
    "model": "image-model-v1",
    "parameters": {"width":1024,"height":1024,"seed":42,"steps":30,"guidance":7.5,"count":1,"quality":"high","background":"white","format":"png"}
  },
  "referenceIds": ["00000000-0000-4000-8000-000000000001"]
}
```

`version` must equal 1, `kind` is `original | white-background | generated | other`. The remaining fields are optional. Missing metadata defaults to `{version:1,kind:"other"}` for compatibility. Source IDs contain 1–128 ASCII letters/digits/underscore/dot/hyphen and start with a letter/digit. Generation version must equal 1. Prompt limit: 4000 UTF-16 code units; model: original bare model syntax or exactly one channel::model selector, total 1–128 characters; detailed rules below. Metadata has an additional 8192-byte UTF-8 JSON limit. Invalid Unicode and control characters are rejected (prompt permits ordinary tab/newline).

Only the listed parameters are accepted: width/height integers 1–16384, seed integer 0–MAX_SAFE_INTEGER, steps integer 1–1000, guidance finite number 0–100, count integer 1–16; quality `low|medium|high|standard|hd|auto`, background `auto|white|transparent|unspecified`, format `png|jpeg|webp`, and optional `requestedSize` as specified below. No arbitrary parameter bags, nested extensions, credential fields, URLs, HTML, script or provider configuration objects. Recognizable URL schemes, protocol-relative URLs, credential assignments/token prefixes, markup and common executable script expressions are rejected in text. This is a restrictive data contract, not a universal secret classifier: arbitrary secret-looking prose cannot reliably be identified. Frontend must explicitly construct these fields, never spread provider settings or credentials into metadata, render prompt as text and never execute it or feed it into authorization/tool commands. Rejected content is not silently stripped.

`referenceIds` has at most 16 unique canonical UUIDs. Every reference must identify an active asset in the **same selected container**, checked under the transaction lock; cross-user, cross-team and even same-team cross-project references fail 404. Self-reference fails 400. Links express provenance only, never grant permissions or fetch arbitrary URLs. Historical references remain when a referenced asset is later trashed; its binary endpoint continues to reject access. Reference graphs are not required to be acyclic. No automatic copy between containers.

Every response asset now includes `metadataEntries`, an append-only list with at most 32 distinct validated metadata objects. Same-container SHA-256 dedup keeps ONE stable asset ID and ONE content quota charge across original/white-background/generated entry points, while appending differing provenance rather than overwriting it. Identical metadata is a no-op. Field order is normalized, reference IDs sorted. The first uploader's name/MIME/ownerId remain canonical. Existing rows without metadata return `metadataEntries:[]` and can be enriched on re-upload. Metadata is client-supplied provenance, not server-attested model execution history. An authorized writer can append provenance for shared assets; readers cannot. All members with asset read permission can see its provenance, including submitted local IDs/prompts.

## Idempotent migration

Base `/api/config-vault/asset-library`; same cookie, `X-Config-User`, origin and scope query requirements as the shared asset contract.

- **POST `/migrations`**: same upload JSON plus required `localId`. If `metadata.source.localId` is supplied it must equal this ID. Returns `{asset,mapping,deduplicated,replayed}`.
- **GET `/migrations/:localId`**: returns `{mapping,asset}` for the current authenticated actor only, within the requested scope. Requires current read permission; revoked members receive 403. Other actors' mappings are not enumerable. The asset's separately supplied provenance may still be visible to all container readers.
- Mapping: `{actorId,localId,assetId,fingerprint,createdAt}`. Key is **authenticated actor + concrete container + localId**, never just a client-provided scope label. If local IDs can repeat between independent browser libraries, frontend must namespace them before migration (still within the 128-character limit).
- Exact canonical retries return the same binding with `replayed:true`. Fingerprint covers content SHA-256, name, MIME and normalized metadata. Same key with changed bytes/name/MIME/metadata returns 409, never overwrites. An identical retry can succeed after its historical references are trashed; it returns the already committed result and does not create a new reference.
- Different old IDs or different actors can map to the same deduplicated asset. Same old ID in different containers maps independently. New mapping count limit is 10000/container. Hitting this or the 32 metadata-entry limit returns 413 without partial changes.
- An asset already in trash produces 409 on migration/retry; GET mapping still reveals its trash state to the mapping owner. Explicit restore is required. Mappings are retained through trash/restore. There is no mapping-rebind/delete endpoint or metadata-edit endpoint in this unit.

Asset creation/enrichment, mapping, quota inputs and audit are saved in the **same encrypted atomic container snapshot**. Existing filesystem membership/asset locks serialize access across processes. Audits record `create`, `metadata.append` and `migration.bind` as applicable without copying prompt/local ID into the audit event. Replays append no event and charge no quota. Read/deny access logging is unchanged. Binary quota excludes metadata, but entry/byte/count bounds limit metadata growth; no new aggregate deployment quota is claimed.

## Frontend migration safety

Keep IndexedDB/local assets and task records until the success response AND returned ID/hash/metadata have been verified and the local mapping persisted. On 400/403/404/409/413/500/503 or network loss, keep all old data. The service never calls the browser storage API or deletes local data; successful upload itself is not deletion authorization. A rename may have committed before a later persistence/response error: first GET the mapping, compare its asset/hash and metadata, then retry identical input if needed. Never generate a fresh old ID to bypass a conflicting retry. References must be migrated/uploaded first, then their returned server IDs placed in dependent asset metadata. Large migrations are per-item, not a multi-asset atomic batch.

## Validation

Run all vault tests including `asset-metadata.test.mjs`. Coverage includes strict fields/bounds, authorization matrix, same-container references, metadata provenance under dedup, actor/scope isolation, true independent-process identical/conflicting migration races, failure without mapping creation, old encrypted rows without metadata, and restart. Tests use temporary stores and fake JAPI only. No frontend, provider-relay or deployment changes.

Final validation: all 22 existing vault/asset/membership tests passed in the combined run, and the final 8 metadata/migration tests passed after review additions (30 cases total). Review found no blocking ACL, reference or replay issue. Added regression checks for historical-reference replay, same-team cross-project rejection, self-reference, metadata canonicalization and the 10000-mapping limit. Child-process test shutdown now drains active handlers; production shutdown behavior is unchanged.


## Compatibility extension: existing generation selectors/defaults

- `generation.model` is preserved byte-for-byte (no trimming, splitting in stored data or rewriting). Accept either the old bare model syntax `[A-Za-z0-9][A-Za-z0-9._/-]*`, or **exactly one** `::` with nonempty channel and model. Channel syntax: `[A-Za-z0-9_-][A-Za-z0-9._-]*`; model side uses the old bare-model syntax. Total length ≤128. Existing unsafe-text checks still apply: URLs/protocols, double slash, controls, secrets/script patterns are rejected. Empty sides, single/triple colons or multiple separators fail 400. The channel string is provenance only, never an authorization principal, URL, provider-routing instruction or membership claim.
- `parameters.requestedSize`: exact lowercase `auto`, integer ratio `A:B` (A/B each 1–10000), or explicit lowercase ASCII pixel form `WxH` (W/H each 1–16384). Integer forms use digits only, no leading zero, whitespace, signs, uppercase X or multiplication symbol; maximum 11 characters. Decimal ratio extension is specified below. Preserve original string; do not simplify ratios, compute dimensions, populate width/height or validate provider capability. Existing explicit width/height fields are independent facts; no consistency/size inference is introduced.
- `quality` additionally accepts `auto`.
- `background` additionally accepts `unspecified`, explicitly representing an old empty string. The empty string itself remains rejected.

Frontend migration adapter must explicitly translate legacy `size:'1:1'` to `requestedSize:'1:1'` and legacy `background:''` to `background:'unspecified'`; retain `quality:'auto'` and `channel::model`. Raw `size`, empty background, URL fields, unknown parameters and arbitrary channelId fields still fail 400. No frontend changes are included in this unit.

No defaults are injected for absent new fields. Existing parameter order is unchanged (numeric fields, then existing enums); requestedSize is appended only when present. Old normalized JSON and migration fingerprints therefore stay unchanged. An already bound migration key cannot be enriched by changing its metadata: that remains a 409 conflict under the existing contract.

Verification: `node --test infinite-canvas/config-vault/asset-metadata.test.mjs` — **10/10 passed**. Includes exact 128-character selector boundary, malformed separator/URL/control rejection, size bounds and unknown parameter rejection, fixed pre-change legacy fingerprint, concurrent default-parameter migration, reordered-input replay, restart replay and pre-metadata encrypted record compatibility. Only metadata validator, its tests and this contract changed for this extension; no frontend, cookie, Relay or production changes.

## Decimal ratio / nanoid follow-up

Channel IDs may start with `_` or `-` (as nanoid can), in addition to ASCII letters/digits. Remaining channel characters are letters/digits/underscore/dot/hyphen. Model side, one-and-only-one `::`, total length ≤128, URL/control/unsafe-text rejection and provenance-only semantics are unchanged.

`requestedSize` additionally accepts decimal **ratios only**, e.g. `1.9:1`, `2.5:1`, `1:2.5`:
- Exactly one colon; each side uses `(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,3})?`; at least one side has a decimal point for this branch.
- Each side must be strictly positive and ≤10000; up to three fractional digits, total string ≤19 characters.
- Ratio must be within **1:3 through 3:1 inclusive**. Exact integer-thousandths comparison avoids floating-point boundary errors (`0.1:0.3` is accepted).
- Preserve spelling including trailing fractional zeros. Do not reduce fractions, round, infer pixels or change scale. Decimal syntax is not accepted for explicit pixel sizes.
- Reject exponent notation, NaN/Infinity, signs, whitespace/controls, leading zeros, missing integer or fractional digits, excess precision, extra colons and URLs.

For backward compatibility, existing integer-ratio acceptance remains unchanged (each side 1–10000), including previously valid ratios outside 1:3–3:1. The new ratio-range restriction applies to the newly accepted decimal forms only. Old fingerprints remain unchanged; `1.9:1` and `1.90:1` remain distinct strings, so changing spelling on an already bound migration key returns 409.

Final follow-up validation: **12/12 metadata tests passed**, including precise positive/negative decimal and channel cases, fixed pre-extension legacy fingerprint, existing integer acceptance, concurrent migration, exact replay and restart. Only `asset-metadata.mjs`, `asset-metadata.test.mjs` and this contract changed. Module07 can pass the original decimal requestedSize and nanoid-prefixed selector through its explicit adapter; no frontend/production change was made here.
