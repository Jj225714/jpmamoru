# Task-center HTTP integration acceptance — 2026-10-25

Security update: `account-isolation.md` supersedes the original bearer-only ownership assumptions here. This fixture now supplies dedicated task cookies to a local identity mock and the real verifier; true vault/JAPI and HTTPS browser proof are separate scripts documented there.

## Reproduce (module08)

Prerequisites: installed `web` dependencies and a Node runtime supported by this repository (Web Crypto/fetch/child-process IPC available). No API keys, production services or external image downloads are needed. From `F:\AIVIBI\sanheai\infinite-canvas\web`:

```powershell
npm test -- src/services/api/task-center.integration.test.ts --reporter=verbose --silent=false
```

The test starts a loopback mock upstream and a separate relay child process on ephemeral loopback ports. The child imports the actual `createProviderHandler`, `createGptJobHandler`, `createFalJobHandler`, `GptJobs`, `FalJobService` and encrypted JSON stores. GPT uses its real fetch implementation against mock HTTP. Fal's injected provider adapter performs real HTTP submit/status/result/cancel requests against the mock. It does not exercise the production fixed-host Fal transport.

The actual `task-center.ts` TypeScript client runs in Vitest/Node. Its fetch adapter only resolves relative URLs and supplies browser Origin/Sec-Fetch-Site headers; requests and responses pass through real HTTP and real route validation. Responses are not fabricated at the client boundary. One case deliberately consumes and loses an actual accepted response. Direct HTTP probes additionally verify backend owner/origin/action refusal, independent of client capability checks.

Client recreation models page refresh. `createTaskIntentStore` reads and writes shared in-memory Storage-compatible data, with serialized locking; this verifies serialization and reloading, not browser disk persistence or native Web Locks. Relay state lives in a unique OS temp directory. SIGKILL terminates the actual relay process, and a replacement process loads the same encrypted state. The test awaits store-write acknowledgements over IPC before kill; it does not claim arbitrary machine power-loss durability. Cleanup kills children, closes sockets and removes only that test's temp directory.

## Asserted evidence

| Scenario | Expected and observed |
| --- | --- |
| GPT five-task batch, concurrency 2 | 2 dispatched + 3 waiting; cancel one waiting; restart yields 2 uncertain + 2 succeeded + 1 canceled |
| GPT pagination | Six records (including an earlier completed task), three pages at limit 2, six distinct IDs |
| GPT result retention across restart | Earlier completed result is identical and retrieved using restored intent's original key/known ID |
| Lost accepted create response | Refresh restores key; missing body requires explicit review; identical input/key obtains original task, exactly one upstream call |
| GPT failure | Mock HTTP 400 produces failed, no resubmit |
| Fal five-task batch | One persisted provider ID, one ambiguous submit, three waiting; one local cancel; restart yields 3 succeeded + 1 uncertain + 1 canceled |
| Fal cancellation | Waiting cancel is final; no-ID submitting cancel is denied; provider cancel acknowledgement is only cancel_requested |
| Fal query recovery | Existing ID resumes reads after restart; recoverable task's explicit retry hits existing-ID query route, exactly one original submit |
| Fal failure / completed results | Provider FAILED maps to failed; completed result survives a second process restart |
| Permissions | Different bearer has empty lists/404 details; foreign Origin 403; forbidden cancellation/retry 409; uncertain cannot retry |
| Account switch | A→B→A revision change discards a delayed real HTTP response |
| Zero duplicate submissions | Unique upstream names equal total submit counts; canceled waiting task never reaches upstream |
| Plaintext checks | GPT store excludes test credential; persisted intent metadata excludes request prompt |

Verbose output emits two concise `GPT evidence:` / `Fal evidence:` summaries. Assertion failures are test failures; summaries alone are not the acceptance criterion.

Expanded regression command:

```powershell
npm test -- src/services/api/task-center.integration.test.ts src/services/api/task-center.test.ts src/services/api/intent-store.test.ts src/services/api/gpt-jobs.test.ts src/services/api/fal-jobs.test.ts --reporter=verbose --silent=false
```

Observed: **5 files / 43 tests passed**, including 2 HTTP integration scenarios. `prepareIntent` remains async; consumers must await it. No runtime client/backend mismatch was found, so no production implementation change was needed for this acceptance work.

## Limits and follow-up against real Sub2API

- No production deployment, real provider requests, billing, refunds or actual model generation were performed.
- Mock GPT returns small synthetic base64. Real Sub2API still needs validation of model availability, generation/edit multipart compatibility, result format/URL downloads, timeouts, explicit 429 behavior and ambiguous disconnect behavior. Never verify ambiguity by blindly issuing a new paid request.
- Real Fal acceptance, status/result formats, result URL validity and cancellation semantics remain upstream integration checks. The local test verifies the coordinator/HTTP/client contract, not production Fal transport or billing guarantees.
- Production launcher/environment key-file loading, reverse proxy/TLS, browser CORS, native localStorage/Web Locks, page rendering and actual navigation are not covered by this controlled-runtime suite.
- Production jobs now isolate verified vault accounts even with a shared provider key. The account-isolation suite tests that shared-key case against actual vault/JAPI authentication; the original scenarios in this file still use distinct test credentials. Changed credentials must receive a new channel binding ID.
- Single-process store constraints, 1000-record capacity, seven-day legacy dedup window and retained durable tombstones remain as documented in `durable-queue.md`. No test establishes distributed exactly-once execution.
- Full-site typecheck during this run reported an unrelated `src/pages/image/canvas-reference-harness.tsx:25` string-versus-counts-object error. This test change does not modify that module; report current full-site status separately when reproducing.
