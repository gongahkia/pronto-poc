# Feedback operations after cutover

Public reviewers use Pronto’s existing chooser without an account/password. Database operations remain restricted to an existing named operator with secure access to the verified database. These are host administration commands, not a Huddle login or service.

The one-off production migration and legacy recovery commands are retired. Their CLI regression fixtures require an explicitly marked disposable database. Original tables, user records, private backups and neutral exports remain intact. The shared recovery/conversion helpers stay available to those guarded fixtures and to the recorded recovery history.

Use Node 24.21.0 / pnpm 10.33.0. Load the existing protected deployment configuration securely, using the verified **direct, unpooled** database connection and the saved application origin/environment. The CLI does not load dotenv files, accept passwords in arguments, create accounts, start workers or provision infrastructure. Do not paste credentials into chat or commit them. Keep the original protected database marker and saved destination configuration.

```sh
pnpm feedback:control status --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID"
# use the exact reviewed fingerprint returned by status.
pnpm feedback:control readonly --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --target-fingerprint "$FEEDBACK_TARGET_FINGERPRINT"
pnpm feedback:control export --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --out output/feedback-operations/current.json
pnpm feedback:control resume --database-id "$FEEDBACK_DATABASE_ID" --actor-id "$FEEDBACK_ACTOR_ID" --target-fingerprint "$FEEDBACK_TARGET_FINGERPRINT"
```

Status requires a previously activated store. Mutations recheck the exact target and existing named operator under the same feedback-writer lock. A busy writer causes a bounded failure for deliberate retry. Readonly keeps the new store readable/exportable and denies both new and legacy writers. It never points the application back to the old tables. Resume validates the full current snapshot and restores active mode without rewriting discussion. Export uses a consistent complete `huddle.feedback.v2` snapshot including post-cutover comments, preserving authors, anchors, history and provenance. Environment/origin drift is rejected rather than yielding a misleading empty export.

Export files are new owner-only files and cannot overwrite an existing backup. The configured Pronto integration has one allowed environment; the JSON states that scope explicitly. Preserve a full database backup separately: neutral feedback JSON excludes account credentials and other application data. Storage deletion is not part of these commands.

The real disposable migration suite exercises these permanent commands after cutover: readonly rejects a new reply, complete export retains the post-cutover reply, and resume returns the same record counts. Historical source conversion and installation remain covered on isolated 055/057 fixtures. See [rollout evidence](huddle-v2-progress.md); old migration instructions are a historical recovery record, not current production CLI commands.
