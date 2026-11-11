# Provider Relay Fal job MVP

The existing `/api/providers/fal/submit/*` and `/api/providers/fal/requests/*` endpoints remain unchanged. The optional job API is enabled only when the relay process has `AOWEISI_JOB_STORE` set; this avoids changing deployments that have not allocated a writable state directory.

```sh
AOWEISI_JOB_STORE=/var/lib/aoweisi-model-gateway/provider-relay-jobs.json \
  node server.mjs --origin https://example.test
```

The server mounts these routes:

```http
POST /api/providers/fal/jobs/flux-fill
Authorization: Bearer <caller-key>
Idempotency-Key: stable-client-key
Content-Type: application/json

{"image_url":"data:image/png;base64,...","mask_url":"data:image/png;base64,...","prompt":"..."}
```

The response is `202` with `{ "job_id", "status": "queued" }`. Poll with:

```http
GET /api/providers/fal/jobs/flux-fill/<job_id>
Authorization: Bearer <caller-key>
```

Cancel with `POST` to the same URL and `X-Job-Action: cancel`. A repeated idempotency key returns the same `job_id`; a different body returns `409`.

Only metadata, the request fingerprint, and the upstream provider job ID are persisted. Credentials and image payloads are process-local. A restart marks jobs with a provider ID as `recoverable`; the first authenticated status request resumes polling. Jobs interrupted before the provider returned an ID become `uncertain` and are never resubmitted automatically. Submit is never retried; transient status polling errors use bounded exponential backoff.

