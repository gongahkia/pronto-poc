# Owner self-serve workspace

The supplied November 20 brief and local wireframes define the new Home, Business rules, Brand voice/Customise and Handovers screens. `PRONTO_SELF_SERVE_ENABLED=1` opts in; ordinary managed deployments keep their existing approval workflow and interface. The existing customer simulator and all historical data remain.

Apply migration **063** before enabling the flag. `/client` opens `/client/home`. Existing knowledge/voice/handoff entry routes redirect to the corresponding new screen; the old inbox entry redirects Home. Direct historical conversation records, existing protected APIs, usage and analysis remain available. The new navigation has no reply inbox. Consult stays disabled until a destination exists.

On an unprepared business, **Prepare workspace** creates a business-scoped configuration and copies existing knowledge into processing sources, retaining the original sources and voice. Existing replies keep using the managed configuration until all imported sources finish checking. No reset/seed command is part of this rollout. New businesses start with Small text; existing businesses retain their current custom voice. Separate saved businesses remain separate.

## Rules and execution

Text, one public URL or a supported file becomes a durable source job. Extraction and conflict judgement use a genuine configured model, bounded to one model call per processing slice. The public demo uses Groq `openai/gpt-oss-20b`; it does not consume the local OpenAI evaluation budget. Extraction preserves exact evidence quotes and checks factual values. A separate model pass verifies each extracted rule against the original text, including negations and qualifications; model outputs and actual model/usage are recorded. These checks do not prove semantic perfection: owners can inspect and edit extracted rules.

All candidate rule pairs are judged semantically, including across different topic tags; there is no lexical pruning that silently skips a contradiction. Sources requiring over 50,000 comparisons fail visibly and need smaller input or removal of outdated rules.

Only checked, non-deleted, non-conflicting rules enter the runtime read model. Unresolved policy topics are passed to semantic handover routing; conflicting alternatives are withheld from customer grounding. Old knowledge chunks cannot bypass the new live rule set. Retained source URLs remain available as provenance. Deleting a source withdraws its rules without deleting conversation history.

An edited rule stays withheld, with its old conflicts, until rechecked. Keep removes all directly conflicting alternatives; unrelated conflicts remain. Settings use optimistic revisions; rules use an epoch at final publication to recheck comparisons if another rule changed. Jobs have expiring leases and claim tokens; late attempts cannot publish over a replacement claim. Each turn captures configuration, and queued replies from an older configuration revision are suppressed before dispatch. An external request already sent cannot be recalled, and an ambiguous provider response still cannot establish exactly-once delivery.

The request-driven workspace pump processes durable jobs while the page is open. Ordinary `pnpm worker` also processes them when enabled. Render Free can sleep; no continuous worker or instant processing is promised. Pending jobs resume on the next visit. Failed sources and handover jobs show an error rather than pretending to be live.

## Voice and uploads

One of six presets or one custom note set is active. Selecting a card previews it; Use saves it. Switching presets retains saved custom notes. Three fictional, industry-specific sample messages produce 3–8 editable observed notes. Saving is explicit; changing a note clears the saved indication. Real previews are illustrative and cannot perform a booking change.

Chat uploads accept WhatsApp TXT/ZIP exports or screenshots, up to 25 MB total. A session cannot mix exports and images. Export participants are parsed locally; the owner must select the business participant before analysis. Images are OCRed locally; the owner must remove customer-side text and OCR errors. Review is mandatory before any sample text goes to the configured AI provider. Known participant names, emails, links and common phone formats are redacted; arbitrary personal information can be missed, so the interface does not claim complete anonymisation. Do not upload material without permission.

Temporary originals are encrypted in PostgreSQL and cleared after extraction. Local conversion files are removed in `finally`. Unfinished sessions expire after one hour and are purged on subsequent processing or session access; a sleeping host cannot promise wall-clock deletion. Discard clears samples and draft notes. Analysis clears reviewed upload text; saved style notes remain until replaced. Deletion is logical removal from active application storage, not a claim about physical erasure from database backups or a provider's separate retention policy. Session samples/results are actor-private; shared workspace polling does not expose them.

Source files support PDF, Word, TXT/Markdown, CSV, XLSX and common images. Limits: 25 MB, 50 PDF pages, 200,000 extracted characters and bounded archive expansion/conversion time. CSV rows, spreadsheet sheets/rows and PDF pages retain references. Native OCR/conversion requires Tesseract (eng/chi_sim/tam), Poppler, ImageMagick/libheif and antiword. The Render image installs these; large or malformed documents can fail with an actionable request for a smaller/text version. Multipart uploads and extraction jobs share one heavy-work slot per web process to bound memory.

## Silent handovers and native replies

Unknown and conflicting rules are locked on. Other configured situations use semantic matching; large-group routing is strictly **more than N**, not N or more. Existing safety, factual-grounding, private-record and unavailable-action limits remain. On handover Pronto pauses silently and queues the staff issue, without an acknowledgement or continuation message.

Alert preferences require a matching active channel and verified, authorised business recipient before enabling. WhatsApp and email each have durable delivery records, so retrying one failed destination does not resend a successful destination. Ambiguous deliveries stay uncertain for reconciliation. Both channels off is allowed with a warning. The protected public demo continues to block external staff alerts; this interface does not claim an alert was sent.

Signed/account-matched native Instagram text echoes and WhatsApp `smb_message_echoes` can resolve the current hold and permit future customer messages. Duplicate/stale echoes, API message receipts, other-app echoes, edits/revokes and delivery/read status updates do not resume it. Already paused or delayed older inbound work stays skipped. Instagram still needs a live native-owner-reply test; no claim of end-to-end acceptance is based on fabricated webhooks. WhatsApp requires Business App coexistence onboarding and the relevant provider subscription; ordinary Cloud API delivery receipts are insufficient. See [Meta's reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes).

## Verification evidence

Fresh, marked disposable PostgreSQL runs verify migration/repeat application, conflict withholding and rechecks, stale revisions, lease replacement, source deletion, training order, participant review, expiry/discard and tenant scope. Browser checks exercise persisted voice selection, editable custom notes, locked handovers, source addition and 1440px/390px layouts. Evidence files are private in ignored `output/playwright/self-serve` and `output/isolated-db`.

A genuine Groq hosted-database preparation converted the three existing demo sources into five checked rules with no conflicts, retaining all old tables. A separate fictional three-round voice smoke produced seven notes; opening-hours triage continued and a refund complaint handed over. The test session was discarded and the active voice was not changed. These focused checks are not a full multilingual evaluation or a live native-channel acceptance test.
