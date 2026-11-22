# Outcome pricing and metering: deferred planning

Recorded 22 November 2026 from the pricing mock-up and subsequent discussion.
**Status: deferred; documentation only.** The user requested a record for later,
without implementing pricing or outcome counting now. This document does not
authorise billing, payment collection, quota enforcement, migrations or rollout.

## Proposed pricing and stated outcome definition

| Plan | Advertised monthly price | Included outcomes | Included features |
| --- | --- | --- | --- |
| Piccolo | $49/month | 50 | RAG knowledge base; brand voice configuration |
| Medio | $300/month | 400 | RAG knowledge base; brand voice configuration |

The mock-up does not specify the currency. The allowance reset period and
subscription-cycle details still need an explicit decision; do not infer them
solely from the monthly price labels.

The mock-up describes one outcome as Pronto fully handling a customer's request
without handing it over to the client/business staff. It gives two qualifying
cases: a confirmed booking, or a question answered with no customer follow-up
within 48 hours. These are proposed commercial criteria, not implemented rules.
Whether the 48-hour condition also applies to bookings remains undecided.

## Current backend and the gap

The existing [usage service](../../src/lib/analytics/usage.ts) tracks real model
calls, provider/estimated tokens, internal work and agent replies linked to
outbox records marked `sent`. It does not implement billable outcomes, a
48-hour qualification window or the 50/400 allowances. A `sent` transport record
is not by itself proof that a customer read or was satisfied with a reply.

Businesses have a `plan_tier` label in
[the initial schema](../../db/migrations/001_initial.sql). That label does not
configure the proposed prices, subscription periods, entitlements or automatic
payment collection. The estimates in [costing.ts](../../src/lib/costing.ts) are
separate from a commercial invoice or a provider-specific billing rate card.

Conversation state, messages, escalations, owner replies and outbound records
provide reusable evidence. However, `answered`, `resolved` and `closed` are
operational states, not acceptance of the commercial definition. In particular,
an Instagram thread can contain several unrelated requests over time. Neither
one thread nor one model call nor one assistant message automatically equals
one outcome.

RAG knowledge and brand voice already exist. Most additional work concerns
request boundaries, outcome evidence, delayed qualification and accounting.

### Confirmed bookings need separate evidence

The current [Chope adapter](../../src/lib/reservations/chope.ts) does not support
creating or reading a confirmed reservation. The separately approved demo
availability path can check availability and provide booking links; that does
not establish a completed booking.

Booking outcomes would require an authorised integration supplying verifiable
confirmation, such as a provider event or confirmed reservation read linked to
the relevant request. Neither a generated claim, an availability result, a
booking-link send/click nor an unverified customer message is sufficient.
Counting confirmations does not itself authorise booking writes or expansion
of the current connector scope.

## Proposed backend work

The following are design proposals, not selected schemas or active work items.

| Area | Proposed responsibility |
| --- | --- |
| Plan catalogue and subscriptions | Persist plan/version, amount, explicit currency, included allowance, business assignment, cycle boundaries and effective dates. Define changes, cancellation and any trial separately. Store monetary amounts using an exact currency-aware representation. |
| Request boundaries | Represent a customer request or service episode within a messaging thread. Link its messages, AI answers, related follow-ups and staff events without collapsing the lifetime of a thread into one billable unit. The segmentation method remains to be agreed. |
| Outcome ledger | Persist qualification state, evidence and reasons per request. A possible lifecycle is pending → counted or excluded, with separately recorded later adjustments. Retain the counting-policy version, business, relevant message/delivery IDs, staff involvement, eligibility timestamp and assigned billing period. |
| Event integration | Feed inbound messages, successful/failed/uncertain sends, escalations, staff takeover and native owner replies into the meter. Keep these observations separate from an outcome decision. Use verified booking events only if that integration is later available. |
| Delayed evaluation | Persist due work and evaluate the 48-hour condition after its deadline. Recover after restarts, process due records once and reconcile late/out-of-order provider events. Do not rely on a browser remaining open. |
| Allowance accounting | Maintain per-business, per-period counted/pending totals with atomic updates. Prevent duplicate webhook deliveries, retries or concurrent workers from consuming allowance more than once. Define reservations, overages and plan changes before enforcing limits. |
| Usage UI and export | Show pending, counted, excluded and adjusted outcomes, the allowance/cycle and understandable reasons linked to the relevant request. Retain the separate model/token/internal-work view. |
| Invoice/payment integration | If automated collection is wanted later, add the chosen provider, verified event reconciliation and invoice/payment state. Manual invoicing can precede payment automation. Neither requires treating model calls as outcomes. |
| Review and correction | Provide authorised, audited review of disputed counts. Preserve original evidence and adjustment history instead of silently deleting or rewriting previously billed records. |

Relevant existing integration points include
[conversation actions](../../src/lib/conversation-actions.ts),
[agent execution](../../src/lib/agent/engine.ts),
[inbound processing](../../src/lib/channels/inbox-worker.ts),
[outbox delivery](../../src/lib/channels/outbox.ts),
[native owner replies](../../src/lib/self-serve/owner-replies.ts),
[usage API](../../src/app/api/client/usage/route.ts) and
[workspace settings](../../src/app/client/settings/page.tsx).

The current free demo uses request-driven processing and can sleep. Reliable
deadline evaluation requires a deliberately chosen scheduling/recovery mechanism;
an exact 48-hour threshold must not be confused with a promise that a sleeping
host executes a job at that exact instant. Cutoff time, actual evaluation time
and treatment of late evidence need explicit semantics.

## Outcome-counting decisions still required

None of the options below is selected merely by listing it here.

| Decision | What must be agreed |
| --- | --- |
| Billable unit | One request, issue, session or thread? How are multiple questions and separate later requests grouped? Can a request count only once across many AI replies? |
| “Fully handled” evidence | Which facts establish an eligible answer? How are unanswered parts, unverified facts and failed grounding treated? Silence is an observation, not proof of satisfaction. A model declaring success must not be the sole billing authority. |
| Start of the 48-hour clock | First answer, final substantive answer or a transport event? Decide what evidence of a successful send/delivery is required and how failed or uncertain sends affect eligibility. |
| Follow-up meaning | Does “thanks”, an emoji, acknowledgement or read receipt count? Distinguish substantive follow-ups from social messages and unrelated new enquiries. |
| Continued AI handling | If the customer follows up and Pronto answers again, does the same request become permanently excluded, restart its waiting period or remain one ongoing request? |
| Staff involvement | Does an automatic handover flag, pause, assignment, staff claim, takeover or actual owner reply disqualify the request? Distinguish review signals from staff resolving the issue. |
| Mixed resolution | If Pronto answers one part but hands another part to staff, is the whole request excluded or can separately defined subrequests qualify? |
| Reopening | What happens when the same issue returns within or after the window, including after it was already counted or invoiced? Is any reversal/credit required? |
| Booking branch | What provider confirmation is sufficient? Does it qualify immediately or after a window? How do failed confirmations, cancellations, changes and staff assistance affect the count? |
| Timing and delayed evidence | Use which verified event timestamps? Define exact boundary behaviour and reconciliation when a follow-up occurred within the window but its webhook arrived after evaluation. |
| Billing period | Calendar month or subscription anniversary? Which timezone defines boundaries? Attribute an outcome to the request, answer or qualification period, especially across month-end. |
| Pending allowance | Do pending outcomes reserve capacity? Without a decision, a business could have many candidates before any qualifies 48 hours later. |
| Limit reached | Notify only, stop additional automated handling, require an upgrade or permit defined overages? Do not introduce a new customer-facing handover/stop policy without agreement. |
| Plan changes | How do upgrades, downgrades, cancellation, trials, unused allowance and any rollover affect pending/counted requests? Which plan/rule version applies? |
| Corrections and disputes | Who can review or adjust a count, what evidence is required and how are changes reflected after invoicing? |

Mock/provider-fixture runs, fictional voice previews, business-source processing,
analytics generation and other internal work should remain distinguishable from
eligible customer service. Recommendation: exclude those activities from outcome
allowances while retaining their real resource-use accounting. The current
public demo must not begin charging users as a side effect of adding a meter.

## Suggested future rollout

1. Agree counting-policy examples, currency, cycle, plan-change and limit rules.
2. Add the request/outcome evidence model and run measurement without charging
   or changing customer-service behaviour.
3. Compare results against human-reviewed, approved real Instagram conversations.
   Use appropriate test handling; do not replay historical messages into the live
   channel or fabricate positive delivery/booking evidence.
4. Resolve disagreements and validate deadline processing, reconciliation,
   counts, corrections and customer explanations.
5. Enable agreed plan allowances for an explicitly authorised customer scope;
   add invoicing/payment automation only when that separate scope is approved.

[Inference] This is a cross-cutting metering feature rather than a price-label
change. Reliable booking confirmation is a separate integration dependency.
Effort cannot be estimated reliably until the counting policy and required
booking evidence are settled.

## Verification required before charging or enforcement

- Tenant isolation, permission checks and auditable plan/policy changes.
- Duplicate/retried/out-of-order inbound and outbound events; concurrent
  qualification and quota updates; no duplicate outcome consumption.
- The 48-hour boundary, follow-up/reopening examples and the chosen treatment of
  acknowledgements, unrelated questions and staff involvement.
- Failed, suppressed and uncertain sends; provider recovery and late evidence.
- Month-end, cycle timezone, plan changes, pending reservations and limit policy.
- Worker restart/sleep recovery and a distinction between eligibility time and
  actual evaluation/settlement time.
- Booking evidence that distinguishes a verified confirmation from availability,
  referrals, clicks or unsupported claims.
- Ledger/UI/export agreement and traceable adjustments after customer review.
- Existing token accounting, knowledge, voice, handover and native-channel
  behaviour preserved unless a later requirement explicitly changes them.
- No real charges or new quota restrictions in the shared public demo by default.

See [customer rollout boundaries](customer-rollout-boundaries.md) for private
customer access and runtime prerequisites. The separate
[SEA regionalisation plan](sea-regionalisation-plan.md) concerns business-local
language/currency/display settings; those settings must not silently change a
subscription's charging currency or existing UTC usage accounting.
