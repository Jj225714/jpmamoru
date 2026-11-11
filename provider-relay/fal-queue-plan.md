# Fal persistent queue implementation plan

**Goal:** Resume encrypted waiting Fal work without replaying an ambiguous paid submit.
**Architecture:** Reuse QueueCipher and JsonJobStore. Claim and persist submission intent before network; retain credential-only ciphertext after provider ID acceptance. Startup query recovery runs once per restored task.
**Tech Stack:** Node.js built-in crypto, filesystem, test runner.

- [x] Extend job-service.mjs with bounded encrypted waiting, local cancellation, synchronous claims, fail-closed storage handling and query-only recovery.
- [x] Wire FAL_JOB_QUEUE_KEY_FILE and startup initialization in server.mjs.
- [x] Add fal-durable-queue.test.mjs for restart boundaries, concurrency, cancellation, encryption, deduplication and failures.
- [x] Run node --test *.test.mjs; document configuration and remaining limitations in durable-queue.md.

Execution remains in the assigned provider-relay directory and current module chat under the project dispatch agreement. No deployment or frontend changes.
