# Account isolation for GPT/Fal jobs — local acceptance 2026-10-25

This document supersedes bearer-only ownership statements in older task/list/queue documents. No production deployment was performed.

## Verified vulnerability and boundary

`legacy-ownership.test.mjs` reproduces the historical behavior over local HTTP: synthetic users A and B sharing one provider bearer can list/read/cancel A's task. Cookie values and arbitrary user-ID headers never established application identity. Those tests now explicitly opt into `allowLegacyBearer: true` solely to preserve the reproduction. Production `server.mjs` has no legacy-mode environment switch and never enables that option.

The protected surface is `/api/providers/gpt/jobs` and `/api/providers/fal/jobs/:model`, including detail, cancellation and query recovery. Possession of a shared provider credential still conveys whatever permissions the external supplier grants to that credential. This application cannot revoke direct supplier access; legacy raw relay/provider APIs are not converted into per-user task APIs by this change. Do not claim upstream account isolation or billing isolation.

## Authentication chain and deployment handshake

1. Vault issues HttpOnly/Secure/SameSite=Strict main cookie `__Secure-config_vault`, Path `/api/config-vault`, and separate task cookie `__Secure-provider_tasks`, Path `/api/providers`, bound to the same encrypted server session. Vault owns login/switch/logout revocation. The main cookie MUST NOT be broadened to `/api`.
2. `task-center.ts` uses `credentials: "same-origin"`. Model credentials remain the Authorization bearer. Neither application session cookie is read by JavaScript or stored with task intent metadata.

Rollout dependency: older `web/src/services/api/gpt-jobs.ts` / `fal-jobs.ts` clients still use `credentials: omit` and will correctly receive 401 from protected jobs. There is deliberately no anonymous/bearer fallback. Owners of any remaining page flows must migrate to the shared client or coordinate equivalent authenticated requests before deployment; those page/client files were not changed in this task.
3. The providers proxy retains only the task cookie. Relay selects exactly one configured task-cookie value, validates its 43-character base64url format and rejects duplicates. A main cookie alone cannot authenticate jobs. Arbitrary user/forwarded headers are ignored.
4. Every jobs request calls a fixed configured `GET /api/config-vault/session` endpoint. Relay forwards only the selected task cookie plus configured public Host/Origin and `Sec-Fetch-Site: same-origin`. Provider bearer, arbitrary cookies and client identity headers are never forwarded. Vault revalidates current active JAPI identity; expected response is `{ "user": { "id": "101" } }` with a positive decimal ID (safe integer numbers also accepted).
5. Only the verified ID and configured public authority establish the account. Owner hash binds `account-v1`, authority+user ID and the provider credential hash. Same account + same channel credential on different devices shares jobs; different accounts sharing that credential have distinct owner, list, idempotency and queue spaces. Changing a channel credential does not migrate old tasks automatically.

Configuration owned by delivery:

- `JOB_AUTH_SESSION_URL=http://127.0.0.1:3183/api/config-vault/session` (confirm actual vault port). Only literal loopback HTTP or fixed HTTPS, exact endpoint path, no userinfo/query/hash; redirects are never followed. HTTPS certificate verification remains enabled.
- `JOB_AUTH_COOKIE_NAME=__Secure-provider_tasks` is the default. Custom names require coordinated vault support; the main cookie name is explicitly rejected.
- Existing relay `--origin` must exactly match vault's public origin and remain stable across restarts/devices. Changing that identity authority requires an explicit migration; it does not silently remap old owners. No additional service bearer/header is required; the opaque task session is validated by vault. No auth cache is used.
- Missing verifier configuration with `AOWEISI_JOB_STORE` prevents startup. A factory-created jobs handler without a verifier returns 503; no session returns 401; wrong account/unknown job returns 404. Vault unavailable/invalid response fails closed.

**Important transport detail:** supported Node fetch versions may ignore a manually supplied Host. `vaultSessionRequest` uses bounded Node HTTP/HTTPS requests, preserving the public Host while connecting to the private vault listener. The real HTTPS browser test covers different public and internal ports. Timeout is 10 seconds and session response cap is 16 KiB.

Writes still enforce configured Origin and reject `Sec-Fetch-Site: cross-site` before acting. SameSite is defense in depth, not the sole CSRF control. The existing account/channel revision checks in the frontend remain necessary to discard responses from stale views.

Delivery files identified (owned by module08, not edited here): `deploy/nginx-managed-locations.inc`, `deploy/aoweisi-provider-relay.service`, `docs/gpt-image-jobs-deployment.md`. Audit every active Nginx include, not just one template. Keep request/credential logging disabled. Model upstream requests are built separately from route credential headers and receive no Cookie.

## Old tasks: quarantine, not self-claim

- Original Fal file: `AOWEISI_JOB_STORE`; original GPT file: `${AOWEISI_JOB_STORE}.gpt`. Preserve them and their protected backups/keys. Relay reads only their identity index with `readFile`; it does not load them into active JsonJobStore, clean them, submit waiting work or auto-resume them.
- New active files: `${AOWEISI_JOB_STORE}.account-v1` and `${AOWEISI_JOB_STORE}.gpt.account-v1`. New rows are marked `ownershipVersion: account-v1`. Production services reject a mixed/legacy active store before scheduling. Never copy old records into the new filenames to bypass quarantine.
- An attempted create matching a quarantined legacy provider-key/idempotency identity returns 409 `legacy_task_requires_review`, regardless of which current account presents the shared key. No automatic remapping based on current login, browser local intent metadata or possession of the shared key is allowed.
- Legacy known job IDs are not listed/read/canceled/retried through the account-owned API. Restored frontend handles with old IDs get 404 and must not create replacement paid jobs. Legacy anonymous ownership cannot reliably be reconstructed from a bearer hash alone.
- Before upgrade, stop the old writer and preserve a coherent snapshot. Do not run old and new relay writers concurrently. Index is loaded at startup; quarantined files must remain immutable. Malformed or unknown legacy identity schemas abort startup rather than silently authorizing replay.
- Manual migration is intentionally NOT implemented. An operator must establish ownership from trusted independent records, reconcile upstream acceptance, and get explicit authorization before any offline reassignment/re-encryption or new submission. Preserve uncertain/provider-backed jobs and dedup metadata. No production data was migrated in this task.

## Persistence and logs

Account identity hashes bind encrypted queue AAD; encrypted credential data contains the account principal and provider key only, never a vault cookie, JAPI access/refresh token or browser session. A user who cannot authenticate cannot list/read/cancel/recover another account's queued or restored tasks. Already accepted background jobs retain their original account binding and can continue after browser logout; logout revokes API access, not previously accepted paid work.

Logs do not include cookies, authorization values, body/prompt or plaintext account identifiers. Tests scan actual diagnostic and persisted files for test secrets and also decrypt waiting envelopes to assert that cookie values are absent even inside ciphertext. Provider transport tests verify actual local upstream HTTP receives no cookie. Full isolation still assumes trusted storage and a single relay writer; distributed scheduling/per-user capacity limits are not added.

## Reproduction and evidence

From `infinite-canvas/provider-relay`:

```powershell
node --test *.test.mjs
node session-cookie.browser.mjs
```

The first command includes 2 legacy reproduction cases and 9 account-isolation scenarios in addition to existing queue tests (69 total). The browser command requires installed `web` Playwright dependencies and Chromium. It uses actual local HTTPS, actual vault handler, simulated local JAPI/model upstream, and the committed localhost-only TEST certificate. It models a providers-only reverse proxy in Node, not an actual Nginx installation. No external provider or production call occurs.

Covered: two accounts sharing key; two sessions/devices for one account; guessed IDs, cancel/recovery and spoofed account headers; no/forged/duplicate cookies; active-user revocation; untrusted Origin/cross-site POST; encrypted queue restart; old-key quarantine; browser cookie paths; logout and account-switch replay rejection; actual GPT and mocked-socket Fal HTTP headers without cookies; diagnostic/persistent secret scan. The browser test originally exposed the Host transport incompatibility above and now passes with the corrected implementation.

The controlled-runtime `web/src/services/api/task-center.integration.test.ts` also uses the dedicated cookie verifier and real jobs HTTP routes. It retains the five-task/process-kill/zero-duplicate-submit scenarios; its identity endpoint is a local mock. The true vault/JAPI trust chain is exercised by `account-ownership.test.mjs` and `session-cookie.browser.mjs`.

## Legacy helper live-session contract

`gpt-jobs.ts` and `fal-jobs.ts` require a live `sessionGuard()` returning `{ accountId, channelId, revision }`. Capture is once per operation; revision must advance on every account/channel change, including A → B → A. Missing/invalid initial state fails with `session_guard_required`; subsequent changes fail with `session_changed`. Both errors set `preventResubmit=true` and `retryable=false`. Guard failures are never a reason to fall back to direct generation. Async polling callbacks are awaited and checked before and after; callers must also protect their own asynchronous writes.

Requests use `credentials: same-origin` only for same-origin jobs and reject redirects. Fal generic non-job requests omit cookies and strip caller-supplied cookie/identity headers. Foreign-origin Fal jobs fail before fetch. `X-Task-User` is an optional precondition checked **after** vault authentication: mismatch returns 409 `account_changed`; it never selects or establishes an owner. Thus Cookie B with stale UI A is rejected before create/cancel/retry even when both share the model key.

The browser regression bundles the actual TypeScript helpers with esbuild. Real HTTPS cases cover lost accepted response and pre-admission 429 followed by A → B or A → B → A (exactly one POST), poll sleep ABA, late poll responses without callbacks, stale UI versus switched cookies, and late Fal cancellation. The test proxy assigns synthetic documentation-range IPs to repeated logins so login throttling does not obscure session-race assertions. All upstreams are local fixtures; no deployment or real paid requests occur.
