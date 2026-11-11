# Team model configuration contract

This contract describes the gateway side of a team-owned model configuration. It does not contain credentials and does not change the existing personal-channel or BYOK relay routes.

## Recommended ownership

The managed model gateway is the shared-channel boundary. Its current private `Config.api_key` proves that the process can keep an upstream key out of browser state and public runtime files. Provider Relay remains caller-configured BYOK: its `Authorization` header belongs to the caller and must not be replaced with a team secret.

The next gateway schema needs a team identity and a membership relation in the existing SQLite state database:

```text
teams(id, name, enabled, config_version, created_at, updated_at)
team_members(team_id, principal_id, role, enabled, unique(team_id, principal_id))
team_channels(team_id, channel_id, provider, base_url, credential_ref, enabled)
team_models(team_id, model_id, capability, role, enabled, sort_order)
```

`credential_ref` is an opaque reference to a root-owned secret file or secret manager entry. The SQLite database, browser config, public runtime config and logs never contain the credential value.

## HTTP contract

All routes below require the existing Secure, HttpOnly managed session cookie. The gateway resolves the principal from the cookie and then the active team membership. A client supplied team ID is ignored unless it is one of the principal's memberships; otherwise return `403 team_access_denied`.

### Read effective team configuration

```http
GET /api/managed/team/config
```

Response:

```json
{
  "team": {"id":"team-1","name":"Design","configVersion":12},
  "channels": [{"id":"openai-main","provider":"openai","baseUrl":"/api/managed","enabled":true}],
  "models": [
    {"id":"gpt-image-2","capability":"image","roles":["product_image","white_background"]},
    {"id":"gpt-5.5","capability":"text_vision","roles":["copywriting","image_understanding","translation"]}
  ],
  "defaults": {"imageModel":"gpt-image-2","textModel":"gpt-5.5"}
}
```

The response contains model IDs, capabilities, role bindings and a same-origin base URL only. It never contains upstream credentials or arbitrary provider URLs.

### Model discovery

```http
GET /api/managed/team/models
```

This returns the same allowlisted model records as `team/config`. It is a read-only convenience endpoint; it must not proxy the provider's unrestricted model list.

### Model calls

Existing managed calls remain the execution endpoint:

```http
POST /api/managed/v1/images/generations
POST /api/managed/v1/images/edits
POST /api/managed/v1/responses
POST /api/managed/v1/chat/completions
```

The server selects the active team's channel and credential by the validated model ID and capability. It ignores browser `Authorization`, `base_url`, provider, and routing fields. A model not in the effective team allowlist returns `400 model_not_allowed`; a disabled channel returns `503 channel_unavailable`; an upstream credential failure returns `502 server_configuration` without exposing provider details.

`/api/managed/session` should add `team` and `configVersion` to its existing public status response so the client can refresh when the team configuration changes. The existing quota and `X-Managed-Principal` checks remain mandatory before paid calls.

## Administrative writes

Team configuration writes are admin-only and should be implemented by the management service, not by ordinary browser calls to the model gateway:

```text
PUT /admin/teams/{team_id}/config
```

The management service validates provider, fixed HTTPS/loopback policy, model allowlists, defaults and role bindings, writes the credential reference separately with `0600/0640` permissions, then atomically publishes a new `configVersion`. The gateway reloads the version after validation. It must reject an update that would leave a default model unbound or a referenced credential unavailable.

## Error and audit contract

Use stable non-secret codes:

| Code | HTTP | Meaning |
|---|---:|---|
| `authentication_required` | 401 | No valid managed session |
| `team_access_denied` | 403 | Principal is not an enabled team member |
| `model_not_allowed` | 400 | Model is absent/disabled for the team capability |
| `channel_unavailable` | 503 | Team channel is disabled or secret reference cannot be loaded |
| `quota_exceeded` | 429 | Principal/team/global quota exhausted |
| `upstream_timeout` | 504 | Upstream did not finish before the gateway deadline |
| `server_configuration` | 502 | Upstream rejected the server credential; do not expose its body |
| `upstream_error` | 502 | Safe generic upstream failure |

Audit records may include team ID, principal ID, channel ID, model ID, capability, config version, status, latency and request ID. They must exclude API keys, cookies, prompts, image bytes and upstream response bodies.

## Dependencies and rollout

- **config-vault (module 07):** the team-facing contract is `TeamSettings.modelConfig = { channels, defaults, roles }`. The vault stores the team draft and published snapshots inside encrypted team state; members have read-only access. Draft, publish and rollback use the existing revision compare-and-swap (CAS) protocol. The gateway consumes only the published snapshot and its revision, and should reject stale or incomplete revisions rather than writing back to the vault. `channels` and `defaults` become the gateway's allowlisted channel/model view; `roles` become the stable capability bindings consumed by commerce. Only non-secret metadata (team ID, revision, channel IDs, model IDs, capabilities and roles) may reach browser config. Team credentials remain server-side references and are never imported into personal vault exports or browser storage. Personal theme, language, prompt sources and UI preferences continue through the existing account sync flow.
- **commerce pipeline (module 03):** uses stable role names (`product_image`, `white_background`, `copywriting`, `image_understanding`, `translation`) and resolves them through the team model list. It should fail closed with `model_not_allowed` or `channel_unavailable`, rather than silently falling back to a personal channel.
- **Provider Relay:** remains BYOK and keeps its current caller-key behavior. A future team-specific relay must use the managed session and a separate server-side adapter; it must not pass a shared secret through the existing bearer header.

The current code does not yet implement team membership, channel tables, credential references or role-aware routing. The gateway integration must therefore be a read-only published-snapshot consumer; it must not implement a second draft/publish store. Until that integration is coordinated with modules 07 and 03, the safe deployable mode is the existing single-team `model-gateway/config.json` with its private `api_key`; no team secret should be placed in static assets or personal config-vault exports.

