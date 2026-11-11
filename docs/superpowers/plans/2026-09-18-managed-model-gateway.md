# Managed Model Gateway Implementation Plan

> **For agentic workers:** Implement disjoint backend, media, client adapter and access UI modules, then independently review security boundaries before deploying. No Git metadata: preserve source and deployment backups.

**Goal:** Other users enter an individual access code and use server-owned model credentials for image generation, vision and copy without ever receiving the provider key.

**Architecture:** Python 3 standard-library service listens only on 127.0.0.1:3180 behind existing HTTPS Nginx. SQLite persists access-code principals, hashed sessions and quotas; requests go only to the fixed configured BM upstream. A runtime-enabled frontend overlays a nonpersistent managed channel while preserving existing personal settings for local/nonmanaged deployments.

**Tech Stack:** Python 3, SQLite, systemd, Nginx, React/TypeScript/Zustand, Vitest, unittest.

## Shared contracts

- Prefix `/api/managed`; `POST /login` JSON `{code}` returns session status and sets `aoweisi_managed_session` Secure/HttpOnly/SameSite=Strict/Path=/api/managed/ cookie. Session TTL 12h; logout revokes the hashed token. `GET /session` reports auth, safe model metadata and quotas. `POST /logout` deletes session. Same-origin Origin checking on all mutations; no CORS enablement.
- Safe status shape: `{authenticated:boolean, enabled:true, principal?:{id,name}, models?:[{name,capability:"image"|"text"}], defaults?:{imageModel,textModel}, quota?:{day,images:{used,limit},text:{used,limit}}}`. Never return an API key, raw access code, upstream headers or secret config.
- Authenticated model routes: `GET /v1/models`, POST `/v1/images/generations`, `/v1/images/edits`, `/v1/responses`, `/v1/chat/completions`. Models are server-allowlisted (`gpt-image-2` image, `gpt-5.5` text initially). Deny unsupported methods, paths, queries, model changes, arbitrary target URLs and redirect forwarding.
- Limits: 20 requested images/day/code, 200 text/vision requests/day/code, one active image request/code, 4 active calls globally. Global daily ceilings 200 requested images and 2000 text calls. Count in Asia/Shanghai; reserve atomically before dispatch, keep reservation on ambiguous upstream failures. Defaults adjustable server-side, not client-controlled. Max request 128MB, image n 1–15; no server automatic paid retries.
- Server reads secret JSON from `/etc/aoweisi-model-gateway/config.json`; nonroot service user can read it, no other users. Database/media state lives outside public root at `/var/lib/aoweisi-model-gateway/`. Only redacted error/status logs.
- Access codes are randomly generated high-entropy values; store digests only. CLI creates, disables and adjusts quotas. Generate three initial named codes into a private delivery file, not code/docs/logs/public assets. Access codes authorize API usage; existing local task storage is not a multi-user account database.
- Media helper `MediaStore(state_dir)` exposes `register(url, owner_id)->str token` and `fetch(token, owner_id)->(bytes,mime)`; server rewrites only image API response URLs into `/api/managed/media/<token>`. Ownership and 24h expiry enforced. Fetch HTTPS public destinations only, reject credentials/private addresses and DNS rebinding by connecting validated IP with original TLS host; validate every redirect, bounded time/size/passive raster format. No arbitrary client-supplied URL proxy.

## Chunk 1: implementation and focused tests

- [x] Backend authentication/session/SQLite quota transaction and CLI tests; fixed-host proxy, JSON/multipart validation, text streaming and safe error mapping. Upstream 401 is a server-config error, not user login failure.
- [x] Secure image response relay with owner/expiry/IP/redirect/type/size tests. Never forward provider Authorization to image hosts.
- [x] Managed config/readiness/API adapters for image, vision, copy, canvas and commerce. No dummy provider keys, no persisted managed credential/channel, no custom scripts or personal proxy in managed requests. Preserve local mode untouched.
- [x] Access-code gate, session expiry/revoke handling, quota display and logout. Public config shows server-managed notice rather than API-key inputs. Frontend images queue per browser to respect one-image concurrency.

## Chunk 2: integration, safety and release

- [x] Independent review completed; fixed cross-tab billing race using expected-principal headers checked before quota reservation, and made expired-session logout idempotent. Added pre-body resource admission and Nginx rate/connection bounds.
- [x] Complete suites: 599 frontend tests, typecheck/build passed; 74 backend tests passed on Debian including POSIX permissions. Browser UI was checked with mocked responses; real provider model listing returned 200 without paid calls.
- [x] Nonroot service active; private config root/group 0640 and state directory 0700. Credential provisioned through hidden input. Three codes delivered to a local administrator-only file; no credentials in public runtime or builds.
- [x] Nginx/runtime/old release retained; backend and frontend deployed and runtime enabled after internal and HTTPS authentication checks; catalogs/private backups preserved.
- [x] Anonymous models denied; authenticated models, cookies, origin, logout/revocation and zero paid usage verified through real HTTPS. Documentation updated. Production UI automation could not connect; release artifacts and anonymous status were verified over HTTP.

## Non-goals

No full account/password-registration system, no billing purchases, no shared user task database, no automatic generation or migration of private user settings. Future login can reuse stable principal IDs rather than exposing provider credentials.
