# Evaluation handoff

Completed 10 November 2026 (Singapore time). Paid evaluation is stopped. Nothing
was deployed. Start with the [readable review](../../output/live-eval/hardening-review.html)
and the [campaign guide](200-scenario-hardening.md).

## Product and provider setup

Pronto is a restaurant customer-support inbox: approved knowledge retrieval,
bounded AI replies, durable jobs/outbox delivery and real staff ownership. The
demo restaurant is **PS.Cafe Raffles City**, not Raffles Place. Chope integration
reads availability and supplies scoped booking links; it cannot create, change,
cancel or confirm a reservation, charge a payment or issue a refund.

Local evaluation uses **OpenAI GPT-6 Luna, low reasoning**. Hosted deployments
retain the existing **Groq** default (`openai/gpt-oss-20b`). Genuine Groq output
has not been accepted by this campaign; canned SDK tests are not live Groq tests.

Put your own key in the ignored `.env.local`, never in chat or version control.
Follow [local setup](local-live-evaluations.md#local-configuration) for the full
environment, disposable database, migrations through 056 and fixture setup.
Use an endpoint appropriate to your OpenAI project's region. No private
environment file or API key is included in the handoff archive.

The existing local database is preserved on port **55433**, with its review
conversations and budget ledger. To resume on this machine:

```sh
docker compose -f deploy/local-eval.compose.yml up -d --build --wait
pnpm dev
# Separate terminal; starts paid requests only when messages are processed.
pnpm local:worker:bounded
```

Sign in at `http://localhost:3000` using the synthetic local responder
`responder@ps-cafe-demo.test` / `pronto-ps-demo`. Open `/demo/customer`, select
**OpenAI Luna (local evaluation)**, then inspect the same conversation in
`/client/inbox`. These credentials are local demo fixtures. Stop the worker
before any fixture evaluation batch. Do not rerun fixture setup on the
preserved database merely to start it: setup can remove review conversations.

The bounded worker shares `output/live-eval/budget.json` with live evaluations
and critics. The ordinary `local:worker` command does not enforce that shared
cap. **Do not reset the original ledger under the same spending authorization.**

## Results and limits

| Evidence | Result |
| --- | --- |
| Full baseline | 200 unique scenarios, 231/231 automated turn checks |
| Repeated fragile cases | 19 scenarios, three trials each, 72/72 turn checks |
| Genuine Chope website cases, included in the 200 | 3/3; two fresh reads and one intentional fresh-cache reuse |
| Persisted delivery audit | 294 replies matched to their own provider drafts; nine correct human-owned silences |
| Offline negative controls | All 2,289 corruptions detected; these are not model conversations |
| Reviewer calibration | 28/28 labelled examples; same Luna family, separate critic prompt |
| Free regression suite | 956 tests passed, eight optional skips; 33 canned conversation evaluations passed |
| Final language-focused unit checks | 13 passed; typecheck and lint also checked |
| Cumulative conservative API accounting | **US$1.760242675 / US$5** across earlier and current rounds |

The baseline's semantic review caught **one real issue**: a Chinese reply
inferred that a featured pasta was vegetarian from the restaurant's general
vegetarian-friendly listing. The prompt now separates restaurant-level labels
from dish-specific suitability. Two fresh focused English/Chinese cases passed
after that correction. The original baseline's failed release gate and flagged
reply remain visible. **The final prompt correction has focused validation,
not a fresh full 200-case run.** Subsequent language-grader changes were checked
offline without more paid inference. No further paid loop was started.

An additional critic flag about cached Chope evidence was adjudicated against
the exact recorded timestamp: the observation was 8.368 seconds old, within the
five-minute freshness limit, and reuse was explicitly required by that case.

Only approved hours/address and a menu/dietary overview are seeded. Unknown
prices and business policies require staff; inventing them would make the
resolution figures misleading. The corpus has been inspected during tuning
and is now a regression set, not an unseen statistical holdout.

## Four-language coverage

The reusable expectations and `pnpm eval:languages` support **English, Chinese
(Mandarin), Bahasa Melayu and Tamil**. The free audit of saved baseline replies,
with the two final focused replies substituted, found:

| Language | Checked reply turns | Current examples |
| --- | ---: | --- |
| English | 206/206 | Broad restaurant, booking, policy, privacy and adversarial coverage |
| Chinese / Mandarin | 10/10 | Hours, address, menu, refunds, cancellation, allergy and privacy |
| Bahasa Melayu | 3/3 | Hours, unknown price and refund |
| Tamil | 2/2 | Hours and refund |

One mixed-language input is tracked separately; nine human-owned turns correctly
remain silent. These counts are language checks, not independent semantic pass
rates. The audit detects obvious script/keyword mismatches, not native fluency.
The Malay refund reply includes “Our team.” Native-speaker review and broader
Malay/Tamil booking conversations remain useful before promising equal coverage
in all languages. No additional paid batch was needed for this audit.

## Tools and next deployment checks

`eval:live`, `eval:review` and `eval:calibrate` make paid requests. `eval:regrade`,
`eval:mutate`, `eval:languages` and `eval:scorecard` inspect saved files without
model calls; `eval:audit` additionally reads the local database. See the campaign
guide for arguments. Example free language audit:

```sh
pnpm eval:languages --reports output/live-eval/2026-11-09T16-57-46-077Z-final-200-v5/report.json,output/live-eval/2026-11-09T17-19-09-062Z-website-200-v5/report.json,output/live-eval/2026-11-09T17-25-16-238Z-final-dietary-clarification/report.json
```

Run `pnpm eval` against a **separate marked regression database**: it recreates
the PS.Cafe fixture and removes its conversations. This campaign used port
55434 for regressions and port 55433 for saved live conversations.

Before deployment, validate the current final prompt with genuine **Groq**
responses, then check the intended external channel's delivery and staff
takeover. Decide separately whether another full Luna run adds value; none is
running or scheduled. Local web/database services and paid workers are stopped
at handoff; their data and reports are retained. The safe archive contains
source plus selected evidence, not the local database volume or private keys.
