# Local OpenAI conversations and live evaluations

Use OpenAI GPT-6 Luna with low reasoning locally, then validate the same
behaviour separately on Groq before deployment. Hosted deployments keep the
existing Groq model and never offer the local OpenAI option.

## Local configuration

Keep the key in the ignored `.env.local`, with private file permissions:

```dotenv
OPENAI_API_KEY=your-key
OPENAI_RESPONSE_MODEL=gpt-6-luna
OPENAI_REASONING_EFFORT=low
# Use the endpoint required by your OpenAI project's region, if applicable.
OPENAI_BASE_URL=https://us.api.openai.com/v1
PRONTO_USE_MOCK_AI=0
PRONTO_DEMO_LOCAL_OPENAI=1
PRONTO_CUSTOMER_DEMO_ENABLED=1
PRONTO_DEMO_ONLY_DELIVERY=1
PRONTO_DEMO_REAL_AI_APPROVED=1
PRONTO_AGENT_MAX_OUTPUT_TOKENS=2000
DATABASE_URL=postgres://pronto:pronto@127.0.0.1:55433/pronto_test
PRONTO_TEST_DATABASE_URL=postgres://pronto:pronto@127.0.0.1:55433/pronto_test
APP_BASE_URL=http://localhost:3000
```

Also set independent random `AUTH_SECRET` and `PRONTO_SECRETS_KEY` values.
Never copy `.env.local` to a hosted deployment. The local option is explicitly
`gpt-6-luna`; the ordinary `OPENAI_RESPONSE_MODEL` setting remains available for
other configured-provider uses. Both local Luna and deployed Groq use the same
approved PostgreSQL text retrieval, with no embedding calls or embedding fees.

Start a separate database, preserving the simulator's loopback identity check:

```sh
docker compose -f deploy/local-eval.compose.yml up -d --build --wait
# Mark only this newly created, disposable database. Never mark an existing
# database merely to get past a guard.
PRONTO_ALLOW_TEST_DB_MARK=1 node --env-file=.env.local --import tsx scripts/mark-test-db.ts
node --env-file=.env.local --import tsx scripts/verify-test-db.ts
node --env-file=.env.local --import tsx scripts/migrate.ts
node --env-file=.env.local --import tsx scripts/ps-cafe-demo.ts setup
node --env-file=.env.local --import tsx scripts/demo/customer-simulator.ts setup
```

Apply migrations through **056**. The local database image forwards its published
port to a loopback-only PostgreSQL listener inside Docker; it does not relax the
application's database identity or tenant checks.

Run `pnpm dev` and, in a second terminal, `pnpm local:worker`. Sign in using the
local PS.Cafe responder fixture, open `/demo/customer`, select **OpenAI Luna
(local evaluation)** under Model settings and start a new conversation. The
same persisted conversation appears in `/client/inbox`. The live evaluator
processes its own jobs, so stop the worker while evaluating to avoid competing
for jobs. Browser-created conversations and evaluation reports are retained.
Use `http://localhost:3000` consistently for the browser, so login redirects
and session cookies use the same hostname.

## What is evaluated

The expanded campaign now covers **200 scenarios / 231 customer turns**, plus
repeated trials and offline negative controls. See the
[200-scenario hardening guide](200-scenario-hardening.md) for criteria, coverage,
commands and the aggregate acceptance gate. The 95-scenario breakdown below
describes the earlier baseline and remains useful as historical context.

The corpus is `evals/live-customer-cases.ts`. It includes direct facts, hours,
last orders, location, menu, dietary uncertainty, missing policies/prices,
booking clarification/referral, changes/cancellation, children/large groups,
complaints/refunds, medical/legal/severe-allergy handoff, private information,
prompt/source injection, informal/multilingual messages, follow-ups, topic
changes, human ownership and controlled booking availability.

Four separately reported packs cover 95 scenarios / 103 customer turns:

| Pack | Scenarios | Turns | Availability evidence |
| --- | ---: | ---: | --- |
| Main | 61 | 65 | Controlled, where relevant |
| Additional review | 12 | 14 | Controlled, where relevant |
| Chope edge cases | 19 | 21 | Controlled connector observations |
| Chope website | 3 | 3 | Genuine reads from the approved listing |

The additional review set was kept separate during initial tuning. Once its
outputs have been inspected or fixes made against it, it is a regression set,
not an unseen statistical holdout.

The configured demo is **PS.Cafe Raffles City**, not Raffles Place. The Chope
edge cases explicitly test that confusion, along with requested/nearby/no
slots, day-wide searches, provider errors, stale or mismatched evidence,
weekday and relative dates, missing party size, AM/PM clarification and its
follow-up, children, prohibited booking writes, and cache reuse. Tests also
cover Singapore midnight and Chope's padded/unpadded calendar dates.

Automated checks judge:

- Correct outcome and human ownership; no AI reply to a human-owned backlog.
- Independently expected times/facts and required/forbidden answer content.
- Evidence citations and actual console delivery of the persisted reply.
- Acknowledgement for handoffs and clarification where details are missing.
- Requested language and absence of internal diagnostics or executable markup.
- Provider identity, usage, response IDs, latency and recorded execution traces.
- Exact outlet/date/time/adult/child link parameters, scoped read counts, cache
  reuse, and fresh live observations where required.

Read the transcripts as well: lexical checks cannot establish all semantic
correctness, politeness, useful follow-ups, language quality or injection
robustness. Cases are representative, not an exhaustive proof of safety.
Do not lower safety checks just to improve pass counts. Distinguish a test
expectation error from a retrieval, model, prompt, validation or delivery defect.

## Commands and reports

```sh
pnpm eval:live --dry-run
pnpm eval:live --only greeting,opening-hours,booking-referral --label smoke
pnpm eval:live --label baseline
pnpm eval:live --only closing-time,typos --label after-fix
pnpm eval:live --holdout --label independent-review
pnpm eval:live --chope --label chope-edge-cases

# Genuine public website reads: no booking, checkout or payment requests.
PRONTO_CHOPE_LIVE_READS=1 CHOPE_LIVE_READ_APPROVED=1 \
  PRONTO_CHOPE_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  pnpm eval:live --chope-live --label chope-website
```

`pnpm eval` remains the deterministic, stubbed regression suite. `eval:live`
uses genuine OpenAI inference through the existing inbox, agent and outbox in
the marked disposable database. Availability observations are controlled
fixtures in the main, additional-review and `--chope` packs. `--chope-live`
uses the real scoped browser reader and requires both live-read flags and an
installed Chromium executable. It retains the shared one-read-per-minute
limit, waits between different date/party groups, and checks cache reuse for
the same group. It clears the demo's controlled availability cache before the
website batch so synthetic observations cannot masquerade as website results.

The evaluator blocks non-OpenAI inference HTTP requests and never flushes
staff notifications, SMTP or external messaging adapters. The website pack's
separate browser permits only the approved public listing and one availability
read for the exact configured outlet/date/adult/child tuple. Reservation
create/read/update/cancel operations remain unavailable. A blocked, timed-out
or changed website is reported as inconclusive integration evidence, not a
passing availability check. Slot observations are transient, not promises of
inventory at a later time.

It may temporarily add explicitly tagged adversarial knowledge in the local
fixture and removes those sources after each case. Run it with exclusive use
of this synthetic database. A database advisory lock prevents overlapping
evaluation batches. Provider failures stop a batch; missing usage retains its
full cost reservation. Preserve partial and failed reports as well as passes.

Each run writes `output/live-eval/<timestamp>-<label>/report.html`, `report.json`
and `calls.json`. HTML contains the customer-facing transcripts; JSON retains
structured decisions, exact packed prompts, citations, snapshots, execution
traces and token usage. It excludes HTTP headers, keys and hidden reasoning
content. Source hashes identify the implementation used for each report.
The Inbox also retains conversations named `Eval · <label> · <case-id>`.

Handoff drafts pass the same factual and mutation checks before delivery. A
rejected draft gets one genuine model repair asking for a brief staff-review
acknowledgement, within the existing turn call/token/deadline limits. Both
calls are metered. A provider/network failure does not trigger that repair;
there is no fabricated model reply when validation still fails.

The persistent `output/live-eval/budget.json` enforces the approved **US$5 total
across rounds**. Every standard-tier Luna request reserves a conservative upper
bound before network access. Successful usage settles that reservation;
unknown usage or interrupted calls retain it. Cache discounts are ignored and
cache writes include the maximum 12-hour write multiplier and a 10% regional
processing allowance. Reasoning is counted within output, so the estimate errs
upward. Older ordinary-input estimates are increased conservatively while
retaining their history. The ledger
uses the [official Luna rates](https://developers.openai.com/api/docs/models/gpt-6-luna)
and [cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching)
verified on 8 November 2026. It caps this evaluation runner, not manual browser
chat, other applications or the OpenAI account. Do not delete/reset the ledger
while working under the same spending authorization.

Compare the baseline with focused reruns after a specific correction, then
repeat the full suite. Preserve a small set of cases for independent final
review. Re-run representative cases with genuine Groq output before publishing
prompt changes; good Luna results do not establish Groq model quality.

## Manual use after evaluations

For real availability checks in browser-created conversations, set the same
two Chope flags and Chromium path in the private `.env.local` used by both web
and worker. The demo tenant's `business_profile.chopeAvailability` must also be
enabled and match its approved outlet/link. See the
[Chope runtime setup](../integrations/chope-live-read.md#runtime-setup).
Clear controlled cache entries after fixture evaluations before resuming
manual live searches. Keep the append-only observations as historical evidence.

Before starting the worker after an interrupted batch, inspect unfinished
jobs tagged with `messages.metadata.raw.evalRunId`. Retire only those synthetic
evaluation jobs; otherwise they may be retried and cause extra inference.
Do not remove review conversations or change unrelated customer jobs. Manual
browser chat is outside the evaluator's transport cap, so stop the worker
when finished if you want to prevent further processing.
