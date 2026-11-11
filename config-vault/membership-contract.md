# Shared assets implementation plan

**Goal:** Authoritative local membership and shared asset access, without inferring membership from global rules administrators.
**Architecture:** Encrypted membership snapshot and exclusive filesystem lock. Shared asset operations hold membership lock through the complete asset transaction; revoke and access are linearized across processes. Per-scope asset snapshots keep personal/team/project quotas separate.
**Tech stack:** Node built-ins; existing authenticated JAPI sessions and encrypted atomic writer.

- [x] Add membership store: creator becomes first administrator, targeted expiring single-use invitations, member roles and project roles.
- [x] Integrate HTTP routes and scope authorization around existing asset transactions without changing legacy endpoints.
- [x] Test role matrices, revocation, invitation replay/expiry, quota isolation, restart, storage failure and independent child-process concurrency.
- [x] Review and document frontend contract and operational limits. No deployment or frontend changes.

## API contract: authoritative membership v1

Base: `/api/config-vault/memberships`. Existing vault login cookie and strict origin checks apply. Every non-GET request needs `X-Config-User` matching the active JAPI account ID. JSON fields not listed below are rejected. IDs are strings. This service uses JAPI only for active identity; it does not infer membership from email, request headers, or the global rules-admin file.

| Method / suffix | Input | Result / authority |
| --- | --- | --- |
| GET base URL | none | `{teams}`: only current memberships; effective role and accessible projects. Only team admins receive full member maps. |
| POST `/teams` | `{name}` | `{team}` with server UUID. **The authenticated creator becomes initial team admin**, atomically. |
| POST `/teams/:teamId/invitations` | `{targetId,role:"read"|"write",ttlSeconds?:3600}` | Team admin only. `{invitation:{id,token,expiresAt,targetId,role}}`; token returned once, only its SHA-256 persisted. TTL range 60–86400 seconds. |
| POST `/invitations/accept` | `{token}` | Current active account must equal invited targetId. Unexpired token consumed atomically with membership grant; replay fails. `{team}`. |
| DELETE `/teams/:teamId/invitations/:invitationId` | none | Admin cancels invitation. `{ok:true}`. |
| PUT `/teams/:teamId/members/:userId` | `{role:"read"|"write"|"admin"}` | Admin changes existing member. Cannot remove/demote last admin. |
| DELETE `/teams/:teamId/members/:userId` | none | Admin removes member and all their project grants. Rejoining never restores prior project access. |
| POST `/teams/:teamId/projects` | `{name}` | Admin creates server-assigned project belonging to this team. `{project}`. |
| PUT `/teams/:teamId/projects/:projectId/members/:userId` | `{role:"read"|"write"}` | Team admin grants existing team member project access. |
| DELETE `/teams/:teamId/projects/:projectId/members/:userId` | none | Team admin removes project grant. |
| GET `/teams/:teamId/audit` | none | Admin-only membership events for this team. Global retention is last 2000 membership mutations. |

An invitation cannot add an existing member or grant admin. Only an admin's explicit role update can promote an accepted member. Any team role change/removal invalidates pending invitations issued by or addressed to that account in that team. Acceptance also checks issuer still admin. Invitation delivery is out-of-band: this service sends no email/messages. Target IDs come from the recipient's authenticated account identity; no directory lookup or account enumeration endpoint is added.

## Shared asset contract

Keep `/api/config-vault/asset-library` endpoints from `asset-contract.md`. Personal URLs and records remain compatible.

For **every** shared request, including content, quota, audit, trash, restore and thumbnail:
- Team: `?scope=team&teamId=<UUID>`
- Project: `?scope=project&teamId=<UUID>&projectId=<UUID>`
- Add `&trash=true` for trash listing.
- Upload JSON keeps `{scope,name,mimeType,data,metadata?}`, with scope exactly matching query. Do not send teamId/projectId/ownerId in JSON. Query IDs only select a target; server records establish authority.

| Current server role | Team reads | Team mutations | Project reads | Project mutations |
| --- | --- | --- | --- | --- |
| Nonmember / revoked | deny | deny | deny | deny |
| Team read, no project grant | allow | deny | deny | deny |
| Team read + project read/write | allow | deny | allow | deny |
| Team write + project read | allow | allow | allow | deny |
| Team write + project write | allow | allow | allow | allow |
| Team admin | allow | allow | allow for all own-team projects | allow for all own-team projects |

A team writer without project grant cannot access project assets. Team admins manage all assets/projects in their own team; global rules admins have no automatic access. Project IDs belonging to another team fail even if the caller belongs to both. Personal assets remain owner-only, regardless of team role. Shared metadata `ownerId` identifies the uploader, **not exclusive ACL ownership**; `scope/teamId/projectId` identify the shared container. Writers can trash/restore any asset in the authorized container. All GET operations (including audit/quota/trash metadata) require read permission.

Each personal/team/project container has an independent 100 MiB default, 20 MiB file limit, and 1000 asset limit. Factory `assetQuotaBytes` overrides the per-container byte limit. SHA-256 dedup occurs only inside that container; shared uploaders receive the same stable ID for duplicate content. Trash stays charged; thumbnails must be inside the same container. No aggregate tenant/deployment quota or billing is claimed.

## Durability, revocation and fail-closed behavior

Membership record: encrypted `asset-memberships-v1.enc`. All registry operations use `asset-memberships-v1.lock`. Shared asset requests hold this lock while checking permission AND completing the asset transaction; revoke operations take the same lock. Lock order is session → membership → asset container, never reversed. Thus previously authorized requests may finish before revocation commits, but **after a revoke response succeeds all later accesses recheck and deny**, across independent processes sharing the store. Bytes already delivered cannot be recalled.

Personal asset paths are unchanged. Shared snapshots are `asset-library-team-<UUID>.enc` and `asset-library-project-<UUID>.enc`; IDs are server-generated and authorization-validated before constructing a path. Membership and asset files are separate atomic encrypted snapshots; there is no multi-file transaction requirement because each asset mutation holds membership lock without mutating membership. Invitation consumption + member addition + audit share one commit point.

Missing registry means no existing team/project authority, not fallback allow. An unreadable/corrupt registry returns 503. No in-memory ACL cache. Personal assets do not depend on membership storage. Failures before the atomic rename do not grant access or consume an invitation. The rename is the commit point: a directory-sync error after rename (or a lost HTTP response) can return failure even though the change committed. This is an indeterminate outcome, not a rollback guarantee. The client should reload GET /memberships to confirm actual state rather than assume the invitation is reusable. Permission-storage read failures still deny access. Underlying filesystem failures/lock timeouts fail closed.

Same single-machine filesystem assumptions and orphan-lock recovery rules as the asset contract. Stop/drain all writers before manual orphan lock removal; never delete locks from a live writer. No automatic crash lock stealing, HA/network-filesystem guarantee, or SIGTERM-draining implementation. The global membership lock serializes all shared requests, including downloads: a bounded first unit, not a high-throughput architecture.

Bounds: 1000 teams per registry, 20 teams created per account, 100 projects/team, 1000 members/team, 10000 outstanding invitations; expired invites pruned on new invite creation. No team/project deletion, rename, automatic invitation delivery, JAPI directory sync or organization-wide administrator is implemented. These omissions do not grant implicit authority.

## Verification and frontend handoff

Run `node --test infinite-canvas/config-vault/asset-service.test.mjs infinite-canvas/config-vault/membership-service.test.mjs infinite-canvas/config-vault/server.test.mjs infinite-canvas/config-vault/settings.test.mjs`.

Dedicated tests launch **two independent Node child processes**, sharing an encrypted temporary store and using fake JAPI only. Cover roles, cross-team/project selection, single-use targeted invitation races, expiry/revocation, quota/dedup races, restart, membership corruption and personal fallback. No real accounts/servers touched. Frontend integration is not implemented: modules 01/07 must add team creation, invitation acceptance/admin UI, scope selectors, and attach the scope query to EVERY asset endpoint. Existing legacy configuration attachments remain unchanged and outside new quotas.


Final validation: 22/22 Node tests passed (8 membership/shared tests, 5 personal asset tests, 9 existing vault/settings tests). Syntax checks passed. Independent read-only review found no permission/locking bypass; its commit-outcome documentation issue was corrected and a post-commit failure regression test added. No production or frontend access, deployment, or provider-relay changes.

No new external service, secret or environment variable is required. Membership uses the existing vault store directory and encryption key. The current CLI retains the 100 MiB/container default; custom per-container byte limits are available through the existing `createVaultHandler({assetQuotaBytes})` embedding option, not a new CLI flag. Backups must include membership and asset snapshots together with the separately protected existing vault key. These new records must be writable only by the vault service account.

Business metadata and actor-scoped old-local-ID migration extend these same ACLs; see [asset-metadata-contract.md](asset-metadata-contract.md). Shared writers may append validated provenance, readers may not. Migration bindings remain scoped to their creating actor as well as the selected container.

