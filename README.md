# Pronto AI

Local prerelease app for Pronto's customer-service pipeline, business inbox, knowledge base, channel handoff, and owner escalation flows.

## Prerequisites

- Node.js 20+
- pnpm
- Docker, if you want the bundled local Postgres/pgvector database

## Local Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm migrate
pnpm seed
pnpm dev
```

Open `http://127.0.0.1:3000`.

For the isolated PS.Cafe Raffles City MVP with Mailpit, a guarded worker,
sample customer emails and fake Meta providers, follow
[the local demo runbook](docs/demos/local-mvp.md). It uses a marked
`pronto_test` database and requires no real provider account.

The business workspace has three destinations: Inbox, Business Knowledge and Insights. Inbox includes attention filters and recent conversation updates. Business Knowledge contains full-width cards for knowledge sources, brand voice and handoff rules. Brand voice and Handoff rules open dedicated detail pages; use the back arrow to return. The Channels overview card is removed; its existing protected backend and detail route remain available. Open `/client/inbox` with an authorized business responder account. The authenticated customer simulator is `/demo/customer`; see [its setup guide](docs/demos/customer-simulator.md).

Brand voice keeps the tone and length presets and adds an editable custom brand prompt. Selecting a preset preserves custom text; **Use presets as prompt** explicitly replaces it. Saving preserves the exact custom text in the draft, within the displayed limit. Existing exact-revision business approval and operator publication gates still apply before customer replies change.

Insights at `/client/analytics` measures real conversation activity and automatically generates a genuine model synthesis on first visit or changed conversation data. Saved PostgreSQL snapshots avoid repeating inference for unchanged data. Topic clusters, customer sentiment, recommendations and knowledge opportunities link back to the sampled conversations. The analysis uses up to 40 recent conversations with bounded history; it does not invent satisfaction scores or billing rates.

Click the business name/logo to open **Workspace & usage**. It separates delivered Pronto replies from model calls and internal planning/intake/analytics, reports provider tokens separately from estimates, and exports CSV from the top right. Provider-reported reasoning tokens are a subset of output tokens, not an extra charge to add again; missing reasoning detail remains unknown. Billing rates are not configured.

In the enabled synthetic POC, **Feedback** on business pages and customer chat opens private page comments. Choose **Pin a comment**, click an interface element, and post a note; reviewers can reply, locate the element, resolve or reopen the thread. Comments, author and page anchors persist in PostgreSQL and are shared only within the authenticated demo workspace. This does not send a customer message. Pins use page/element anchors and can need relocation after a substantial layout change.

**Export workspace feedback** downloads versioned JSON for Codex review, including page/element context, authors, replies and status. Codex can also query the structured tables directly with authorized database access. See [feedback serialization and ingestion](docs/ops/prototype-feedback.md) for authentication, pagination and the schema.

For what is deployed, how to run it, and its strengths and limits, see the [deployed demo overview](docs/poc/deployed-demo-overview.md).

See [verification evidence and UI checks](docs/poc/insights-feedback-verification.md) for the model, persistence, permission and responsive checks behind these changes.

For local OpenAI Luna with low reasoning and a bounded live conversation
evaluation workflow, see [local live evaluations](docs/testing/local-live-evaluations.md).
This is separate from the stubbed `pnpm eval` regression suite and keeps Groq as
the hosted demo model. The [completed local evaluation review](docs/testing/local-live-evaluation-review.md)
records coverage, fixes, acceptance results and remaining limits.

Restaurant booking enquiries in the real-model path can check Chope and return a booking link with the requested date, time and party size. PostgreSQL stores availability observations and a shared cache; the worker refreshes recently requested combinations hourly and enquiries require observations no older than five minutes before claiming availability. See [Chope setup, scheduling and storage](docs/integrations/chope-live-read.md) for the required flags, tenant mapping, Chromium and worker setup.

The old HQ operator frontend has been removed under PRON-87. Operator sign-in opens `/account`; administration uses the existing protected APIs through the [authenticated CLI](docs/ops/operator-cli.md). Business approvals, versioned assistant drafts and channel activation gates remain independent. An operator login does not grant access to the business inbox.

PS.Cafe demo login, created by [the local demo setup](docs/demos/local-mvp.md):

- Email / username: `responder@ps-cafe-demo.test`
- Password: `pronto-ps-demo`

Sign in at `/login`. This account can use both the customer chat at `/demo/customer` and the business inbox at `/client/inbox`.

These published fixture credentials are **local only**. An internet-hosted POC uses separately bootstrapped synthetic accounts and private strong passwords.

Other seeded logins:

- Operator: `operator@pronto.sg` / `pronto-operator`
- Client: `owner@northbridgenasi.sg` / `pronto-client`

## Useful Commands

pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm outbox:retry

Use pnpm outbox:retry after testing failed WhatsApp/Telegram/Instagram/Email owner replies or stale `sending` rows.

## Environment Notes

The example environment uses real inference with `PRONTO_USE_MOCK_AI=0`. Customer conversations require an available configured model; unavailable choices remain visible and disabled. Groq uses approved local text retrieval with no embedding service. Optional OpenAI, Azure and Anthropic adapters remain available for separately configured deployments. Azure embeddings require `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` and `PRONTO_EMBEDDING_PROVIDER=azure`. Internal automated tests can explicitly enable mock AI; the customer API rejects mock conversations.

Live WhatsApp, Instagram, Messenger, Telegram, and Email testing requires real channel credentials plus a public HTTPS tunnel set as APP_BASE_URL. See docs/channels/webhook-setup.md and docs/setup/staging-env.md.

The intended independent S$0 POC is Render Free + Neon Free + the existing Groq Free account. Read [the feasibility evidence, queue changes and deployment acceptance plan](docs/poc/render-neon-free-assessment.md) before deployment. The web-only image and Free Blueprint enable protected-demo request-driven durable processing. Cloud restart/sleep acceptance and explicit deployment approval are still required. No cloud resource was created. The temporary [laptop tunnel](docs/demos/remote-poc.md) remains a separate running arrangement.

The [completed preparation checks](docs/poc/free-hosting-preparation.md) include patched dependencies, durable request processing, isolated PostgreSQL recovery tests and a real Groq workflow under 512 MiB / 0.1 CPU locally.

The deployment fixes in [the POC deployment notes](docs/poc/deployment-fixes.md) remove the generated-file Docker dependency, add a clean-checkout Render image CI job, and support reviewed knowledge publication without an embedding service. Apply migrations through **054** before bootstrapping or updating the hosted demo. Readiness checks the Groq configuration and approved published knowledge without making a provider call.

[Agent behavior and evaluation](docs/poc/agent-engineering.md) covers factual-value validation, bounded conversation retrieval, shared turn limits, operational retries and the 32-conversation `pnpm eval` suite using canned provider HTTP responses through the real execution path.

[Local OpenAI setup](docs/testing/local-live-evaluations.md) explains private key configuration and the hosted Groq default. The [200-scenario hardening guide](docs/testing/200-scenario-hardening.md) covers real Luna conversations, scoped Chope website checks, repeated trials, calibrated critiques and the cumulative US$5 evaluation budget.

Smart-triage JSON supports per-channel overrides under decision nodes, so clients can tune WhatsApp messages, Telegram bot messages, Instagram DMs, Messenger messages, and email differently.

## Local Release Checks

pnpm typecheck
pnpm lint
pnpm test
pnpm build

If a migration was added, run `pnpm migrate` before starting the app again.
