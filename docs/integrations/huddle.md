# Dogfooding Huddle in Pronto

Pronto consumes the private `@huddle/browser/react` package through a committed
[browser archive](../../vendor/README.md). A clean checkout does not need the
Huddle source tree to install or build Pronto. Run the Huddle service separately.

## Local setup

1. In the Huddle repository, run `pnpm install --frozen-lockfile` and `pnpm build`.
   For the first administrator only, run `pnpm bootstrap YOUR_EMAIL "Your name"`
   and enter your own password at its hidden prompt. An existing installation
   keeps its account and database; do not bootstrap or reset it again.
2. Start Huddle with `pnpm start`, then open **http://localhost:4310** and sign in.
   Use that exact origin consistently. Create a project called **Pronto** in
   **Project setup**. Allow the exact Pronto origin you open, normally
   `http://127.0.0.1:3000`, and add environment **development**. If you also use
   `http://localhost:3000`, explicitly allow that second origin. Copy the project
   ID shown in setup. Project IDs are public configuration, not access keys.
3. Add these settings to Pronto's private `.env.local`, replacing the ID:

   ```dotenv
   PRONTO_HUDDLE_ENABLED=1
   PRONTO_HUDDLE_SERVER_URL=http://localhost:4310
   PRONTO_HUDDLE_PROJECT_ID=YOUR_PROJECT_UUID
   PRONTO_HUDDLE_ENVIRONMENT=development
   PRONTO_HUDDLE_RELEASE=local-dogfood
   ```

   The existing authenticated synthetic demo must already be configured with
   `PRONTO_CUSTOMER_DEMO_ENABLED=1` and its verified database. Follow the
   [existing setup guide](../testing/local-live-evaluations.md) if necessary;
   preserve existing conversations. No additional Pronto migration is needed.
4. Restart Pronto with `pnpm dev`. Open the authenticated demo's business inbox
   or customer simulator. Click **Huddle feedback → Connect Huddle**, then approve
   the connection in Huddle's popup. Pin a comment or leave a page comment.
   Reviewers need their own Huddle membership or guest invitation; choosing a
   Pronto demo view does not create a Huddle identity.

Use **Earlier feedback** to access the original Pronto comments and their JSON
export, then close that panel and choose **Use Huddle** to return. Switching
providers destroys the inactive overlay and its connections. New Huddle comments
live in Huddle's database and export from its workspace. Existing Pronto threads
are neither moved nor duplicated automatically. Neither provider sends a
customer chat message.

## Integration behavior

- Disabled by default. Missing/invalid configuration uses the existing Pronto
  feedback. Set `PRONTO_HUDDLE_ENABLED=0` and restart to roll back.
- Huddle mounts only on the existing review surfaces after the synthetic actor
  check. Ordinary customer workspaces, sign-in and public status pages do not
  mount it. It does not receive Pronto cookies, passwords, roles or API tokens.
- The customer launcher stays in its header so it cannot cover the chat composer.
  Huddle's own floating launcher is disabled. Host route refresh pauses while
  the Huddle panel or pin picker is open, then resumes on close.
- Imports are SSR safe. The React helper mounts after hydration and cleans up
  during navigation/unmount. SDK mount errors fall back to Pronto feedback;
  connection errors appear inside Huddle and preserve its retry/draft behavior.
- The request proxy adds the validated Huddle origin to `connect-src` and uses
  `Cross-Origin-Opener-Policy: same-origin-allow-popups` when enabled, including
  entry pages because client navigation retains the document's opener policy.
  This is needed for Huddle's origin-checked PKCE popup; framing remains denied.
  The widget receives the request's style nonce.
  Its document nonce stays stable across server refreshes so closing the panel
  and resuming inbox polling does not disconnect the reviewer.
- URLs omit query strings and fragments. Huddle stores the selected element's
  anchor/label, comment, page path and optional release. Use the synthetic demo
  for this first integration; no session recording or click tracking is enabled.

## Shared staging reviews

For teammates on other machines, both services must be reachable by them.
`localhost` is each reviewer's own machine. Use an existing HTTPS Huddle service,
configure the exact Pronto HTTPS origin and matching environment in its project,
and set the corresponding Pronto settings on that deployment. Production refuses
HTTP Huddle URLs. Keep invitation secrets and bearer credentials out of Pronto's
public settings. This integration alone does not deploy or provision Huddle.

## Checks

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`.
The focused `huddle-*`, `prototype-feedback`, `proxy`, and
`auto-refresh-feedback` unit tests cover the actual packed helper, configuration,
authorization, headers, rollback and refresh behavior. See the verification note
below for the browser workflow exercised against disposable data.

### Repeating the browser checks

Use a **fresh disposable** marked `pronto_test` database, separate from preserved
evaluation conversations. Choose an unused port; preserve the existing databases
on 55433/55434. Export its matching `DATABASE_URL` and
`PRONTO_TEST_DATABASE_URL`, `PRONTO_CUSTOMER_DEMO_ENABLED=1`, and local fixture
`AUTH_SECRET`/`PRONTO_SECRETS_KEY` values using the
[marked test database contract](../testing/safe-regression-baseline.md#isolated-postgresql-tests).
Run `pnpm migrate:test`, `pnpm demo:ps-cafe:setup`, and
`pnpm demo:customer:setup` only against that fresh database. No worker or live
model is needed.

In Huddle, build once, then run its disposable service fixture. It creates a
temporary SQLite database and deletes it on Ctrl+C; it does not use `.data/`:

```sh
HUDDLE_TEST_PORT=4317 HUDDLE_TEST_REVIEW_ORIGINS=http://127.0.0.1:3000 \
  pnpm exec tsx scripts/test-server.ts
```

In Pronto, with the disposable database settings exported, start the app with
this fixture configuration (do not overwrite your normal `.env.local`):

```sh
PRONTO_HUDDLE_ENABLED=1 \
PRONTO_HUDDLE_SERVER_URL=http://127.0.0.1:4317 \
PRONTO_HUDDLE_PROJECT_ID=11111111-1111-4111-8111-111111111111 \
PRONTO_HUDDLE_ENVIRONMENT=development \
PRONTO_HUDDLE_RELEASE=pronto-dogfood-fixture \
APP_BASE_URL=http://127.0.0.1:3000 \
PRONTO_DEPLOYMENT_PROFILE= PRONTO_DEMO_PROCESSING_MODE= \
PRONTO_USE_MOCK_AI=1 PRONTO_TEST_ALLOW_BUILD_IPC=1 \
NODE_OPTIONS=--import=./tests/setup/network-guard.mjs pnpm dev
```

The network guard blocks external provider calls. Keep the deployment profile
local and request-driven processing disabled. In another terminal with the same
database settings, run:

```sh
pnpm exec playwright install chromium firefox
PRONTO_HUDDLE_E2E=1 HUDDLE_TEST_SERVER_URL=http://127.0.0.1:4317 \
  pnpm exec playwright test --config=playwright.huddle.config.ts
```

The suite uses only the documented fixture accounts and writes synthetic review
notes. It verifies two Huddle identities on the real Pronto UI, popup consent,
pin/reply/resolve/reopen, live updates, URL redaction and export, client navigation,
polling without reconnection, customer header placement, original feedback,
public-page cleanup and a failed connection. Stop both servers and your disposable
database afterwards. Browser reports and traces stay ignored under `output/`.

### Verification, 14 November 2026

- Pronto: typecheck, lint, 933 passing tests (135 opt-in tests skipped), and
  `pnpm build` passed on Node 24.21.0 / pnpm 10.33.0.
- Browser: all four checks passed in Chromium and Firefox, including two-reviewer
  collaboration, a real inbox refresh retaining authorization, mobile placement
  and a deliberately failed Huddle exchange. Safari/WebKit and a shared HTTPS
  deployment were not exercised in this integration pass.
- A fresh temporary directory containing exactly the Render builder's inputs
  completed `pnpm install --frozen-lockfile` and `next build --webpack` with the
  vendored archive. The final source also passed the ordinary production build.
  Docker itself was unavailable, so no container runtime result is asserted.
- Huddle's helper update passed typecheck, lint, build, 42 tests and its bundle
  check; the core ESM graph measured 11,865 bytes gzip. Its disposable service
  fixture powered the Pronto browser checks.

The browser run used a newly initialized, marked PostgreSQL cluster on port
55439 and Huddle's temporary SQLite fixture on port 4317. Both services and the
database were stopped afterwards, and the disposable database/build staging
directories were removed. Existing evaluation data, the evaluation budget ledger,
ordinary Huddle accounts/database and hosted services were not changed. No
worker or inference loop was started. Nothing was pushed or deployed.
