# SEA regionalisation: deferred planning

Recorded 22 November 2026, based on code review at `36efa89` and the product
discussion. **Status: deferred; documentation only.** The user wants to retain
this plan for later, without implementing regional settings now. This document
does not authorise implementation, migrations, language enablement or deployment.

## Intended direction

Give each business a regional profile consumed alongside approved knowledge,
brand voice and handover rules. Keep one shared assistant and tenant model.
Country presets would suggest defaults for owners to confirm; country, customer
language, source language and staff interface language remain separate concepts.
There should be no single assumed “SEA voice”.

Regionalisation and private-customer onboarding are distinct workstreams. The
[customer rollout assessment](customer-rollout-boundaries.md) covers demo access,
provider configuration, queues and customer isolation. This plan does not resolve
those boundaries or add messaging platforms beyond the currently connected
Instagram demo.

## Proposed owner experience

Add **Settings → Region & languages**. The following Malaysian café is an
illustrative configuration, not a committed launch market or current feature.

| Setting | Example | Intended behaviour |
| --- | --- | --- |
| Business country | Malaysia | Suggest initial defaults; owner confirms them. |
| Outlet timezone | `Asia/Kuala_Lumpur` | Interpret business-local dates, “today” and “tomorrow”. |
| Default business currency | `MYR` | Establish currency for otherwise unlabelled owner-entered prices, subject to review. |
| Supported customer languages | English, Malay | Select from languages verified for the configured model and workflow. |
| Reply behaviour | Match the customer | Follow an enabled language and explicit language changes in the conversation. |
| Default reply language | English | Handle unclear language, such as a short greeting. |
| Workspace date/number format | Malaysian formatting | Format business-facing dates and numbers consistently. |

Brand voice remains in its existing screen. Preset/custom tone, formality and
local-expression preferences apply within the selected customer language.
Language settings must not override factual grounding or handover authority.

Proposed unsupported-language behaviour: flag the conversation for staff using
the existing handover policy. Distinguish an actually unsupported language from
an ambiguous greeting; the latter can use the default reply language. In the
current silent self-serve mode, do not introduce a new automatic customer-facing
handover acknowledgement without a separate product decision.

Example flow: the owner uploads English opening-hours information; a customer
asks in Malay; Pronto retrieves the approved facts and answers in Malay using
the active voice. A later explicit switch to English changes the reply language
without changing the facts or ownership of the conversation.

Recommended initial workspace interface: retain English while regionalising
customer conversations. Translating the owner interface is a separate scope;
its eventual language preference may belong to each staff user rather than
forcing every member of a business to use the same language.

## Boundaries for the proposed design

- A country does not uniquely determine language, timezone or charging currency.
  Owners confirm each relevant setting.
- Selecting a country does not supply evidence for holiday closures, tax/fee
  policies, dietary claims or other business facts. These still need approved
  sources.
- Currency configuration does not perform foreign exchange or relabel an
  existing `S$10` policy as `RM10`. Preserve explicit sourced currencies and
  amounts; require clarification/review for ambiguity.
- Presentation preferences do not silently change the usage ledger's currently
  explicit UTC accounting periods or configure provider/billing rates.
- Original approved evidence remains authoritative across translation. Derived
  search text must not become an independently approved business fact.
- A language appearing in a selector or a fluent sample reply is not acceptance
  of retrieval, factual checks, safety routing or native-channel delivery.
- Recommend one outlet/timezone per workspace initially. Multi-outlet and
  multi-timezone businesses need a separate routing design.

## Existing foundations and verified gaps

The application already has tenant-scoped business profiles, permissions,
knowledge, voice and handover configuration. The customer-answer prompt asks
for the customer's language, source extraction preserves the original language,
and conflict checking compares meaning across languages. These mechanisms are
reusable; their instructions alone do not establish language quality.

The [business clock](../../src/lib/agent/business-clock.ts) already consumes
`clients.business_profile.timezone`, with UTC fallback. However,
[display formatting](../../src/lib/date-format.ts) uses deployment-wide defaults,
and the reservation planning/tool path contains hardcoded Singapore calendars
and timezone values.

Self-serve knowledge uses PostgreSQL `simple` full-text matching in
[runtime.ts](../../src/lib/self-serve/runtime.ts). The
[query normaliser](../../src/lib/knowledge/query.ts) combines ASCII/CJK tokens
with a fixed set of language-specific category aliases. Read-only checks during
the planning discussion showed:

- `normalizeKnowledgeQuery("กี่โมงเปิดร้าน")` produced an empty search query.
- The factual-value extractor recognised `SGD 30`, but did not recognise the
  tested `MYR 30`, `RM30`, `IDR 30000`, `THB 300`, `VND 30000` or `PHP 300` as
  price facts.

The latter is a gap in that particular checker, not evidence that every other
validation layer is absent. See
[grounded-values.ts](../../src/lib/agent/grounded-values.ts).

OCR currently selects `eng+chi_sim+tam` in
[files.ts](../../src/lib/self-serve/files.ts); the Render image installs those
language packs. Existing local language evaluation is uneven and predominantly
English. See the [hardening evidence](../testing/200-scenario-hardening.md).
It is not broad SEA acceptance for the current hosted Groq workflow. No new
language benchmark was run for this planning document.

## Proposed code changes

| Area | Existing locations | Proposed work |
| --- | --- | --- |
| Regional data and resolution | `clients.business_profile`, [types.ts](../../src/lib/types.ts), [business-clock.ts](../../src/lib/agent/business-clock.ts) | Extend the existing business profile with a validated regional structure and one shared resolver. Avoid competing copies in environment variables and self-serve settings. Reconcile the existing timezone field explicitly. |
| Settings and setup | [Settings page](../../src/app/client/settings/page.tsx), `src/app/api/self-serve/[[...path]]/route.ts`, [settings.ts](../../src/lib/self-serve/settings.ts), operator/client setup | Add the owner form and authenticated read/save path. Validate supported country/language/currency values and timezones server-side. Preserve tenant checks, CSRF, permissions, audit and optimistic concurrency. |
| Consistent runtime context | [store.ts](../../src/lib/self-serve/store.ts), [engine.ts](../../src/lib/agent/engine.ts), [outbox.ts](../../src/lib/channels/outbox.ts) | Capture regional context with each turn/job and extend configuration-version handling to regional changes. Decide how existing queued replies and derived search data respond to a changed profile. |
| Model instructions and previews | [prompt.ts](../../src/lib/llm/prompt.ts), [LLM types](../../src/lib/llm/types.ts), [self-serve model](../../src/lib/self-serve/model.ts), [voice jobs](../../src/lib/self-serve/voice.ts), [scenarios](../../src/lib/self-serve/catalog.ts) | Supply the same regional/language policy to relevant customer replies, triage and setup calls. Localise fictional scenarios and genuine previews without adding fabricated prices, policies or performed actions. |
| Multilingual retrieval | [query.ts](../../src/lib/knowledge/query.ts), [retrieve.ts](../../src/lib/knowledge/retrieve.ts), [runtime.ts](../../src/lib/self-serve/runtime.ts) | Address unsupported scripts and cross-language source lookup. Benchmark bounded query translation/normalisation into the source language while retaining original evidence and citations. Any extra calls count toward existing turn limits and usage. The final retrieval approach remains subject to evidence. |
| Factual and routing checks | [grounded-values.ts](../../src/lib/agent/grounded-values.ts), [self-check.ts](../../src/lib/agent/self-check.ts), [guardrails.ts](../../src/lib/agent/guardrails.ts), [handoff wording](../../src/lib/agent/handoff-wording.ts) | Extend currency/number/date/time interpretation and language-sensitive checks. Verify translated human requests, safety concerns, negation and mixed-language messages without weakening existing grounding or handover rules. |
| Clocks and presentation | [date-format.ts](../../src/lib/date-format.ts), [reservation context](../../src/lib/reservations/model-context.ts), `src/lib/reservations/{types,chope,chope-browser}.ts` | Use explicit business-local context where appropriate. Remove Singapore assumptions from shared planning code while retaining connector-specific outlet approval and availability checks. Regional configuration does not grant new booking capabilities or geographic connector coverage. |
| Documents and interface | [files.ts](../../src/lib/self-serve/files.ts), [Render image](../../deploy/render-web.Dockerfile), self-serve components | Add verified OCR packs and extraction coverage for selected document languages, retaining size/time/concurrency limits. Localise owner-facing copy separately if approved. |

Extending an existing JSON profile does not settle the migration design. A later
implementation must decide schema/versioning and backfill details, including
managed businesses without `selfserve_settings`. Existing timezone values and
current effective demo behaviour must be preserved rather than overwritten by
a blanket country default.

## Suggested sequence when implementation is authorised

1. Agree the initial pilot countries, customer languages, document languages and
   unsupported-language policy. Keep model readiness distinct from owner choice.
2. Define the regional schema, defaults, migration and audited save/read path.
   Integrate it with configuration snapshots and stale-work handling.
3. Apply regional context to clocks, formatting, prompts and real previews.
4. Resolve retrieval and factual-validation gaps for the selected languages,
   measuring quality and any added provider usage/latency.
5. Add only the required document-language support and any approved interface
   translations.
6. Run the acceptance matrix below, then enable tested scope progressively.

This sequence is a proposal, not an active implementation checklist or a launch
commitment. [Inference] The settings form/profile work is relatively small;
retrieval and language-sensitive validation are the principal engineering and
evaluation risks. A reliable delivery estimate needs the selected pilot scope
and native-speaker review availability.

## Acceptance required before language enablement

- Regression checks for the existing Singapore demo, tenant boundaries, settings
  permissions and concurrent saves.
- Business-local midnight, “today/tomorrow”, date ambiguity and booking-tool
  calendar checks; explicit UTC usage accounting remains consistent.
- Correct currency identity, decimal/group separators and factual values across
  source/reply languages, including rejection of invented prices/conversions.
- Retrieval from same-language and different-language approved sources, including
  unsupported scripts, follow-ups and mixed-language messages.
- Genuine configured-model runs covering facts, uncertainty, complaints, human
  requests, safety concerns, voice styles and unsupported-language behaviour,
  with native-speaker review. Record provider/model identity and usage.
- Document extraction checks for each enabled OCR language within the existing
  deployment's resource limits.
- Native Instagram checks for delivery, silent handover and owner-reply resumption
  using approved testers. Mocked HTTP, fabricated webhooks and historical threads
  do not substitute for fresh native-channel acceptance.
- Existing customer-facing history, source approvals and active voices retained;
  no regional selection silently rewrites approved knowledge or activates a
  channel/provider.

## Decisions still needed

- First pilot countries and explicitly supported customer/document languages.
- Whether to accept the proposed silent staff handover for unsupported languages.
- Whether the owner interface stays English initially and how later per-user
  language preferences relate to business display formatting.
- Whether one outlet/timezone per workspace is sufficient for the first release.
- How owners review ambiguous legacy prices and incomplete regional metadata.
- Retrieval approach after benchmark results, with acceptable latency and usage.
- Permission for editing regional settings and treatment of in-flight work.
- Who supplies native-speaker review and what evidence qualifies a language for
  enablement on each configured model.
