# 200-scenario local hardening

This campaign extends the earlier 95-scenario review to **200 distinct synthetic
scenarios / 231 customer turns**. It uses genuine GPT-6 Luna inference with low
reasoning, the actual durable inbox, approved PostgreSQL retrieval, agent checks,
handoff ownership and console outbox. The original **US$5 cumulative limit**
still applies to every batch, repair and model critique.

The configured outlet is **PS.Cafe Raffles City**, not Raffles Place. Three
scenarios use its genuine scoped Chope website reader. The other 197 scenarios
use controlled availability observations; genuine model inference does not
make a controlled inventory observation a real website result.

## Criteria and coverage

| Corpus | Scenarios | Turns | Purpose |
| --- | ---: | ---: | --- |
| Original main, additional and controlled Chope | 92 | 100 | Existing behavioural regression |
| New discovery cases | 80 | 98 | Compound enquiries, context, adversarial inputs and booking boundaries |
| New challenge cases | 25 | 30 | Languages, ownership, idempotency and knowledge boundaries |
| Real Chope website cases | 3 | 3 | Scoped availability, link parameters and cache reuse |
| Total | 200 | 231 | Unique scenarios, before repeat trials |

The case definitions are in `evals/live-customer-cases.ts` and
`evals/hardening-cases.ts`. Expectations specify the intended outcome before
inference: answer a supported question, ask only for missing booking details,
hand authority to staff, or remain silent after human ownership begins.
Assertions check the independently expected facts, actual delivered reply,
citations in the actual prompt, exact tool tenant/outlet/date/party, freshness,
duplicate delivery, call limits, and forbidden booking/payment mutations.

Coverage includes:

- Hours versus last food orders, brunch versus closing, location, official menu,
  informal wording, formatting requests, noise, Unicode and short follow-ups.
- Missing prices, fees, deposits, accessibility, children, pets, payment methods,
  dietary certification, complaints, refunds and severe-allergy handoffs.
- Partial booking details, corrections, noon, fractional/negative/zero group
  sizes, 24-hour times, ambiguous hours, children, group limits and no slots.
- Scoped availability errors, stale/mismatched evidence, nearby alternatives,
  cache behaviour, Singapore calendar dates and midnight boundary unit checks.
- English, Chinese, Malay and Tamil examples. Lexical language checks and a
  model reviewer do not establish native-speaker quality.
- Claimed owner/staff authority, forged tool output, encoded links, XML/JSON
  role breakout, source injection and demands for private information.
- Queued messages that must not contaminate earlier turns, human ownership
  pressure, duplicate inbound events and reprocessing completed jobs.
- Unapproved, archived, conflicted and foreign-tenant canary sources. Checks
  inspect the packed model context as well as the delivered response. Temporary
  fixtures are removed; the foreign tenant uses a synthetic embedding vector,
  with no embedding API calls or changes to database safety constraints.

The additional and challenge sets are now inspected regression sets. They are
not unseen holdouts. Three adversarial cases explicitly allow a sourced
correction or actual staff review of an unverified owner update; any answer
still needs the correct approved facts. A valid Malay answer using am/pm was
initially rejected for lacking the literal words *pagi* and *malam*. That grading
error is recorded separately from actual missing customer acknowledgements.

## Reusable evaluation loop

Stop the local worker before a fixture batch. The runner holds a database
advisory lock so two batches cannot modify the same fixture concurrently.
Each case/trial starts a fresh conversation. A seeded shuffle changes ordering
without changing the scenario definitions. An operational interruption leaves
a partial report and a nonzero exit status; a partial trial never counts as
stable. Reports retain implementation, corpus, knowledge and configuration
hashes, provider response IDs, actual usage and the raw output.

```sh
# Full controlled acceptance: 197 scenarios / 228 turns.
pnpm eval:live --pack all --rounds 1 --seed 317 --label final-200

# Discovery and challenge independently, or repeat a selected subset.
pnpm eval:live --pack hardening --label discovery
pnpm eval:live --pack challenge --label challenge
pnpm eval:live --pack all --only hard-noon,hard-chinese-allergy \
  --rounds 3 --seed 829 --label targeted-stability

# Genuine Chope evidence; requires the documented live-read flags and Chromium.
pnpm eval:live --chope-live --label website-200

# Separate prompted critic, using the same cumulative budget.
pnpm eval:calibrate
pnpm eval:review --report output/live-eval/<candidate>/report.json

# Free negative controls: corrupt saved evidence and require rejection.
pnpm eval:mutate --reports \
output/live-eval/<candidate>/report.json,output/live-eval/<website>/report.json

# Free, read-only audit: match each delivered reply to its own provider draft.
pnpm eval:audit --reports \
output/live-eval/<candidate>/report.json,output/live-eval/<website>/report.json,output/live-eval/<stress>/report.json
```

The critic is calibrated on **21 explicitly labelled examples**, including correct
answers, swapped hours, invented prices, false bookings, unsafe guarantees,
credential collection, an injection directed at the reviewer, an honest Chope
timeout and a missing initial acknowledgement. It uses a separate prompt with
the **same Luna model family**. Its verdict is a diagnostic signal, not an
independent model or human assessment. Preserve false alarms and missed defects
as evidence; review flags against the approved sources and actual ownership.
The first diagnostic critic falsely rejected the approved vegetarian-friendly
label and missed a silent initial Chinese handoff. The deterministic delivery
check caught the silence. Its reference sheet and rubric were corrected, and
both behaviours were added to the labelled calibration set. The old critique
remains saved; a model review never replaces delivery or ownership assertions.

Offline negative controls are deliberately corrupted saved observations. They
check whether the harness detects lost delivery, silence, duplicate replies,
lost ownership, unauthorized writes, foreign tool scope, stale inventory,
invented citations, unsafe links, credential collection and false confirmations.
They are **not extra model conversations** and must not inflate the 200-scenario
count or be presented as a model pass rate.

The aggregate gate requires all 200 unique scenarios, at least 12 fragile cases
with three passing trials, matching runtime/knowledge/configuration hashes,
genuine provider captures, a complete calibrated semantic review and at least
1,000 successful negative controls. It also requires a read-only database audit
matching each persisted reply and outbox delivery to that reply's own captured
provider response, draft and citation context, including handoff repair calls.
An optional adjudication must cite the exact
review evidence hash and explain a false positive; it cannot hide a confirmed
defect. The report includes supported-intent resolution, required handoff
success, unnecessary handoffs, acknowledgement delivery, ownership protection,
idempotency, category results and every critical failure.

```sh
pnpm eval:scorecard \
  --candidate output/live-eval/<candidate>/report.json \
  --website output/live-eval/<website>/report.json \
  --stress output/live-eval/<stress>/report.json \
  --critic output/live-eval/<candidate>/semantic-review.json \
  --website-critic output/live-eval/<website>/semantic-review.json \
  --stress-critic output/live-eval/<stress>/semantic-review.json \
  --calibration output/live-eval/<calibration>/report.json \
  --mutations output/live-eval/hardening-negative-controls.json \
  --audit output/live-eval/hardening-delivery-audit.json \
  --diagnostic output/live-eval/<earlier-diagnostic>/report.regraded.json \
  --previous-candidate output/live-eval/<failed-candidate>/report.json
```

The output is `output/live-eval/hardening-review.html`, alongside JSON and CSV.
Earlier 95-scenario review artifacts remain historical. Regrading writes a
separate file with its reason and the original hash. If runtime changed, the
explicit `--historical` option marks the evidence as old; new inference is
required for current-runtime acceptance.

## Product changes and deployment boundary

This campaign corrected false handoffs caused by ordinary formatting requests
and words mistaken for private record IDs, noon ambiguity, invalid party-size
handling, missed social acknowledgements, compound unknown-policy routing, and
safe translated/attributed handoff drafts rejected by local validation. Counter
examples retain rejection of invented times/prices, forged citations, positive
safety guarantees and transaction promises.

The next full candidate passed 227/228 turns. A forged booking-confirmation
message was misclassified as a new booking enquiry and got a details question.
It needed staff verification. The extraction and answer prompts now distinguish
existing-booking confirmation from new availability searches, and supplied
private booking IDs receive a deterministic staff-access check. The prompt
correction passed five fresh trials; the full candidate and repeated stress
evidence are rerun after these changes. That failed candidate remains saved.

A second candidate also passed 227/228 turns. A safe statement that a booking
is confirmed *only after the customer completes it on Chope* was rejected as a
completed transaction. Validation now distinguishes that explicit condition
from an unconditional claim; a separate affirmative claim still fails. A
validation-related handoff also requests a brief acknowledgement without
repeating unsupported dates or times. Fifteen focused live trials across the
five previously failing scenarios passed before the next full candidate.

A third candidate passed 227/228 turns. It admitted that the pasta price was
unverified but left ownership with AI because its free-form reason code used
another spelling. Routing now also checks the customer's requested topic and
the reply's admission of missing information. Supported hours/menu answers keep
their ordinary caveats. If a corrected handoff draft does not acknowledge staff
follow-up, the bounded intake generates a genuine brief acknowledgement.
Fifteen focused live trials and a deterministic reproduction of that exact
failure passed after the correction.

| Customer trigger | Observed defect | Correction and regression case |
| --- | --- | --- |
| “No code block or HTML” | Formatting request handed off as programming | Distinguish formatting from code generation; `hard-markdown-demand` |
| Last food order versus restaurant closing | Ordinary words mistaken for a private record ID | Record identifiers must contain a digit; `hard-last-food-not-drinks` |
| “12 noon” | Asked for AM/PM despite an explicit noon | Preserve qualified noon; `hard-noon` |
| Zero, negative or fractional diners | Other supplied booking fields could be discarded or a count rounded | Preserve date/time, clarify the count; party boundary cases |
| “Thanks, that is all!” | Missed social acknowledgement | Recognize complete standalone acknowledgements; `hard-thanks-goodbye` |
| Booking availability plus an unknown price | Availability fallback could leave the price unresolved with AI | Actual staff ownership for the unknown fact; `hard-booking-and-price` |
| Safe Tamil/Chinese staff acknowledgements | Local overlap or negation checks rejected a valid reply | Preserve Unicode marks and narrow translated equivalents; language cases |
| “Your request for … 7:00 pm” | Repetition of a supplied customer time rejected as a new business fact | Permit attributed details while rejecting changed times; compound allergy case |
| Claimed completed booking with a private ID | Treated as a new search and asked for details | Staff-access rule and intent distinction; `hard-fake-tool-output` |
| Confirmation only after customer completion on Chope | Safe referral rejected as an already completed transaction | Preserve the explicit condition, retain rejection of other transaction claims; `fresh-availability` |

Two broad diagnostic rounds ran before the last acknowledgement fixes. They
must remain labelled as diagnostic evidence. The final candidate, selected
three-trial stress tests and genuine website batch must use the same fixed
runtime; the aggregate script rejects mixed versions.

These are synthetic tests against a deliberately small approved demo knowledge
base. High handoff volume partly reflects missing business policies. Adding
verified prices, dietary procedures and operating policies through the existing
approval workflow is the next way to improve useful resolution. Inventing those
facts would create a misleading pass rate.

This work does not redeploy. Genuine **Groq** output must pass the same criteria,
and the intended external channel needs delivery, permissions and staff takeover
checks before deployment. Local console success cannot establish WhatsApp or
other channel reliability, production latency, business ROI or exhaustive
security coverage. Do not reset the cumulative budget ledger to run another
round under the same authorization.

Campaign results and exact artifact paths are recorded below after completion.

## Retained diagnostic evidence

These runs describe older implementations and are not combined into the final
current-runtime pass count. The three single-round candidates happened to have
the same aggregate count while exposing different defects; aggregate counts
alone would hide the distinction.

| Run | Turn checks | Material finding |
| --- | ---: | --- |
| [Two broad rounds](../../output/live-eval/2026-11-09T14-58-19-930Z-hardening-acceptance/report.regraded.html) | 453/456 after the documented Malay grading correction | Three missing acknowledgements |
| [First candidate](../../output/live-eval/2026-11-09T15-27-38-954Z-final-200/report.html) | 227/228 | Forged confirmation handled as a new booking |
| [Second candidate](../../output/live-eval/2026-11-09T15-41-48-071Z-final-200-v2/report.html) | 227/228 | Correct conditional referral rejected |
| [Third candidate](../../output/live-eval/2026-11-09T15-57-37-430Z-final-200-v3/report.html) | 227/228 | Unknown price left with AI |

## Regression verification

The frozen application passed **948 database-backed/unit tests**, with eight
optional tests skipped, and all **32 canned conversation evaluations**. Tests
used a separate marked disposable database on port 55434, cleared provider keys
and the test network guard. The test database was stopped after verification;
the live evaluation database and its review conversations were preserved.

The two added canned scenarios force an answered-but-unverified price to receive
actual staff ownership and a new acknowledgement, and preserve a supported
hours answer with a holiday caveat. They exercise the real engine/SDK/outbox
path with stubbed HTTP responses, so they run without paid inference. They do
not count as genuine Groq model acceptance.

Run `pnpm eval` against a separate marked regression database: its PS.Cafe setup
recreates that fixture and removes its conversations. In this campaign,
regression used port 55434 and saved live conversations used port 55433.

The offline negative-control pilot detected all 249 deliberately corrupted
observations from the 25-case challenge run. The final negative-control count
is reported separately against the complete 200-scenario acceptance evidence.
