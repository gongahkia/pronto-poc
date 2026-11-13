<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Repository context and engineering guidance

The human quick start is in `README.md`. Detailed product and operational notes
below were moved from that README so they remain available to coding agents.

## Current handoff and working boundaries

- November 13 feedback changes routine automated handoffs to issue-scoped review:
  grounded follow-ups may continue until explicit staff claim/assignment/takeover.
  Critical safety/privacy, human requests and operational failures still pause.
  Migration 057 is required; pre-existing handoffs retain their previous pause.
  See `docs/ops/prototype-feedback.md` for the triage and demo quiet-window scope.
  Earlier 200-case evidence predates this policy and is not acceptance of it.

- Runtime: Node 24, pnpm 10.33.0, Next.js 16.4.1, PostgreSQL with pgvector.
- Local OpenAI evaluation: GPT-6 Luna, low reasoning, private `.env.local`.
  Hosted customer-demo model remains Groq `openai/gpt-oss-20b`.
- Read `docs/testing/evaluation-handoff.md` and
  `docs/testing/200-scenario-hardening.md` before further evaluation work.
  English, Chinese/Mandarin, Bahasa Melayu and Tamil are covered, unevenly.
- The original US$5 cumulative evaluation budget is shared across live batches,
  critics and `pnpm local:worker:bounded`. Preserve
  `output/live-eval/budget.json`; do not reset it under the same authorization.
  Final recorded conservative accounting was US$1.760242675.
- The full baseline passed 231 automated turn checks, but semantic review found
  a dietary source-grounding defect. The final prompt correction passed two
  focused cases only; no full 200-case rerun followed. Preserve that distinction.
  Genuine Groq acceptance and external-channel checks remain separate.
- Use a separate marked disposable regression database for `pnpm eval`: its
  PS.Cafe fixture setup removes existing conversations. Saved live evaluation
  conversations use port 55433; regression used port 55434. Never infer database
  disposability from the port alone or run reset/seed commands on hosted data.
- Stop the local worker during fixture batches. Local services were stopped at
  handoff; do not silently restart paid loops. Ordinary `local:worker` is not
  metered by the shared evaluation cap.
- The existing demo URL is https://pronto-ai-poc.onrender.com. It uses Render's
  web-only Dockerfile `deploy/render-web.Dockerfile`, Neon and protected-demo
  request processing. The user confirmed on 10 November 2026 that auto-deploy
  from `main` is enabled; the older docs/Blueprint example say off. A push
  triggers deployment, but verify completion and revision before claiming success.
  Do not provision new paid hosting to update this existing demo.
- The real demonstration outlet is PS.Cafe Raffles City, not Raffles Place.
  Chope is read-only: never claim to create/confirm/cancel a booking or process
  a payment/refund. Live reads require the documented approval flags, exact
  approved outlet mapping and Chromium. Local Chope success does not imply the
  hosted image contains a browser or has live reads enabled.
- `.env.local`, provider keys, bootstrap secrets and generated reports stay out
  of Git. Public local fixture passwords are intentionally documented separately.
  `output/` is ignored; evidence links there require the local handoff archive.

## Product behaviour and reference guides

Demo entry is `/enter` (name) → `/demo` (view chooser) → `/demo/customer` or
`/client/inbox`. Both screens link back via **Switch demo view**. The choice is
navigation within one reviewer session, not an authorization/role change.
Safe deep links continue to work; ordinary deployments do not enable the chooser.


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

The intended independent S$0 POC is Render Free + Neon Free + the existing Groq Free account. Read [the feasibility evidence, queue changes and deployment acceptance plan](docs/poc/render-neon-free-assessment.md) before deployment. The web-only image and Free Blueprint enable protected-demo request-driven durable processing. This preparation paragraph predates the existing Render deployment; current deployment behaviour must be verified against the running service. The temporary [laptop tunnel](docs/demos/remote-poc.md) remains a separate running arrangement.

The [completed preparation checks](docs/poc/free-hosting-preparation.md) include patched dependencies, durable request processing, isolated PostgreSQL recovery tests and a real Groq workflow under 512 MiB / 0.1 CPU locally.

The deployment fixes in [the POC deployment notes](docs/poc/deployment-fixes.md) remove the generated-file Docker dependency, add a clean-checkout Render image CI job, and support reviewed knowledge publication without an embedding service. Check `db/migrations` for the current migration inventory (through **056** at this handoff); apply required additive migrations through a verified direct database connection before a hosted update. Readiness checks the Groq configuration and approved published knowledge without making a provider call.

[Agent behavior and evaluation](docs/poc/agent-engineering.md) covers factual-value validation, bounded conversation retrieval, shared turn limits, operational retries and the 38-conversation `pnpm eval` suite using canned provider HTTP responses through the real execution path. The greeting → opening-hours case covers a harmless uncited greeting followed by a cited business answer. A rejected hours draft may get one same-provider rewrite against the same evidence, within the shared turn budget; the rewritten reply still passes all grounding checks. Customer chat polls automatically, shows reply dots only while awaiting an assistant reply, and displays Singapore timestamps. Staff ownership and resolved conversations still require an authorized release or a new conversation.

`/status` is a public readable service dashboard backed by no-store `/api/status`.
It shows safe service-level aggregates and saved inference outcomes, with no
messages, identities, keys or raw provider errors. It never makes an inference
request. `/api/health` is liveness only; `/api/readiness` remains the stricter
aggregate prerequisite/stopped-work check. Old stopped messages can keep the
queue degraded after a later reply succeeds; their owner must retry them from
the customer chat. A reported last successful AI reply is historical evidence,
not a fresh provider availability test. Render's safe commit SHA is shown when
available. Truncated/malformed provider replies use bounded durable retries;
wrong model identities, credentials and bad request configuration stay terminal.

[Local OpenAI setup](docs/testing/local-live-evaluations.md) explains private key configuration and the hosted Groq default. The [200-scenario hardening guide](docs/testing/200-scenario-hardening.md) covers real Luna conversations, scoped Chope website checks, repeated trials, calibrated critiques and the cumulative US$5 evaluation budget.

Smart-triage JSON supports per-channel overrides under decision nodes, so clients can tune WhatsApp messages, Telegram bot messages, Instagram DMs, Messenger messages, and email differently.

## Local Release Checks

pnpm typecheck
pnpm lint
pnpm test
pnpm build

If a migration was added, run `pnpm migrate` before starting the app again.
