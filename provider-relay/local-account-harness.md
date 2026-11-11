# Module03 trusted-cookie page harness (local only)

The shared client now uses `credentials: "same-origin"`. Rebuild/restart any stale Vite/preview process; do not use the legacy `gpt-jobs.ts` client as evidence of the shared client's behavior.

Start your normal local Vite/preview page first, then in a second PowerShell terminal:

```powershell
cd F:\AIVIBI\sanheai\infinite-canvas
$env:TASK_TEST_WEB_URL = 'http://127.0.0.1:3000' # use your actual local Vite port
$env:TASK_TEST_HTTPS_PORT = '3443'              # choose another free port if needed
$env:TASK_TEST_DELAY_MS = '800'                # optional mock image delay
node provider-relay/local-account-harness.mjs
```

Open the actual feature page through **`https://127.0.0.1:3443/<your-page-path>`**, not directly through Vite. The same HTTPS origin serves proxied page assets, actual vault and authenticated jobs. The localhost-only test certificate is intentionally untrusted: Playwright must use `ignoreHTTPSErrors:true` in an isolated context. Default public port is 3443; internal mock/vault ports are ephemeral and printed in the single readiness JSON line. No production port is used. Ctrl+C stops the harness; state is temporary.

Use separate browser contexts for these **synthetic credentials**:

- A: `alice@test.invalid`, password `local-test-only`, verified user ID `101`.
- B: `bob@test.invalid`, password `local-test-only`, verified user ID `202`.
- Use the same fake model channel key in both accounts, e.g. `LOCAL_SHARED_TEAM_KEY`. Config UI can retain the supported GPT jobs URL `https://llm.zhitouzhuan.com/v1` and `gpt-image-2` model; jobs actually go to the harness's local mock through the server, not that domain.

Log in through the app's normal login UI or from the **harness-origin** page:

```js
await fetch('/api/config-vault/login', {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'alice@test.invalid', password: 'local-test-only' })
});
// Reload the feature page so its account store reads the authenticated session.
```

Vault sets the real two-cookie contract: main cookie only on `/api/config-vault`, task cookie only on `/api/providers`; both HttpOnly/Secure/SameSite=Strict. Relay introspects the task cookie against the actual vault, which checks local mock JAPI. B must not list/read/cancel/recover A's jobs, even with the same provider key and a guessed job ID. Another A login in a third context should see A's jobs. Actual page store configuration/hydration is the owning module's responsibility.

`GET /__task_test/health` returns only non-sensitive submit counters and `upstreamCookies` (must remain zero). It does not expose jobs, cookies, keys or request bodies. Default generation/edit results are synthetic 1×1 PNGs. A prompt containing `[test:fail]` yields mock 400; `[test:uncertain]` drops the upstream connection. These flags exist only in this test harness.

Only jobs are enabled at `/api/providers`; raw provider/model-gateway fallbacks return 403 to prevent accidental real-provider use. The page should exercise the shared jobs client. Use fresh isolated browser storage and do not import real credentials. Page navigation/HMR is proxied to the specified loopback Vite host with cookies stripped. This harness is not a production server or a test of actual Sub2API images.

Self-contained security proof (no Vite page required):

```powershell
cd F:\AIVIBI\sanheai\infinite-canvas\provider-relay
node session-cookie.browser.mjs
node --test account-ownership.test.mjs
```

The harness itself was smoke-tested with real HTTPS Chromium: login 200, GPT create 202, detail 200/succeeded. Shared frontend integration tests additionally exercise task queue restarts and stable intents.
