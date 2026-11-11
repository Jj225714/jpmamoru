# GPT Image Background Jobs Implementation Plan

**Goal:** Route supported GPT image generation and editing through durable job IDs so browser disconnects do not restart paid generation.
**Architecture:** Same-origin job API in Provider Relay; fixed configured Sub2API upstream. Frontend feature flag activates job submission and polling on the real generation paths. Only clearly rejected rate-limit attempts can retry; ambiguous dispatch failures become uncertain.
**Tech Stack:** Node HTTP/fetch, JSON job metadata, React/TypeScript, IndexedDB, systemd/Nginx.

## Chunk 1: Contract and implementation
- [ ] Gateway module: provider-relay/gpt-job-service.mjs and tests, mount in server.mjs. POST /api/providers/gpt/jobs {operation,body}; Bearer + Idempotency-Key; GET /:id returns job_id/status/result/error. Restrict model, payload, origin, owner and concurrency. Preserve Fal routes.
- [ ] Frontend module: services/api/gpt-image-jobs.ts, image.ts routing, pages/image/index.tsx task recovery, runtime flag and tests. Persist job identity without credentials; no automatic second paid submit on uncertainty.
- [ ] Delivery module: correct AOWEISI_JOB_STORE to a FILE, configure GPT_IMAGE_UPSTREAM_BASE_URL, Nginx, installation source copy and documented enable/rollback steps. Do not activate production.
- [ ] Coordinator: inspect actual diffs, API compatibility, data isolation and failure behavior. Run node --test provider-relay/*.test.mjs, focused Vitest tests, npm run typecheck and npm run build after changes settle.

## Acceptance
- Successful generation/edit returns image through existing UI.
- Browser stops polling without canceling backend execution; page reload resumes the same task.
- Repeated submission with same idempotency key does not invoke upstream twice; different body conflicts.
- 401/403/400 permanent failure; network/timeout/502/504 uncertain, never blindly resubmitted.
- Worker restart yields explicit uncertainty for dispatched tasks without provider lookup support.
- No credential in persisted job documents or logs. Existing non-GPT and Fal flows remain compatible.
- Tests use mock upstream, never paid requests. Report production not enabled until deployment verified.
