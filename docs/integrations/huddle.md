# Host-backed Huddle feedback

Huddle runs inside Pronto using the existing Pronto login, backend and PostgreSQL database. The private browser and host SDK archives are vendored with checksums and source revisions in [vendor/README.md](../../vendor/README.md). No separately deployed Huddle product service, project setup, Huddle account, popup approval or sibling checkout is needed.

Feedback requires an existing named Pronto user explicitly listed in `PRONTO_DEMO_ALLOWED_USER_IDS`, plus the verified synthetic demo workspace/database boundary. `guest.invalid` users are denied regardless of the guest-flow switch or chosen demo view. The central policy protects legacy reads/writes/exports and every new session/thread/reply/update/directory/transfer endpoint. Ordinary customers and operators outside the named-user list do not acquire feedback access. Public `/demo` navigation, guest sessions and customer simulation retain their existing policy.

Use Node **24.21.0** / pnpm **10.33.0**. The project `.npmrc` pins the script runtime; verify it with `pnpm exec node --version`. Install with `pnpm install --frozen-lockfile`. The existing Render and general Docker recipes use the same Node version and include the private archives. Pronto remains independently installable; its dedicated browser harness proves this in a fresh copy outside both checkouts.

The host switch is `PRONTO_HUDDLE_ENABLED=1`, together with the existing `PRONTO_CUSTOMER_DEMO_ENABLED=1`. Environment/release use `PRONTO_HUDDLE_ENVIRONMENT` (default development) and optional `PRONTO_HUDDLE_RELEASE`. Remove obsolete `PRONTO_HUDDLE_SERVER_URL` / `PRONTO_HUDDLE_PROJECT_ID` deployment settings during the gated release. They no longer enter client configuration or CSP. Disabling feedback hides its launcher and does not activate a legacy fallback.

Migration **058_host_backed_feedback.sql** adds a dedicated Huddle schema and `prototype_feedback_state`, retaining the original tables. It refuses to adopt an unidentified existing `huddle` schema. Browser mounting only opens installed storage; it never installs schema or migrates data. The initial mode is maintenance. The UI remains paused until explicit verified cutover, and no writer is admitted by default.

| Mode | Behavior |
| --- | --- |
| maintenance | Feedback writers paused; new overlay inactive |
| legacy | Only the centrally authorized legacy writer can write; new overlay inactive |
| active | New SDK reads/writes enabled; legacy writes denied |
| readonly | New reads/export available with a visible notice; all feedback writers denied |

Application transactions and database triggers use the same workspace advisory lock. The triggers cover SQL from older deployments that do not yet acquire the application lock. Only the affected demo feedback scope is guarded; unrelated business tables/workspaces are not part of that pause. The real disposable test queues an older writer behind the exclusive migration lock, changes mode and verifies rejection after the writer resumes. Mode changes during rollout must hold the exclusive lock. Do not manually set active based on fixture success.

The HTTP binding is `/api/demo/feedback/v2`. It uses Pronto's existing same-origin CSRF policy and derives authors from current database rows. A request captures its signed Pronto cookie once, then rechecks signature/expiry/session version and internal authorization on each operation/export recheck. Streaming does not call Next request-local `cookies()` after the handler returns. This retains revocation checks without a second authentication system or token persistence.

The customer header keeps its Feedback control. Inbox refresh waits while the overlay/pin picker is open; the document nonce and widget survive RSC refreshes. SDK startup failure leaves the business page usable and does not mount old feedback. The embedded panel reaches every thread/reply/history page and supports complete JSON/Markdown plus deliberate upload/preview/import/resume. Optional directory responses contain only approved member IDs/names. Historical imported attribution never grants access. Sensitive elements can be marked `data-feedback-private`; form/editable controls and feedback UI are excluded from capture. URL query/hash retention stays off.

Run local release checks:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm fixtures:huddle:postgres
pnpm test:huddle:db
pnpm test:huddle:migration
pnpm exec playwright install chromium firefox
pnpm test:huddle:browser
```

The native fixture preparation needs make, a C compiler, bison, flex, pkg-config and OpenSSL development headers. It builds pinned PostgreSQL 18.6, pgcrypto and pgvector 0.8.7 into ignored output with source checksums. The database/browser commands accept no existing database URL: they create a fresh marked cluster with an invocation nonce and clean up only their own resources. The database run applies/repeats migrations and seeds disposable data before the real DB suite. The browser run uses actual Pronto logins, a separate frozen archive consumer/production build and a Next development server, with external network calls blocked. It starts no Huddle product service, inference worker or paid loop. These browser fixtures do not establish hosted production acceptance or a genuine model-response test.

Keep migration in maintenance until original-data inventory, consistent private backup/restore, full source/destination parity and provenance are accepted. Pronto legacy feedback and any separate-service Huddle dataset are distinct sources. The [private migration runbook](huddle-migration.md) documents deliberate backup/recovery, gated installation, checkpoints, complete parity and readonly rollback/resume. See [implementation evidence](huddle-v2-progress.md) for exact results and pending steps.

After cutover, roll back through the same new store in readonly mode if necessary. Do not revert to an older store and hide comments created after cutover. Keep complete neutral JSON and original backups outside Git. Detaching the browser/backend imports/routes leaves database contents intact; deleting storage is a separate explicit host decision after verified export. Temporary migration and legacy components remain until actual migration dependencies permit retirement. Existing hosting is retained; no production migration, push or deployment is implied by local acceptance.
