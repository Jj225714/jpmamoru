# Encrypted persistent GPT and Fal waiting queues (single-process subset)

Account-isolation update: see `account-isolation.md`. Production active stores now use `.account-v1` suffixes, queue identities bind verified accounts, and old bearer-only stores are read-only quarantine. The original filenames described below refer to the earlier storage generation. Browser session cookies are never persisted, including inside encrypted queue envelopes.

## Configuration and scope

This implements durable waiting for GPT generations/edits and Fal jobs. No frontend/deployment files are changed. Legacy raw Fal relay routes remain unchanged.

Set `GPT_JOB_QUEUE_KEY_FILE` to a private file containing a canonical base64 encoding of **32 cryptographically random bytes**. Generate it using an approved secret-provisioning process; never include a real key in code, docs, URLs, command arguments or the job JSON. POSIX permissions must exclude group/other access (0600); on Windows the operator must restrict NTFS ACLs to the service/admin account. The key must live outside static sites, source and job data, with separate protected backup. `AOWEISI_JOB_STORE` is still a file path and GPT uses its `.gpt` sibling. The server loads the key once at startup and initializes recovery before listening.

Fal is independently enabled with `FAL_JOB_QUEUE_KEY_FILE`, using the same key-file format and permissions. It stores state at `AOWEISI_JOB_STORE` itself. There is no implicit fallback to the GPT key. Configure each channel explicitly. `FAL_JOB_MAX_ACTIVE` defaults to 2; `FAL_JOB_MODEL_LIMITS` is a JSON object of per-model caps (positive integers no greater than the channel cap). Both channels initialize their queues at server startup without requiring a browser request.

No key file configured: persistent queuing is disabled, and the previous pre-submit 429 admission behavior remains. Invalid/unreadable key configuration fails startup; it never enables plaintext persistence. Existing encrypted waiting entries remain locked and queryable/cancelable without a key. Supplying a different key cannot decrypt old entries: these fail safely without any upstream call. Automatic key rotation/multi-key lookup is not implemented; retain the original key until all waiting work is drained.

## Persistence and state machine

The existing POST body/headers and response endpoints remain unchanged. With encryption enabled, each accepted task persists an AES-256-GCM envelope containing the input and caller credential before acceptance. Every envelope uses a random 96-bit nonce and authentication tag; additional authenticated data binds job ID, owner hash, idempotency identity and the fixed server upstream URL. Metadata (model, state, timing, hashes) remains readable; no prompts, input images or caller keys are in plaintext queue JSON. API views/list responses never return envelopes. Successful output images remain in the existing result storage format; output encryption is not part of this subset.

1. Enqueue: persist `status=queued, queueState=waiting` with ciphertext. The same key/body returns the existing job. A conflicting body is 409. Upstream is not called while waiting.
2. Schedule: synchronously claim an available channel/model slot and set `queueState=submitting`. Commit the submission intent with file sync and atomic file replacement BEFORE any network operation. POSIX also syncs the containing directory. This is a single-process serialized store, not a multi-process transaction manager.
3. Decrypt/validate, remove the encrypted payload from current state, persist again, then execute. GPT running cancellation is unsupported. An explicit 429 may use the existing bounded retry policy; no retry of ambiguous transport/timeout/5xx.
4. Restart: only authenticated encrypted entries still marked `waiting + queued` are rescheduled. Any running/submitting/retrying job becomes uncertain, even if the process might have died before actually sending bytes. This conservative outcome avoids a second paid request; it is not an exactly-once execution guarantee.
5. Storage failure stops additional queue dispatch. A submission marker that cannot be persisted causes zero upstream calls. Recovery may safely requeue an older durable waiting record only when the marker never committed and no network was attempted.

Cancellation is `POST /api/providers/gpt/jobs/:id` with `X-Job-Action: cancel`. Owner validation is unchanged. It succeeds only while the durable waiting claim has not been taken, removes ciphertext and persists canceled. Once a scheduler claim is taken, it returns 409 `not_cancelable`, even during the disk commit before network dispatch. There is no cancel/submit race window. A canceled key never creates replacement work.

`queue_mode=encrypted_persistent` identifies durable tasks in detail/list responses; `admission_only` identifies legacy tasks. `progress.stage=waiting` is actual server queueing. `actions.cancel` identifies eligibility. Normal result retrieval and elapsed timing are unchanged.

## Scheduling, caps and idempotency

Default GPT channel concurrency is 2, configured by `GPT_JOB_MAX_ACTIVE`; `GPT_JOB_MODEL_LIMITS` applies per-model caps. One server process serves the configured GPT channel. Waiting iteration follows persisted insertion order, skipping a model that currently has no slot so other models can proceed. Occupied slots include the existing bounded 429 retry sleep. No cross-process locks or distributed leases are provided; NEVER run multiple writers against the same store.

The encrypted waiting envelope budget defaults to 128 MiB (base64 ciphertext bytes), plus the 1000-record hard cap. Exceeding the byte budget returns 429 `queue_bytes_capacity` before creating a job. The memory/whole-file JSON/result limitations remain; this is not unlimited queuing.

For durable queue jobs, the idempotency metadata is never automatically deleted: terminal result data expires after seven days, but a small identity/tombstone remains (`result_expired=true`). Same-key submissions still return the original task, even canceled/failed/uncertain or after result expiry. The 1000-record cap currently counts these tombstones: sustained use will require a separate indexed identity database and explicit retention/product policy. Do not manually remove tombstones to make room and then claim permanent deduplication. Legacy admission-only tasks retain their documented seven-day dedup retention. Keys cannot deduplicate across a changed owner credential or separate/missing state files.

## Verified and remaining

Tests use mocked local HTTP only, including five-item queueing, per-model/channel limits, identical keys, encrypted file scans, cancel/dispatch competition, storage failures, missing/wrong keys, and a real child-process kill/restart. A dispatched request plus four waiting tasks produces five total distinct submissions after restart; the original dispatched job remains uncertain.

This does not implement multi-process execution, automatic key rotation, long-term scalable storage, machine power-loss guarantees on every filesystem, upstream reconciliation for uncertain tasks without a provider ID, or frontend queue controls. Windows file/directory durability depends on platform filesystem semantics; process-kill recovery was tested, sudden power loss was not. A fresh authenticated request may be required for legacy Fal recovery. Completion/unknown submission cannot be regenerated automatically. Frontend should show durable waiting/cancel controls only from the returned task capabilities; when encryption is disabled, keep its bounded same-key retry behavior for pre-submit 429.

## Fal state machine and recovery

Fal uses the existing `/api/providers/fal/jobs/:model` endpoints and headers. A waiting record contains AES-256-GCM encrypted `{payload, credential}`. Authenticated context binds channel, fixed Fal upstream, job ID, owner hash, model and idempotency identity. Existing Fal body fingerprint semantics are preserved (JSON serialization order matters). The identity remains scoped to owner + model + caller key.

The scheduler scans insertion order, skipping saturated models. It synchronously claims a slot and changes waiting to submitting, then syncs the intent before network. It decrypts and verifies the owner/input hashes, replaces the envelope with credential-only ciphertext, persists that, and submits exactly once. No Fal submit error is automatically retried. Provider ID is persisted before querying. Terminal transitions remove the current ciphertext; historical backups/temp files need the same protection as the store.

On restart, waiting entries may submit. A committed submit without a provider ID becomes uncertain and never replays. A saved provider ID becomes recoverable and, when an encrypted credential is available, resumes status/result queries once per process startup. Query failures remain recoverable without an automatic busy retry loop; authenticated GET or explicit retry can resume bounded queries against the same ID. Missing keys leave waiting entries locked; wrong keys fail waiting entries without network. An existing-ID decryption failure leaves query recovery available with a fresh caller credential. Legacy records and missing-key records require a fresh credential for query recovery.

Local cancellation succeeds only before the scheduler's synchronous claim, removes ciphertext, persists canceled, and preserves the original idempotency identity. After claim but before provider ID it returns 409. After provider ID, cancellation is a provider request: failed requests remain unconfirmed, and acknowledgements remain pending until status confirms cancellation or completion. The original worker and recovery workers share the channel/model limits.

Fal has the same 1000-record cap and default 128 MiB ciphertext-data budget (including encrypted query credentials). Durable identity tombstones count against capacity and are never automatically reclaimed. The store remains a whole-file, single-writer design; multiple processes, rotation/re-encryption, scalable capacity management and frontend controls remain out of scope.

`fal-durable-queue.test.mjs` verifies waiting/model caps, cancellation races, owner/dedup isolation, plaintext scans, missing/wrong keys, failed intent writes, disconnect uncertainty, one-shot query recovery, retained identities and real process kill/restart. The kill test leaves one accepted provider ID, one ambiguous submission and three waiting jobs: restart yields four successes and one uncertain job, with exactly five distinct submits overall and only queries for the original accepted ID. All providers in these tests are local mocks; no paid requests or production deployment are performed.
