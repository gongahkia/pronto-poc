# Local OpenAI evaluation review

Verified 8 November 2026 UTC. The restaurant calendar uses Asia/Singapore, which was 9 November during the final acceptance runs.

Pronto is a tenant-scoped business support inbox: it answers from approved knowledge and transfers unresolved enquiries or staff-only actions to a human owner. These runs used the synthetic, unofficial PS.Cafe Raffles City fixture, genuine OpenAI GPT-6 Luna inference with low reasoning, and local console delivery.

## Results

| Pack | Scenarios | Customer turns passed | Genuine model calls |
| --- | ---: | ---: | ---: |
| Main conversations | 61 | 65/65 | 77 |
| Additional review | 12 | 14/14 | 18 |
| Chope edge cases | 19 | 21/21 | 42 |
| Chope website | 3 | 3/3 | 6 |

Final acceptance: **95 scenarios, 103/103 customer turns, 143 model calls**. Captured application and prompt hashes agree across all four packs. The first three packs use controlled booking observations; the website pack uses two fresh public Chope reads and one cache hit. The assistant read all final transcripts in addition to running automated checks.

The real website checks observed tables for two adults on 10 November and four adults on 11 November 2026, at the requested times, through the existing scoped connector. Those observations are historical snapshots; availability can change. The listing is PS.Cafe **Raffles City**. A request for a different outlet, including Raffles Place, does not silently use that mapping.

A separate three-turn browser check verified login, local model selection, a grounded hours reply, a genuine Chope referral from the fresh website cache, console delivery, persisted business conversation, refund handoff and the paused assistant. Screenshots and its structured evidence are included in the report.

Additional verification: **906 database/unit/integration tests passed, 8 skipped; 30/30 canned eval cases passed; type checking, lint and `git diff --check` passed**. The regression suite ran against a separate disposable database with provider keys cleared and network inference blocked.

Conservative cumulative accounting across all rounds and the browser check: **US$0.4154 / US$5**. Three earlier interrupted or unknown requests retain their complete reservations. This is upper-biased accounting, not an invoice. The persistent ledger was preserved across interruptions and reruns. Manual chat after this check uses the configured key outside the evaluation runner's cap.

## Findings and changes

- Kept OpenAI Luna behind an explicit local-only opt-in. Hosted production and protected-demo paths reject that option; Groq remains the hosted default.
- Used the same approved PostgreSQL text retrieval for local Luna and Groq, with no embedding calls. Included source titles in retrieval to recover location questions; added informal and multilingual query normalization.
- Supplied the business clock, authoritative Singapore calendar, exact tool request and observation details. Validated relative dates across Singapore midnight and repaired mismatches before reads.
- Asked for missing booking details and AM/PM without guessing, retained corrections and follow-up context, and requested a future date/time for a past request.
- Required actual staff ownership for promised follow-up and declared unresolved facts. Kept staff ownership through subsequent customer messages.
- Preserved factual-value, citation, link, mutation and privacy checks. Accepted safe negated guarantees and observed negative availability without accepting an affirmative claim from a failed read.
- Added one bounded genuine-model repair when a handoff draft fails validation, with both calls metered. Provider/network errors are not retried by that repair path.
- Fixed the live reader to accept Chope calendar dates with or without leading zeroes, retaining exact outlet/date/adult/child scope and the prohibition on reservation writes.
- Added controlled tests for stale or mismatched observations, missing details, unsupported children/outlets, cache reuse and provider failures, plus a separate real website pack.

## Review and rerun

Open the [filterable transcript report](../../output/live-eval/review.html), [CSV export](../../output/live-eval/transcripts.csv), [summary and source hashes](../../output/live-eval/review-summary.json), or [browser evidence](../../output/live-eval/browser-smoke.json). Original per-run prompts, outputs and partial/failed reports remain under `output/live-eval/`; that directory is ignored by Git.

The [local evaluation runbook](local-live-evaluations.md) covers setup, commands, the cumulative budget, controlled versus website evidence, and the worker/database boundary. Stop the worker before running fixture evaluations. Clear controlled cache entries before manual live searches; the final website batch already did this. Forty unfinished historical eval jobs were retired and audited before starting the local worker; conversations and reports were kept.

The local customer page is http://localhost:3000/demo/customer. Sign in as `responder@ps-cafe-demo.test` with the synthetic fixture password `pronto-ps-demo`, open Model settings, choose **OpenAI Luna (local evaluation)** and start a new conversation. Review staff work at http://localhost:3000/client/inbox. Web, worker and the primary demo database were left running; the separate regression database was stopped.

## Practical limits and next iteration

These are representative synthetic conversations, not an exhaustive safety proof or a production success-rate estimate. The additional review set has now been inspected and is a regression set, not an unseen statistical holdout. Native-speaker review remains useful for translated replies. Booking wording can be shorter, and some optional handoff questions can be more direct.

Many handoffs are deliberate gaps in approved knowledge: prices, discounts, payment methods, delivery fees, accessibility and other policies should be supplied and approved rather than invented by the model. The withheld conflicting weekend reservation cutoff still requires business review.

No live Groq acceptance or deployment was performed. Test representative cases against the actual Groq model and credentials before publishing prompt changes. These local tests do not verify delivery through live WhatsApp, Telegram, Meta or email accounts. Chope listing preselection remains experimental; the customer checks the details and completes the booking there.
