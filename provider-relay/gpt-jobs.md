# GPT Images asynchronous jobs

Set `AOWEISI_JOB_STORE` to a JSON **file** path. The relay derives a separate GPT state file by appending `.gpt`, so Fal and GPT jobs never share a file.

Production Sub2API on the same host may use `GPT_IMAGE_UPSTREAM_BASE_URL=http://127.0.0.1:8080/v1`. HTTP is restricted to `localhost`, `127.0.0.1`, and `[::1]`; other hosts require HTTPS. This is server configuration, never a client request field.

One owner may use both default channel execution slots (configurable; see `task-contract.md`). A pre-submission HTTP 429 with `error.code=job_capacity` creates no job and sends nothing upstream; clients may back off and retry with the identical idempotency key and body. This differs from a returned task in `uncertain`, which must not be resubmitted under a new key. Confirmed terminal jobs now expire after seven days; see `task-list.md` for capacity and deduplication boundaries.

```sh
GPT_IMAGE_UPSTREAM_BASE_URL=https://llm.zhitouzhuan.com/v1 \
AOWEISI_JOB_STORE=/var/lib/aoweisi-model-gateway/provider-relay-jobs.json \
node server.mjs --origin https://app.example
```

Submit a fixed-target OpenAI-compatible image request:

```http
POST /api/providers/gpt/jobs
Authorization: Bearer <caller-key>
Idempotency-Key: stable-client-key
Content-Type: application/json

{"operation":"generations","body":{"model":"gpt-image-2","prompt":"...","n":1}}
```

The server returns `202` and a stable `job_id`. Query it with `GET /api/providers/gpt/jobs/<job_id>` using the same key. Supported states are `queued`, `running`, `retrying`, `succeeded`, `failed`, and `uncertain`. Edits use `operation:"edits"` and `body.images` as data URLs; the worker converts them to multipart before forwarding.

The upstream base URL is server configuration only. No client target, redirect, API key, or image URL is persisted. URL results are downloaded and stored as base64 before becoming a successful result. A transport timeout or ambiguous 5xx is `uncertain` and is never blindly resubmitted; only explicit 429 responses receive bounded retries.

The persisted result includes `output_format` and each image's `mime_type`, so a page reload does not reinterpret JPEG or WebP as PNG. This MVP retains at most 1000 task records and stores full JSON/base64 results, so it is not an unlimited queue or archival store; retention and storage cleanup are still operational responsibilities.

