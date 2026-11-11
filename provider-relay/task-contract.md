# Task lifecycle contract — 2026-10-25

Update: `durable-queue.md` supersedes the historical admission-only, cancellation and persistence statements below for both GPT and Fal tasks created with explicitly configured encryption keys. Unconfigured channels remain admission-only. Read backend `actions`/`queue_mode` rather than hard-coding the historical behavior below. Local real-HTTP frontend/backend acceptance and reproduction steps are recorded in `task-center-integration.md`.

Account-isolation update: jobs now require a verified vault task-session cookie as well as the model bearer. See `account-isolation.md` for the trust chain, dedicated cookie, legacy quarantine and deployment requirements. Shared provider bearers no longer share the application jobs namespace between verified accounts. Legacy raw Fal routes and external provider permissions are separate boundaries.

## Query response

Existing `job_id`, `status`, `result`, `error` remain. Both services add:

```json
{
  "created_at": 1790000000000,
  "updated_at": 1790000005000,
  "started_at": 1790000000010,
  "finished_at": null,
  "elapsed_ms": 5000,
  "progress": {"stage":"generating", "percent":null},
  "actions": {
    "cancel":{"allowed":false,"reason":"not_cancelable"},
    "retry":{"allowed":false,"mode":null,"reason":"paid_resubmit_disabled"}
  }
}
```

Times are Unix milliseconds. Elapsed includes queue/retry time and freezes at a known terminal timestamp. Historical records without timestamps return null. No estimated percentages or ETA: only success is 100. Stages include queued, submitting, provider_queue, generating/running, retrying, collecting_result, cancel_requested, succeeded, failed, canceled, uncertain and recoverable. Cancellation pending is a stage, not a confirmed cancellation.

## Operations

- GPT: `POST /api/providers/gpt/jobs`, `GET /api/providers/gpt/jobs/:id`. POST to an existing job with `X-Job-Action: cancel` returns 409 `not_cancelable`; retry returns 409 `paid_resubmit_disabled`. Owner is checked first. A browser abort does not cancel a paid upstream call.
- Fal: `POST /api/providers/fal/jobs/:model`, `GET /api/providers/fal/jobs/:model/:id`. POST to the existing job with `X-Job-Action: cancel` requests provider cancellation only when an upstream ID exists. An acknowledgement does not prove cancellation or refunded billing; only provider CANCELED/CANCELLED marks canceled. A failed cancel remains queryable and never becomes canceled automatically.
- Fal `X-Job-Action: retry` is **read recovery only**, allowed in recoverable state. It resumes status/result on the stored provider job ID, never submit. The response is immediate; continue polling. Multiple queries/retries share one recovery worker. Auto-recovery on GET is retained for compatibility.
- A repeated create key and identical body returns the original job, including failed/uncertain jobs. It never retries a paid submission. Conflicting input returns 409. No manual paid-resubmit endpoint is implemented.

## Concurrency

Single process only. Defaults are 2 for the GPT configured upstream channel and 2 for the Fal channel; these are separate caps, not a combined cap of 2. Configure `GPT_JOB_MAX_ACTIVE` / `FAL_JOB_MAX_ACTIVE` (integer 1–32) and optional `GPT_JOB_MODEL_LIMITS` / `FAL_JOB_MODEL_LIMITS` JSON objects, e.g. `{"gpt-image-2":1}` or `{"esrgan":1}`. Model caps must be between 1 and the channel cap; invalid configuration fails startup. Restored Fal query workers consume slots too.

There is no durable local backlog: queued means accepted locally before worker submission, or Fal reports IN_QUEUE. Beyond admission limits return 429 before upstream submit, without a job. Frontends should retain the same idempotency key and use bounded backoff. Successful/in-flight duplicate requests do not consume new slots. Capacity also rejects after 1000 stored records; waiting does not resolve retention exhaustion.

## Recovery and limits

- Successful persisted results remain queryable after restart, with no new upstream call, until the retention period expires. Authenticated task-list APIs and retention details are specified in `task-list.md`.
- On restart queued/running/retrying GPT or Fal without a provider ID becomes uncertain. Credentials and request payloads are not persisted, so these cannot safely auto-resume or retry.
- Fal with a provider ID becomes recoverable. Status-read exhaustion, result-read failure, or the nine-minute polling window also becomes recoverable. Resume reuses the same provider job. Provider result retention/URL expiry can still prevent recovery.
- GPT explicit 429 can retry at most twice after the first call. Network/timeout/5xx ambiguity remains uncertain. A missing/unpersistable success result cannot be regenerated safely.
- Fal confirmed provider failure stays failed, with paid retry disabled. Unknown submission outcomes stay uncertain. Cancelling during the initial submit without an ID is disallowed.
- Full JSON/base64 snapshot storage rewrites the whole file on transitions, has a 1000-record hard cap, and is not unlimited storage. Request-triggered expiry cleanup now removes confirmed terminal jobs after seven days; unresolved jobs remain protected. No cleanup daemon, multi-process locks, durable input queue, durable credentials or result-URL archival have been added. A storage failure can make durable state unavailable; do not present it as a completed retry.

Frontend dependency: use `actions` to enable buttons; show phase plus elapsed time rather than a fabricated percent. Keep recovering/querying separate from creating a new paid job. Do not interpret uncertain as failed-and-retryable. UI integration and deployment are outside this change.
