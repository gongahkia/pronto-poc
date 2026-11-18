# Hosted Instagram channel test

Deployment verified on 18 November 2026:
<https://pronto-instagram-test.onrender.com>, deployed code commit `02bdb5b` on
`codex/instagram-hosted-test`, auto-deploy off, Free compute in Singapore. GitHub
redirects the old `gongahkia/pronto-prod` repository name to
`gongahkia/pronto-poc`; both names refer to the same repository. The existing
`pronto-ai-poc` service and its database were not changed.

The new database has migrations 001–060, a restricted pooled runtime role and
separate private operator/business logins. The encrypted Unified Login channel
is draft. Its public callback passed correct-token/exact-challenge and
wrong-token rejection checks; inactive POSTs were rejected and no inbound or
outbound jobs were created. Fresh Meta credential reads and the hosted channel
health check passed. The worker remains disabled: app-level/account
subscriptions, approved knowledge/model configuration, activation approvals and
observed real DM delivery are still outstanding.

Validation: `pnpm typecheck`, `pnpm lint`, 1,072 standard tests passed (161
optional tests skipped), the hosted production build passed, and Render's
Blueprint validation passed. These checks do not establish real DM delivery or
continuous free-tier availability. Private operational receipts and login files
are under ignored `output/instagram-hosted/`; Keith's generated callback/token
handoff is under ignored `output/instagram-setup/`.

This deployment is separate from the public synthetic demo. It uses an
authenticated standard-profile Pronto app, a dedicated Neon Free project and
the ordinary encrypted channel credentials and approval gates. There are no
guest sessions, public feedback access, fixture seed or automatic channel
activation. The local Docker database is not the hosted database.

The [Render configuration](../../deploy/render-instagram.blueprint.yaml.example)
uses one Free web service. It builds with `pnpm instagram:hosted:build` and starts
with `pnpm instagram:hosted:start`. The build copies the standalone static assets
and excludes traced local dotenv files. Node is pinned to 24.21.0.

The startup supervisor requires `PRONTO_HOSTED_INSTAGRAM=1` and the explicit
standard-profile settings in the example. It accepts only the separate
`pronto_instagram` Neon database with `sslmode=verify-full`. Runtime uses a
restricted database role and a pooled connection; migrations use a separate
direct owner connection. Keep those credentials and generated account passwords
in private, ignored files and Render's environment.

`PRONTO_HOSTED_INSTAGRAM_WORKER=0` starts only the web application, allowing Meta
callback verification while the Instagram channel remains draft. After the
channel's independent approvals, evidence and model configuration are ready,
setting this flag to `1` starts the existing durable inbox/outbox worker beside
the web application. Either process failing stops the other so Render can
restart the service. SIGTERM gives both processes up to 30 seconds to stop.
The supervisor bounds the web and worker heaps; this is a small controlled-test
configuration, not a demonstrated production capacity limit.

Render's Free service sleeps after idle periods, so the co-located worker is
also unavailable while it sleeps. Open the service and confirm it has warmed
before coordinating a test DM. Do not add artificial keep-alive traffic or
promise continuous external delivery. Production needs an appropriately funded
always-on arrangement. Free hours are shared with other services in the same
workspace. See [Render Free limits](https://render.com/docs/free).

## Provision and verify

1. Create a separate Free Neon project and apply all current migrations using
   its direct owner connection. Verify the new database's unique comment using
   `shobj_description`, its identity and the client TLS socket. Neon terminates
   client TLS at its proxy; the backend's `pg_stat_ssl` is not evidence about
   that client connection.
2. Bootstrap only the initial operator with a new random password, then use the
   authenticated operator API to create the test business and initial business
   member. Create an inactive Instagram channel through the business API.
   Business identities are not authorization to fabricate business approval.
3. Deploy a reviewed commit from a dedicated Git branch with auto-deploy off,
   the standard-profile flags and worker disabled. Preserve the existing demo
   service and its database. Check Render's deployed commit and actual URL.
4. Run `pnpm instagram:prepare` with the real business ID, channel ID and hosted
   origin. Submit its private channel form through `pnpm admin`; this saves
   encrypted credentials and a draft channel, without activating delivery.
5. Verify over public HTTPS that the saved verify token returns the exact
   challenge and a wrong token is rejected. Confirm unauthenticated business and
   operator routes require sign-in and the public demo entry is disabled.
6. Share only the generated `keith-private.txt` with Keith through the agreed
   private channel. He configures the callback and app-level `messages` field.
   We then inspect and explicitly enable the separate account subscription.

Callback verification does not establish Development-mode real-message
eligibility, provider acceptance or recipient delivery. Keep the worker disabled
and the channel draft until the remaining controlled-test gates are complete.
Do not describe credential reads as observed DM delivery or mark that evidence
complete before a real authorized test.
