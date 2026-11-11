# Scoped task session cookie / Relay identity contract

## Final decision

**The Path=/api design is withdrawn.** It cannot be justified without proving every generic proxy under `/api` strips credentials. This unit does not claim such a deployment-wide audit. A dedicated narrow-path cookie avoids sending either credential to `/api/model-gateway` and unrelated sibling API paths.

| Name | Path | Use |
| --- | --- | --- |
| `__Secure-config_vault` | `/api/config-vault` | Existing main vault browser session |
| `__Secure-provider_tasks` | `/api/providers` | Task Relay identity transport |

Both are host-only (no Domain), HttpOnly, Secure, SameSite=Strict, and carry the same random opaque session ID referencing the same encrypted server session. These are two routing scopes for the same credential, not cryptographically separate capabilities. The task cookie is still sensitive and must never reach model upstreams or logs.

Login/bootstrap issues both cookies after live JAPI identity validation. Successful authentication (including GET `/api/config-vault/session`) also issues both using the remaining server session lifetime, without extending server expiry. An existing legacy-only browser obtains the task cookie after its next successful vault request. Relay-only traffic cannot perform that browser migration if it discards internal Set-Cookie headers, as required.

Every issuance sends an additional deletion cookie for old `__Secure-config_vault; Path=/api; Max-Age=0`, cleaning up any residue of the withdrawn broad-path implementation. Normal main Path=/api/config-vault is retained, not deleted. A browser with conflicting same-name cookies at `/api` and `/api/config-vault` gets 401 and deletion headers for all three paths; re-login recovers without choosing an ambiguous account.

Logout revokes all syntactically valid session IDs presented in either recognized cookie name and clears main, task and old broad-path cookies. Account switch revokes presented old session IDs before issuing a new ID; both names referencing an old ID then fail verification. Ordinary authentication rejects multiple recognized identity cookie values (including same-value duplicates), never selects the first. If a browser sends no identity at logout, its cookies are cleared but the server cannot revoke an unknown session ID.

## Module04 identity verification

Relay configuration: **JOB_AUTH_COOKIE_NAME=__Secure-provider_tasks** (agreed default).

Relay parses and forwards only this cookie to fixed internal **GET `/api/config-vault/session`**. No name remapping is required: vault accepts `__Secure-provider_tasks` on this endpoint and resolves the same server session. Main cookie remains accepted for normal browser session checks. The task-cookie name is rejected for other authenticated vault APIs. Send only one recognized identity cookie.

Internal request requirements:
- Host matches the vault configured public origin host.
- Origin equals the configured public origin, supplied by trusted Relay configuration, not arbitrary caller input.
- Cookie contains only the recognized task-cookie pair; never log the value.

Vault keeps existing Host/Origin protections: exact origin for POST, and GET without Origin only when Sec-Fetch-Site=same-origin. No wildcard CORS or missing-Origin server bypass is introduced. **Relay must enforce origin/CSRF on its own public endpoints** before calling vault with trusted headers.

Every `/session` request checks JAPI `/auth/me`, refreshing/retrying only through existing session logic. The JSON response contains only `{user:{id,email}}`, with no-store. Relay must use **user.id** as task owner for list/read/cancel, never the shared provider bearer or frontend identity. Any 401/403/503/network error/malformed result must deny access; do not positive-cache identity past revocation. This vault unit does not implement Relay ownership checks.

Discard vault Set-Cookie on the internal identity response: do not forward it to model providers. Strip Cookie from ALL outbound model requests under `/api/providers` as that prefix legitimately receives the task credential. Also redact it from task state, logs, error bodies, URLs, assets and exports. Generic sibling `/api` paths receive neither cookie from a normal browser once stale broad-path cookies have been cleared. Cookie Path is browser routing, not a substitute for trusted same-origin application code or upstream header filtering.

## Local containment and validation

Vault adds no header logger, never forwards Cookie to JAPI, and returns no session token in JSON. Session filenames use SHA-256 of the opaque value; encrypted session records contain JAPI credentials, not the raw browser session ID. Asset metadata/audit are not populated from headers.

`node --test infinite-canvas/config-vault/session-cookie.browser.test.mjs`

Uses already installed `web/node_modules/playwright`, Chromium and a disposable self-signed local HTTPS certificate. OpenSSL executable: `VAULT_TEST_OPENSSL`, default Git OpenSSL path on Windows or `openssl` elsewhere. No trust-store changes, installation, real accounts or production access.

Real Chromium verifies: main remains on `/api/config-vault`; task cookie is `/api/providers`; only task cookie reaches provider probe; neither reaches model-gateway probe; legacy main-only browser acquires task cookie; broad-path duplicate residue is rejected/cleared; both credentials are HttpOnly/Secure/Strict; direct task-cookie `/session` revalidates JAPI each time; task-cookie non-session API rejected; switching/logout invalidate linked identity; cross-site cookie/CSRF requests fail; inactive account fails; cookie values absent from assets, audit, stored records and JAPI headers. Probes are boolean test fixtures, not real Relay endpoints. External proxy logs and production routing are not audited here.
