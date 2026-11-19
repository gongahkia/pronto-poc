# Instagram in the shared public demo

On 19 November 2026 the user authorized routing the Instagram pilot into
<https://pronto-ai-poc.onrender.com/client/inbox>, using the existing demo
knowledge and genuine Groq inference. Keith can send arbitrary enquiries to
exercise normal triage, staff review, takeover and release. The shared demo
admits link visitors; its Instagram test conversations are visible in that
workspace. Existing conversations, published sources, accounts and feedback
are retained. No fixture setup or reset runs against this database.

The optional bridge keeps the protected deployment profile and its database
identity checks. `PRONTO_DEMO_INSTAGRAM_ENABLED=1` requires the exact
`PRONTO_DEMO_INSTAGRAM_CHANNEL_ID`, receiving `ACCOUNT_ID` and messaging-scoped
`SENDER_IDS`. Only that encrypted Unified Login channel on the existing demo
tenant can receive and send external messages. The normal signature, business
account, approval, messaging-window, ownership and outbox checks remain. Other
external channels remain blocked. The default flag is off.

The Instagram worker profile uses the current published demo knowledge and
Groq `openai/gpt-oss-20b` with PostgreSQL text retrieval. It does not create a
synthetic customer session for an actual Instagram sender. Unsupported media
uses the normal handoff path; unsupported business requests and human requests
retain the existing triage rules. Booking/payment mutations remain unavailable.

Webhook ingestion commits before returning. Next.js `after` requests a bounded
slice from the existing request-driven queue coordinator. Ordinary authenticated
inbox processing also resumes Instagram work after a restart or interruption.
No persistent or laptop worker is needed. Concurrent/retried deliveries retain
the existing message/job/outbox identities and ownership checks. Automatic
interrupted-send recovery remains console-only; ambiguous Meta acceptance still
requires reconciliation. Readiness/status include the configured Instagram
channel without making a model call.

The old `pronto-instagram-test` service can retain Keith's saved callback using
the build-time `PRONTO_INSTAGRAM_RELAY_TARGET`. A validated Next.js `beforeFiles`
rewrite proxies only that callback path to the fixed `pronto-ai-poc` HTTPS
endpoint, preserving the original Meta body/signature and query. The old
service's worker stays off. All ingestion, inference, triage and conversation
storage occur in the public demo. The callback challenge response identifies
the destination with `X-Pronto-Instagram-Workspace: public-demo` for verification.

Both Free services can sleep. Coordinate tests after warming the callback and
demo; normal provider retries and inbox activity resume saved work. This setup
does not establish continuous delivery or production capacity. Meta's existing
Development/tester restrictions still apply.

The first native AI exchange exposed reversed Meta delivery: the hours question
arrived before an earlier greeting. Each inbound job and external reply ran once,
but the greeting saw the later enquiry and repeated its hours. Instagram context
now excludes customer turns (and their answers) with a later provider timestamp.
Standalone social turns use the business identity without retrieving unrelated
knowledge or invoking booking/integration tools. Ordinary enquiries and triage
keep their existing grounded path. Separate messages can still receive separate
appropriate replies; this does not batch messages or recall sends in flight.

The same exchange's logs show both Free services starting up before ingestion.
The 64–80 seconds before ingestion are separate from the sub-1.5-second model
turns. Webhook logs now record ingestion duration, duplicate count and oldest
provider-event age without customer text or credentials. The relay can start
with `node --max-old-space-size=64 scripts/hosted-instagram.ts` directly to avoid
downloading pnpm during a cold start. Free-service sleep remains a limitation.

Validate with `pnpm typecheck`, `pnpm lint`, `pnpm test`, the production build,
and disposable database cases `instagram-public-demo.test.ts`,
`demo-request-processing.test.ts` and `instagram-concurrency.test.ts`. Fake HTTP
regressions are separate from genuine Groq acceptance and the next native DM.
Private rollout/evidence files are in ignored `output/instagram-public/`.
