# Later rollout to private customer businesses

Source review: 22 November 2026. This is a code-level assessment, not a hosted
configuration, Meta permission or production-capacity acceptance test. The
current scope remains the shared public Instagram demo.

The deferred [SEA regionalisation plan](sea-regionalisation-plan.md) records
proposed per-business regional settings and language/retrieval gaps. The
[outcome pricing plan](outcome-pricing-plan.md) records the proposed allowances,
backend metering work and unresolved counting rules. These documents do not
authorise implementation, billing or rollout.

## Reusable foundations

The application already separates business records by `client_id`, scopes staff
capabilities to business membership, binds external channels and encrypted
credentials to their business, and maintains per-business knowledge, voice,
handover settings and history. The operator CLI and existing administrative APIs
create draft businesses and staff, delegate capabilities, inspect setup and
record channel activation evidence. These mechanisms can support assisted
customer onboarding without a second tenant model or a new operator frontend.

The ordinary worker already processes durable inbound/outbound work. Knowledge
processing uses persisted jobs and leases. These are suitable starting points
for a later continuously operated customer service; this review does not prove
throughput, hosting availability or recovery under production load.

## Boundaries that require explicit work

| Area | Current boundary | Later customer work |
| --- | --- | --- |
| Public access | Protected-demo guest access intentionally admits reviewers to shared data. | Use authenticated business access for private customers. Do not treat the demo chooser as a role or tenant selector. |
| Business selection | `demoBusinessScope()` selects one active demo identity through server configuration. | Resolve real customers from membership and the receiving channel. Keep saved-demo switching separate from customer enrolment. |
| Instagram | The optional bridge admits one configured account/channel and at most five approved senders. | Implement and verify the customer account onboarding and Meta permissions appropriate to the selected login mode. Retain signature, account, tenant and activation checks. |
| Inference | Demo setup selects Groq explicitly; its adapter restricts use to approved demo/test scopes. | Provide supported real-provider configuration per customer. Do not expand free-tier demo exceptions into a production authorisation mechanism. |
| Retrieval | Demo text retrieval is selected through an execution profile. The ordinary engine can request an embedding before self-serve text retrieval. | Make retrieval mode an explicit supported customer configuration and test its provider requirements. |
| Processing | The request-driven queue coordinator is intentionally bound to the active demo. | Use the existing ordinary worker for customer queues, with operational recovery and monitoring. Do not generalise demo scope checks by removing them. |
| Owner alerts | External alerts are blocked in the protected demo. Existing private notification logic requires verified recipients and permissions. | Agree the notification channel, sender setup and content, then test it in an appropriately restricted customer environment. |
| Setup | Draft creation does not silently grant owner capabilities, approve knowledge or activate channels. | Provide a guided operator checklist around the existing approval, permission and activation services. Preserve independent business approvals where required. |
| Commercial usage | Tokens, calls and delivered replies are recorded. Generic dollar estimates and thread records are not an implemented 48-hour billing meter. | Define billable conversations, provider-specific rates and per-business limits before volume charging. |

## Recommended approach

Keep the public demo configuration intact. For the first private customer, use
operator-assisted setup through the retained APIs, then prove business isolation,
knowledge publication, Instagram delivery, owner handover and future-turn
resumption with that customer's actual approved configuration. Provider health,
Meta access and live acceptance must be verified separately from saved readiness
fields and mocked regressions.

The existing domain model is a reasonable basis for this work. It is not just an
environment-variable switch: demo access, inference selection, retrieval and
queue scheduling have explicit demo-specific behaviour. A focused separation of
runtime configuration from those demo exceptions is preferable to rebuilding
the application or introducing another business/credential store.
