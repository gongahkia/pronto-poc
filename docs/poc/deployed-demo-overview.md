# Deployed demo: overview, strengths and limits

Historical overview dated 28 October 2026. For the current Instagram pilot, see
[Instagram in the public demo](../channels/instagram-public-demo.md). Huddle was
detached on 19 November; its widget/routes are no longer available. Stored
feedback and accounts are retained; do not apply old account-cleanup advice
below to the hosted workspace. See [the removal record](../integrations/huddle-detachment.md).

Status as of 28 October 2026. The public proof of concept runs at
`https://pronto-ai-poc.onrender.com`. It uses synthetic data only (an unofficial
PS.Cafe Raffles City workspace); nothing it sends reaches a real customer.

## What it is

Pronto is a customer-service assistant for small food-and-beverage businesses.
The deployed demo lets a reviewer experience both sides of one conversation:

| Side | Where | What you do |
|---|---|---|
| Customer | `/demo/customer` | Chat as a customer. Replies come from a real model (Groq GPT-OSS 20B) using approved text from the business's knowledge. |
| Business | `/client` (Inbox, Business Knowledge, Insights) | See the conversation, take it over, reply as the business, release it back to the assistant, review and approve knowledge, read analytics. |

The assistant answers only from approved knowledge. When a safety check rejects
its answer (for example low overlap with the cited sources) it pauses the
conversation and hands it to the business instead of guessing.

## How it is deployed

| Part | Choice | Notes |
|---|---|---|
| Web app | Render Free web service, Docker, Singapore | `deploy/render-web.Dockerfile`, auto-deploy **off**. |
| Database | Neon Free Postgres (pgvector), Singapore | Runtime uses the **pooled** URL with `PRONTO_DB_POOL_MAX=2`; migrations and bootstrap use the **direct** URL. |
| Model | Groq Free, `openai/gpt-oss-20b` | Text retrieval from Postgres; no embedding service. |
| Processing | `PRONTO_DEMO_PROCESSING_MODE=request` | No background worker. The browser asks the server to process queued jobs (`/api/demo/process`). |
| Profile | `PRONTO_DEPLOYMENT_PROFILE=protected-demo` | Requires the settings in `deploy/protected-demo.env.example`, including a database marker (a Postgres comment on the database) the app verifies at runtime. |

Total cost is S$0; no payment method is attached to any of the three services.
Secrets live in a private local file and in Render's environment, never in Git.

## Access

Anyone with the URL can open `/enter`, type a name and start reviewing. Each
visitor becomes a guest user (`guest-<uuid>@guest.invalid`, no password, 7-day
session) holding all six staff capabilities. There is no switch for this; it
exists on any protected-demo deployment. Two named accounts (an operator and a
business owner) were also bootstrapped for sign-in at `/login`; their passwords
exist only in the private bootstrap file. See [reviewer access](../ops/guest-demo-access.md).

## The feedback overlay

Reviewers' comments live in Postgres, shared by everyone, and persist across
sessions. Details are in [prototype feedback](../ops/prototype-feedback.md).

- **Shared and fast:** comments from every page appear for other reviewers within
  a few seconds (polling every 4 s while open, 10 s closed, paused when the tab
  is hidden), with an unread badge.
- **Duplicate-proof saves:** each save carries a request ID, so a retry or double
  click cannot create a second comment.
- **Draft recovery:** an unsent comment is kept in the browser for 14 days and
  restored after a reload or failed save.
- **Pins that notice change:** a pin hangs off a stable identifier and reports
  whether its target is still in place, moved, changed, missing or hidden.
- **Complete export:** one JSON file with every thread and comment (or an explicit
  `complete: false` if the 2,000-thread safety cap is hit).

## Strengths

- Both sides of a conversation in one URL, with real model replies, a real inbox
  and real approval gates.
- Reviewers need nothing: no install, invite or password.
- Comments are durable and shared, stored in a database we own and can export
  completely.
- Conservative AI behaviour: unsupported or poorly grounded answers go to a human.
- Synthetic-only by construction: delivery flags, tenant-scoped SQL checks and a
  database identity check apply regardless of who is signed in.
- Reproducible: migrations 001-055, a bootstrap script, a Dockerfile and a tested
  suite (121 unit test files, 732 tests, plus Postgres integration tests).

## Limitations

**Hosting (free tiers)**
- Render Free sleeps when idle. The first request after a pause can take 30-60
  seconds, and the first request after a fresh deploy can return a 502. Refresh.
- A visible browser tab polls the server and keeps both Render and Neon awake.
  Neon Free has a monthly compute allowance, so long-open tabs use it up.
- Groq Free is shared by every visitor. Per the assessment doc the limits at the
  time were about 30 requests a minute and 1,000 a day; when exhausted, chat stops
  until it resets. Check the current figures before relying on them.
- Neon Free keeps only a short restore window. Export feedback regularly; there
  is no tested backup/restore drill.

**Access and security**
- It is a public, unauthenticated demo where every visitor can change shared demo
  data, approve knowledge and take over conversations. Reviewers should never
  enter real personal information.
- Guest creation is rate limited (8 per visitor, 60 total per 15 minutes) and
  capped at 500 guests. Clean up with
  `delete from users where email like '%@guest.invalid'`.
- `demo:protected preflight` checks that the only users are the allowlisted
  bootstrap accounts, so it fails once guests exist. Run it before sharing the URL
  or after deleting guests.

**Feedback overlay**
Huddle is detached. Existing data is retained, with a complete private export.

**Product**
- Single synthetic tenant. Chope live reads and booking writes are off; there are
  no external channels or SMTP credentials.
- Some natural questions (for example "what time do you open today?") are handed
  to the business because the grounding check is strict. Specific questions
  usually work.
- Reply processing is driven by an open browser. If a processing request dies, the
  job's lease takes about two minutes to expire before another request retries it.

## Operating it

| Task | How |
|---|---|
| Redeploy | Push to `main`, then Render → **Manual Deploy → Deploy latest commit**. |
| Apply migrations | `set -a; source <private env file>; set +a; pnpm migrate` using the **direct** Neon URL. |
| Historical feedback | Retained in PostgreSQL and the complete private detachment export; former routes are retired. |
| Take it offline | Suspend the Render service. |
| Reset the demo | New empty database, marker comment, migrations, then `pnpm demo:protected bootstrap <private json>`. Bootstrap refuses a non-empty database. |
| Rotate the database password | Reset it in Neon, then update `DATABASE_URL` in Render with the new **pooled** string. |

## Pitfalls we hit during the first deployment

- **Wrong Dockerfile.** The root `Dockerfile` runs the background worker. Render
  must use `./deploy/render-web.Dockerfile`; otherwise the service never opens a
  port and the deploy times out.
- **Prerendered 404.** `/enter` checked server settings before reading any request
  data, so Next baked a 404 into the build. It is now `force-dynamic`. Any page
  gated on runtime settings must render per request.
- **VPN.** A VPN made every Postgres connection to Neon reset. Disable it while
  running migrations and bootstrap.
- **Quoting.** Neon URLs contain `&`; quote values in the private env file before
  sourcing it in a shell.
- **Never echo secrets** while debugging connection strings.

## Why we did not rebuild this as a general tool

In October 2026 we surveyed existing tools (searched, not installed or tested;
some claims below are the vendors' own):

- Extensions that annotate any page and export for AI agents: Markagent, Leafy,
  Pincue, MarkUp, DOMPin, Tegakari, Annota, Caliper, Lens.
- A component with an MCP sync server: Agentation (source-available licence).
- Hosted "paste a URL and comment" services: MarkLayer, Simple Commenter,
  BugSmash, Pastel, BugHerd, Marker.io.

Most keep notes in the browser or on a vendor's servers; the shared ones are
hosted products with retention limits. Our setup differs mainly in durability and
ownership (a shared store we control, duplicate-proof saves, draft recovery, pin
health, complete export). That is a narrow gap, the existing tools cover the
broader need, and the overlay is tied to this app's authentication and tenant
model. Decision: keep the overlay as it is for this POC. If a general tool is ever
wanted, test two or three existing ones first against five checks: shared comments
between two people, survival of a failed save and a reload, pins surviving a page
change, a full export, and an authenticated page.
