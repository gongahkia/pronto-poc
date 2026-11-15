# Private feedback migration and rollback

This temporary Pronto tooling converts the complete legacy PostgreSQL feedback tables to `huddle.feedback.v2`. It does not start a service, create accounts, load dotenv files, provision hosting, deliver messages or run inference. Keep it until actual source migration and hosted parity are accepted. Fixture success does not establish that acceptance.

Use Node 24.21.0 / pnpm 10.33.0 and the frozen lockfile. Current SDK archives and hashes are in [vendor provenance](../../vendor/README.md). Run `pnpm fixtures:huddle:postgres` once to prepare the pinned local PostgreSQL recovery binaries; this compiles source without starting an existing database. The recovery command creates, verifies and removes its own fresh marked database. It restores only feedback tables and recorded creator names; retain the host's separately verified whole-database backup for application recovery.

The CLI requires an explicit `DATABASE_URL`, existing protected-demo configuration, verified database marker/TLS and an existing internal actor. It does not use the application's fallback URL. Local use accepts only the invocation's marked fixture nonce and exact loopback test URL. `--database-id` must match that identity. Mutations also require the target fingerprint returned by `status`, binding host/port/database/marker/application origin without printing credentials. The actor ID attributes the authorized operator's existing database access; it is not a login, privilege grant or substitute for a real hosted named-user session. Current identity and internal policy are rechecked throughout.

Before hosted changes, complete local and remote CI, confirm Render’s existing deployment settings, intended revision and authorized database access. The approved website policy is now public-demo: two actual chooser sessions establish positive hosted acceptance, without internal-user passwords. The migration operator remains an existing named internal actor. The earlier security-only/internal-browser prerequisite is superseded by this explicit public policy. No application migration runs automatically when mounting the SDK.

For a feedback-only main release, include `[feedback-only]` in the release commit message. The general CI workflow then skips its ordinary application E2E command (which spawns an inference worker) and worker-container startup. Its non-worker checks remain enabled, and the dedicated Huddle workflow runs both private and public review browsers plus real database/migration checks. This honors the no-inference-worker boundary; it is not new acceptance of ordinary business E2E or worker startup. Other releases and pull requests retain their existing full checks.

The following commands assume private deployment configuration is already loaded through the existing secure operator mechanism. Do not put database passwords or session cookies in arguments, Git, chat or logs. Set `FEEDBACK_DATABASE_ID` and `FEEDBACK_ACTOR_ID` to the reviewed non-secret IDs. Choose an owned private directory outside Git (ignored `output` is suitable locally). Every output path must be new; commands refuse overwrite.

```sh
umask 077
mkdir -p output/feedback-cutover
pnpm feedback:migrate status --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID"
# review the fingerprint and set FEEDBACK_TARGET_FINGERPRINT explicitly.
pnpm feedback:migrate backup --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --out output/feedback-cutover/initial.json
pnpm feedback:restore-check output/feedback-cutover/initial.json > output/feedback-cutover/initial-restore.json
```

The first backup works on the pre-058 schema. It uses one repeatable-read snapshot, preserves every known legacy field and exact UTC microseconds, and fails on unknown/missing source columns or exceeded bounds. Default backup bounds are 32 MiB / 100,000 source thread/comment records. It never clips rows. Keep its matching recovery receipt and the original file. The application origin is an explicit operator choice used to reconstruct page URLs; legacy rows recorded only paths, so the original scheme/host cannot be recovered from those rows.

Install the reviewed additive migrations 058/059:

```sh
pnpm feedback:migrate install --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --target-fingerprint "$FEEDBACK_TARGET_FINGERPRINT" --backup output/feedback-cutover/initial.json --restore-receipt output/feedback-cutover/initial-restore.json
```

The hosted ledger was observed at 055. To include its reviewed application prerequisites, add `--apply-prerequisites 056-057` to `install`, after a complete logical database backup/recovery check. Only missing `056_local_openai_evaluation.sql` and `057_issue_scoped_handoffs.sql` are eligible: 056 widens the allowed model-choice constraint without enabling a provider; 057 adds a default-false handoff column only if absent, retaining existing column values. No other missing baseline migration is accepted. The disposable `pnpm test:huddle:migration --baseline-055` rehearsal verifies refusal without explicit approval, refusal of an unrelated ledger hole, exact four-file installation and complete migration/parity/rollback. Normal 057-baseline installation is independently retained.

Installation otherwise requires the complete pre-058 migration ledger, a matching successful restore and an unchanged source. It takes the existing migration lock and a five-second bounded table lock, then applies only the explicitly selected reviewed prerequisites and 058/059 in one transaction. An already/partly installed schema is refused for explicit inventory. The default maintenance gate and legacy triggers block both old and new feedback writers after commit. Original tables/rows remain intact. Other application workflows are outside this feedback gate. If writes prevented the table lock or changed the backup, installation fails without applying either migration: take and restore a fresh backup, then retry deliberately.

On an already installed schema, `pause` takes the shared feedback lock exclusively and selects maintenance before cutover, or readonly after activation. An in-flight feedback transaction causes a deliberate retry instead of an unbounded wait. Take a final private backup and restore it under the pause even if the initial digest is unchanged:

```sh
pnpm feedback:migrate pause --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --target-fingerprint "$FEEDBACK_TARGET_FINGERPRINT"
pnpm feedback:migrate backup --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --out output/feedback-cutover/final.json
pnpm feedback:restore-check output/feedback-cutover/final.json > output/feedback-cutover/final-restore.json
pnpm feedback:migrate prepare --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --target-fingerprint "$FEEDBACK_TARGET_FINGERPRINT" --backup output/feedback-cutover/final.json --restore-receipt output/feedback-cutover/final-restore.json
pnpm feedback:migrate preview --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --target-fingerprint "$FEEDBACK_TARGET_FINGERPRINT" --out output/feedback-cutover/preview.json
```

Review the private preview's exact counts, historical authors, environment and origin mapping, conflicts, expiry and digest. Legacy feedback had no environment; conversion names it `legacy-pronto` and maps it explicitly to the configured `PRONTO_HUDDLE_ENVIRONMENT`. IDs/names remain historical; no automatic identity merge or account creation occurs. Raw anchors, nullable author IDs, request IDs and source rows are retained in context/history alongside neutral provenance. A 700-character old selector is within the neutral 16,384-character bound. Unsupported/oversized fields fail conversion rather than truncate. Legacy status/resolution timestamps are retained, but the old tables never recorded status transitions or resolver identity; conversion labels that absence and does not invent history.

Execution is deliberate, bounded and resumable:

```sh
pnpm feedback:migrate execute --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --target-fingerprint "$FEEDBACK_TARGET_FINGERPRINT" --preview output/feedback-cutover/preview.json --max-batches 20
pnpm feedback:migrate verify --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --target-fingerprint "$FEEDBACK_TARGET_FINGERPRINT"
pnpm feedback:migrate activate --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --target-fingerprint "$FEEDBACK_TARGET_FINGERPRINT"
```

Each SDK request acknowledges at most 100 records. Each invocation permits 1–2,000 batches with a five-minute operation signal and 120-second SDK requests. Repeat `execute` deliberately until complete. Omit `--preview` to recover the exact saved preview/digest/key from the database if a local acknowledgement/file was lost. A changed supplied key/actor/preview is refused. A failure leaves the gate paused and committed records retained. Staging expires after 24 hours. For expired staging, explicitly run `preview --replace-preview OLD_PREVIEW_ID --out NEW_PRIVATE_FILE`; this retains the prior checkpoint in `migration_attempts` and keeps all destination records/provenance. Repeated content is skipped; conflicting content is never overwritten. A changed source/backup requires investigation and a reviewed recovery, not automatic replacement.

`verify` compares all source/destination thread/comment/history fields, source IDs and provenance digests, exact times, text, raw anchor/context/request metadata, historical attribution, status, counts and summaries. `activate` repeats fresh full parity under the exclusive writer lock before selecting active. There is no dual write. Final production app deployment/push remains gated on accepted parity and the existing hosting sequence. Verify CI and `/api/status` report the intended deployed revision, then test the selected access policy: for the approved public-demo rollout, use two real chooser visitors sharing imported feedback and pin/reply/status/export, fresh-visitor persistence, and customer/business navigation. Verify absent/forged/revoked sessions, foreign scopes and cross-origin writes are denied. Internal mode separately retains its named-session/guest-denial tests. Avoid customer processing/analytics pages or worker startup during feedback-only acceptance.

If post-cutover behavior needs rollback, use the same current application/store with `readonly` (same arguments as `pause`), then `export --out NEW_PRIVATE_FILE`. Reads and complete export retain the selected host access policy while writes fail. Do not point an older application at the legacy tables; that would hide new discussion. `resume` revalidates the current complete export/target and restores active mode without rewriting imported or post-cutover data. `activate` is deliberately unavailable for an already activated target. Test a full current neutral export before any later storage removal. No cleanup command deletes original legacy rows, backups, accounts or the new store.

`pnpm test:huddle:migration` rehearses initial backup/recovery, additive installation, exact target refusal, saved-key lost acknowledgements, expiry/repreview, complete parity, activation, post-cutover reply and readonly/resume on a new owned PostgreSQL 18.6 database. `pnpm test:huddle:db` repeats the complete database suite. `pnpm test:huddle:browser` migrates a fresh historical fixture before testing named fixture logins and guest denial from a separate archive-installed consumer. `pnpm test:huddle:browser:public` instead verifies chooser-only shared review and historical data under the explicit public policy. None of these commands accepts an existing database URL as its disposable target.
