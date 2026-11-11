# Task list, retention and queue boundary

Update: opt-in encrypted GPT and Fal waiting are implemented; see `durable-queue.md` for configuration, cancellation, restart behavior and retained idempotency tombstones. The older future-design and non-persistence statements below are historical; distributed scheduling remains unimplemented. Admission-only behavior still applies without an encryption key. The shared frontend client now persists metadata-only creation intents; see `task-center-integration.md` for real-HTTP integration acceptance and remaining browser/deployment boundaries.

## Implemented API

Authentication/ownership update: `account-isolation.md` supersedes bearer-only ownership statements below. Production jobs require the dedicated vault task-session cookie plus provider bearer; listing is scoped to verified account and provider credential. Legacy task files are quarantined, not claimable by current key holders.

Same bearer authentication and same-origin policy as the existing job routes:

* `GET /api/providers/gpt/jobs?limit=20&cursor=...`
* `GET /api/providers/fal/jobs/esrgan?limit=20&cursor=...` (also flux-fill, qwen-layered)

Fal lists one model at a time. Both return `{items, next_cursor, retention_ms}`. The limit defaults to 20 and accepts integers 1–50. Unknown parameters, duplicate pagination parameters and malformed cursors return 400. No caller-supplied owner filter is accepted. The bearer hash defines ownership; two people sharing a key also share the same task namespace. A key change does not migrate ownership.

Items contain `job_id`, `model`, `status`, `progress`, timestamps, `elapsed_ms`, `actions`, `result_job_id`, `error` and `expires_at`. They explicitly exclude images/base64, result objects, prompts, keys, owner hashes, provider request IDs and raw upstream error messages. Errors have a bounded code and generic summary. On success use `result_job_id` with the existing authenticated detail GET route to obtain the result. Listing never starts a provider recovery worker or calls an upstream service.

Ordering is descending `(created_at, job_id)`. `next_cursor` is an opaque ordering boundary to clients, not an authorization token; all pages are independently owner-filtered. Keyset paging tolerates deletion of the anchor and insertion of newer tasks without duplicating older entries. This is not a snapshot: task states can change and expired records can disappear between pages. Refresh page one to see new tasks. Empty/end pages return `next_cursor:null`. The frontend may combine the GPT and three Fal lists, maintaining separate cursors.

## Implemented retention and idempotency

Default retention is seven days after `finished_at` for confirmed `succeeded`, `failed`, `canceled`. During that period matching idempotency keys return the same job; changed inputs return 409. Result and idempotency record expire together. After expiry the detail endpoint returns 404 and the old key is no longer deduplicated: submitting it is a NEW potentially paid operation. Frontends must never replay archived submissions blindly, and should persist/download needed images before `expires_at`.

Expiry cleanup runs before create/get/list (and Fal lifecycle operations). It is single-flight per store and persists removal before accepting new work. A write failure restores removed in-memory entries and fails the operation, preventing cleanup from authorizing replacement paid submissions. Legacy confirmed terminal records with no finish timestamp receive a new full retention window on first load. Restart preserves normal expiry timestamps and does not extend retention.

Running, queued, retrying, recoverable and uncertain records NEVER automatically expire. In particular, clearing uncertain records could silently authorize duplicated paid submissions. Operators must reconcile such records with the upstream before designing any manual archival. If all 1000 records are unexpired or unresolved, capacity remains unavailable. No background daemon is needed for admission recovery: the next authenticated operation performs expiry cleanup. Idle disk space is not reclaimed until a request occurs.

The store is still single-process, whole-file JSON with embedded base64. The seven-day window is not a byte budget. Large results can exhaust disk/memory before 1000 records; incremental metadata storage and separate result objects remain required for production scale. Retention is currently a store constructor policy; no new deployment settings or admin deletion endpoint are exposed.

## Durable queue design (not implemented)

Current behavior remains bounded admission, not a durable backlog. A request accepted with 202 starts background work, while a pre-submit 429 creates no task and makes no upstream request. Honest durable queuing needs:

1. Transactional SQLite job/idempotency metadata and bounded encrypted input blobs (images included); distinguish waiting, leased, submitting and submitted. Store no plaintext bearer key in either metadata or blobs.
2. A server-owned secret reference, or envelope-encrypted caller credential with an independently provisioned encryption key and rotation/expiry policy. This requires deployment secret lifecycle decisions not authorized by this local change. Alternatively persist only a request fingerprint and use `awaiting_client` after restart; the client reauthenticates and reuploads the matching body before any submit. That alternative does not execute unattended while the browser is closed.
3. Commit `submitting` and the upstream idempotency identity BEFORE network dispatch. A crash during submitting without a confirmed upstream ID becomes uncertain and MUST NOT be automatically leased for another submission. Without upstream idempotency/reconciliation, exactly-once paid execution cannot be guaranteed.
4. Lease/heartbeat scheduling with channel/model slots, atomic pre-dispatch cancellation, expiry quotas and encrypted blob cleanup. After a provider ID is durable, resume read-only status/result; preserve terminal transitions. Require explicit tests of crash points and secret rotation.

This change does not persist request bodies or credentials, and does not claim resumable GPT queued work. Existing restart behavior remains uncertain without a provider ID.

## Remaining frontend queue contract

* Keep a local intent ID, immutable body fingerprint and idempotency key for each desired generation; queue unsubmitted intents locally and bound parallel POSTs (default server channel cap is two).
* On pre-submit `429 job_capacity` or `upload_capacity`, use bounded backoff with the SAME key/body. Show waiting-for-capacity, not server-queued. Unexpired retention exhaustion is not guaranteed to resolve quickly.
* If a submission response is lost, do not generate a new key: retry the identical key/body within retention or reconcile through the task list. A returned task in uncertain state never enters the automatic submit queue.
* After 202, persist job ID and poll/list. GET/list failures are read failures, not generation failures. On reload rebuild server tasks from lists; local intents require the original body and current credential to submit. No background execution guarantee for local waiting intents.
* The task center UI, queued-intent persistence, and key rotation/account identity integration remain frontend and identity-module dependencies. Item 12 (durable queuing) is not fully delivered.
