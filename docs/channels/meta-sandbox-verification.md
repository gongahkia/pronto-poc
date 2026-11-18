# Meta sandbox activation and evidence

Status on 12 October 2026: **local fixtures verified; no authorized Meta
provider check or send performed by this MVP tranche**. The user reports a
WhatsApp test WABA whose outbound delivery failed with Meta code `131031`
and a restricted Business Account; that restriction is not bypassed.
Instagram test-account setup remains pending. Keep credentials out of Git,
chat, shell arguments and
logs. This procedure uses only a newly marked, isolated `pronto_test`
database; see [safe testing](../testing/safe-regression-baseline.md).

## Account prerequisites

### Instagram Unified Login credential smoke check

For a manually generated Unified Login test token, put these server-only values
in the ignored root `.env`: `PRONTO_INSTAGRAM_TEST_ACCOUNT_ID`,
`PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN`, `PRONTO_INSTAGRAM_TEST_APP_ID`, and
`PRONTO_INSTAGRAM_TEST_APP_SECRET`. Use the **Meta** app ID/secret from that
setup. `PRONTO_INSTAGRAM_TEST_CONFIG_ID` and
`PRONTO_INSTAGRAM_TEST_BUSINESS_ID` are optional for this check; they are needed
when implementing the business onboarding/token-management flow, not for these
two credential reads. Existing shell variables take precedence over `.env`.

```sh
# Local presence/format checks only; no database or network access.
pnpm instagram:smoke
# Explicitly approved test-account reads only; no messages or subscriptions.
PRONTO_META_TEST_ACCOUNT=1 PRONTO_META_READ_APPROVED=1 pnpm instagram:smoke --read
```

Read mode calls Meta's `debug_token` endpoint with app authentication, checks
token validity, app identity, reported expiries and the `instagram_basic` /
`instagram_manage_messages` grants, then reads `id,username` for the exact
configured Instagram account. It does not read conversations, change a
subscription, start a worker, write to PostgreSQL or send a DM. Missing/invalid
inputs stop before any request; failed reads are not retried. Output omits
tokens, secrets, account names, raw provider errors and request URLs. The debug
endpoint requires `input_token` in its query; never log that URL.

Passing means those credential reads succeeded, not that webhook delivery,
messaging delivery, business-portfolio ownership or production access was
verified. An expiry of zero means Meta reported no scheduled expiry, not that
the token cannot be revoked. See Meta's [Unified Login authentication](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication)
and [token inspection reference](https://developers.facebook.com/docs/graph-api/reference/debug_token/).

Pronto's manually provisioned Unified Login channel uses
`settings.authMode=unified_login`, `credentials.accessToken`,
`credentials.igUserId` (or the channel external ID), `credentials.appSecret`, and
`settings.verifyToken`. Optional `credentials.configId` and
`credentials.businessId` retain onboarding metadata. Use the existing encrypted
channel/draft mechanism; the smoke environment values are never global fallback
credentials for tenant channels. The business channel detail form supports this
mode; save a changed authentication mode before entering its mode-specific
fields. The authenticated [operator CLI](../ops/operator-cli.md) can also save
the settings and credentials through the existing channel endpoint.

Connection checks read the configured Instagram account directly and sends use
`graph.facebook.com/<version>/<igUserId>/messages` with the channel's own token.
A linked Page and the Instagram Login OAuth flag are not required for this mode.
This is manual test-token support; no Unified Login OAuth onboarding button or
token refresh automation is added. The existing business approval, operator
activation and channel delivery checks still apply. The protected synthetic
hosted demo still excludes external-channel processing.

Before a real DM round trip, configure and verify the channel's public HTTPS
webhook, subscribe the app/account to the required message events, and identify
the authorized test sender/recipient. Then run one controlled conversation using
the process below. Credential smoke success alone does not activate a channel.

### Preparing the callback and Keith's handoff

The setup commands use the four existing credential fields in `.env`. They
support the manually generated test token; a production OAuth onboarding and
token-refresh service is a separate feature.

First choose an existing, unused/inactive Instagram channel in the intended
test business. Create it through the existing business channel page if needed.
Prepare private operator input without connecting to any database or provider:

```sh
pnpm instagram:prepare --client-id BUSINESS_UUID --channel-id CHANNEL_UUID \
  --callback-origin https://YOUR-TEST-HOST
```

This creates a fresh directory under ignored `output/instagram-setup/` with
three mode-600 files: `channel-form.json`, `connection.json`, and
`keith-private.txt`. The first contains credentials; submit it only through the
existing authenticated operator CLI. The second binds the account/app, tenant,
channel, callback and fresh random verify token. The third is the copyable
Keith handoff containing the actual callback and verify token, without the API
token or app secret. Output paths are printed; secret contents are not.

Authenticate to the intended test app and submit the generated inactive
configuration (replace SETUP_DIR with the printed directory):

```sh
pnpm admin login --base-url http://localhost:3000
pnpm admin request /api/operator/channels --base-url http://localhost:3000 \
  --form-file SETUP_DIR/channel-form.json
```

This deliberately saves `status=draft`; it does not activate the channel or
write to an arbitrary database directly. Do not use an active channel for
preparation: the draft form is for an unused/inactive channel. The setup
generator checks identifier syntax, not database ownership; the authenticated
server checks actual ownership. Keep `APP_BASE_URL`, web/worker database and
encryption key consistent with the intended local test environment. The public
callback must reach that same app through HTTPS.

After Keith has configured the app-level callback and selected `messages`,
inspect the separate account subscription:

```sh
PRONTO_META_TEST_ACCOUNT=1 PRONTO_META_READ_APPROVED=1 \
  pnpm instagram:subscription inspect --setup-file SETUP_DIR/connection.json
```

To explicitly enable it after reviewing the target:

```sh
PRONTO_META_TEST_ACCOUNT=1 PRONTO_META_READ_APPROVED=1 PRONTO_META_SUBSCRIBE_APPROVED=1 \
  pnpm instagram:subscription subscribe --setup-file SETUP_DIR/connection.json
```

Both modes recheck credential validity, app identity, account access and
messaging permissions. Subscribe mode verifies the saved callback's challenge,
adds `messages` while retaining the app's reported existing fields, and reads
the subscription back. An already enabled messages subscription is left alone.
Malformed/incomplete results stop without a write. No provider pagination URLs
are followed, credentials are sent only to the fixed Graph host, and no DM or
Pronto activation occurs. A transport failure or failed confirmation after a
write produces `uncertain`: inspect the actual state before any deliberate
retry. This command never retries a write automatically.

We can finish the local implementation and signed webhook tests without Keith.
Before asking him to configure Meta, prepare a channel-enabled local environment
with a public HTTPS tunnel, a verified isolated database, and a manually
provisioned `unified_login` channel. Save its encrypted credentials and a fresh
random `settings.verifyToken` through the existing authenticated operator
channel API, with `status=draft`. Keep that token out of Git and chat.

Use the actual channel UUID and stable public origin to produce:

```text
Callback URL: https://<public-origin>/api/webhooks/instagram/<channel-uuid>
Verify token: <share privately from the saved channel settings>
Webhook field for the initial text-DM test: messages
```

The GET callback accepts the correct verification token for an encrypted,
configured Unified Login channel whose status is draft or active. Disabled
channels remain closed. POST notifications still require an active channel;
verification does not queue a customer message, run the agent, or enable replies.
Credentials stored only in an unpublished `channel_drafts` row do not configure
the callback: the operator must first save the inactive channel's own settings.

Once that URL is reachable, send Keith these instructions with its real values:

> The supplied credentials passed our read-only checks. In the existing Meta
> app, open **API setup with Unified login → Configure webhooks**. Enter the
> callback URL and privately supplied verify token, then verify and save.
> Subscribe to **messages** for the initial text-DM test. Please confirm the
> verification result and the app's Development/Live mode, and report any access
> or review errors. If the designated test account receives a tester invitation,
> accept it. We will coordinate the test after the account subscription and
> Pronto's test-channel setup are ready.

There are two separate subscriptions: the app's selected webhook fields and
the Instagram account's subscription to the app. Meta's [app subscriptions API
reference](https://developers.facebook.com/docs/graph-api/reference/app/subscriptions/)
explicitly excludes Instagram webhook creation; Keith (or an authorized app
administrator) must configure the Instagram callback in the App Dashboard.
After callback configuration,
we can run the latter with the subscription command's authorized request to
`/<instagram-account-id>/subscribed_apps` using the supplied account token;
token permissions must still be accepted by Meta for that operation. This
credential smoke check does not make that request. Follow Meta's [webhook setup
guide](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup)
for the setup-specific host and access requirements. Token-read success does
not establish the app's mode, review status or live-notification eligibility.

The targeted database regression runs through signed Unified Login webhooks,
encrypted channel credentials, durable jobs, the actual worker/agent and a fake
Graph outbox transport. It also checks duplicate ingestion and silence after
human takeover. With the pinned disposable runtime available, run:

```sh
pnpm test:huddle:db --test-file tests/integration/meta-rag-demo.test.ts
```

This harness creates, marks and removes its own PostgreSQL cluster. It does not
use `.env` credentials or any existing database. It performs no live inference
or Meta delivery; those remain separate acceptance steps.

Keith does not need to recreate the app or provide a new token for local code
work. Actual callback values cannot be finalized until the test environment's
public origin and channel UUID are known. End-to-end delivery remains pending
until Meta setup and a controlled test are complete.

**WhatsApp:** Create a Meta developer app, test or approved WhatsApp Business
Account and phone number, and an authorized test recipient. Record the WABA
ID, Phone Number ID, app secret and a scoped token with
`whatsapp_business_messaging`. Subscribe the app to the WABA's `messages`
webhook; managing that subscription requires
`whatsapp_business_management`. Configure an HTTPS callback at
`/api/webhooks/whatsapp/<channelId>` and a per-channel verify token. A Graph
`/messages` response ID proves API acceptance; the matching `delivered` or
`read` status webhook is separate delivery evidence. See Meta's official
[Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api),
[messages reference](https://www.postman.com/meta/whatsapp-business-platform/folder/13382743-ba8d099d-007e-4b52-b9f2-3cf3c60e4fbc),
[webhook subscriptions](https://www.postman.com/meta/whatsapp-business-platform/folder/ozgs3jn/webhook-subscriptions)
and [status payloads](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference).

**Instagram with Facebook Login:** This path uses a linked Page with
an Instagram Professional account. Obtain the Page ID, professional IG User
ID and a Page access token granted by a person with the Page's messaging
task. Meta's official [Page token guide](https://www.postman.com/meta/instagram/request/lpx8lul/get-access-tokens-of-pages-you-manage)
shows how to obtain the linked `instagram_business_account` ID. The
[Instagram Messaging prerequisites](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a)
list `instagram_basic`, `instagram_manage_messages` and
`pages_manage_metadata`, with business verification and Advanced Access for
non-role users. Confirm the exact webhook fields and send endpoint in the
Meta app and with an authorized test account before relying on the channel.
**Instagram with Instagram Login:** The second path needs no Facebook Page.
It requests `instagram_business_basic` and
`instagram_business_manage_messages` from a professional account. Configure
`PRONTO_INSTAGRAM_LOGIN_ENABLED=1`, `INSTAGRAM_LOGIN_CLIENT_ID`,
`INSTAGRAM_LOGIN_CLIENT_SECRET`, `INSTAGRAM_LOGIN_REDIRECT_URI` and a strong
`AUTH_SECRET` in the authorized sandbox. The redirect must equal
`APP_BASE_URL/api/client/instagram-login/callback`; start from the client
channel page. State is signed, expires after ten minutes, and is tied to a
same-site nonce cookie and the authenticated client user. The callback checks
the account identity and professional type and saves the token encrypted in
a **draft** channel. Configure the webhook app secret and per-channel verify
token before health check and publish. Token expiry blocks sends. The
Meta permission grant and send behavior still require authorized sandbox
verification; a profile read alone cannot prove messaging access. Official
[Instagram Login collection](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)
documents the no-Page path and current scopes. A test sender must first
message the professional account;
the current worker only attempts a reply within 24 hours of that provider
event. API acceptance is not proof of delivery to the recipient.

Use a currently supported Graph API version for both products. The code
defaults to `v25.0`; a version string passing local validation does not prove
Meta accepts it. The read-only Graph check below is the first permitted
account-specific version check.

## Isolated read-only checks

Prepare the marked test database and PS.Cafe fixture as documented in the
[demo guide](../demos/ps-cafe-raffles-city.md). Add only test-account credentials
through the operator channel form. Save the Page ID as `pageId`, IG account ID
as `igUserId`, Page token as `pageAccessToken`, app secret as `appSecret`, and
verify token in settings. The channel form encrypts these values. Activate
only the test channels in the disposable database. The WhatsApp fields are
`phoneNumberId`, `accessToken`, `appSecret`, and `verifyToken`.

After exporting identical `DATABASE_URL` and `PRONTO_TEST_DATABASE_URL` values
for the marked test database and setting `PRONTO_SECRETS_KEY`:

```sh
pnpm test:db:verify
pnpm meta:verify inspect <test-channel-uuid>
PRONTO_META_TEST_ACCOUNT=1 PRONTO_META_READ_APPROVED=1 \
  pnpm meta:verify read <test-channel-uuid>
```

`inspect` reads only the isolated database and prints no tokens or customer
content. `read` additionally requires both explicit flags and makes one
read-only Graph request. For WhatsApp it checks that the token resolves to
the configured Phone Number ID. For Instagram with Facebook Login it checks
that the configured Page links to the professional account; with Instagram
Login it checks token identity and professional type. The script rejects an
inactive, plaintext or unconfigured channel and exits nonzero on a failed
provider check. No command above sends a message.

## Controlled conversation test — requires separate send approval

1. Name the exact test sender and recipient accounts, callback host, and
   expected message count. Obtain explicit approval to send the replies.
2. Confirm the test database contains no unrelated pending outbox rows. Start
   the web server and **one** worker against that database, with mock AI and
   the same encryption key. A public HTTPS test callback must reach the local
   route. Keep Chope live reads disabled for this test.
3. Configure the WhatsApp WABA `messages` subscription and Instagram messaging
   webhook using the two channel URLs. Confirm Meta's verification challenge.
4. From each authorized test sender, send “What time do you close?” and then
   “Can I check availability for two tomorrow at 7pm?” The first answer must
   come from the demo tenant's curated knowledge. The second uses the verified
   booking-link fallback while Chope live reads are disabled; it must not
   claim availability or a confirmed booking.
5. Check signed inbound webhook acknowledgement, tenant/channel mapping,
   persisted customer message and job, worker outcome, outbound row and
   provider response ID. Use `pnpm meta:verify report <test-channel-uuid>`
   for content-free aggregate evidence. For WhatsApp, wait for a matching
   `delivered`/`read` status event before recording delivery. For Instagram,
   inspect the authorized test recipient account; this code currently does
   not record an Instagram delivery-status webhook.
6. Test a self-echo and an unsupported attachment, then verify echo filtering
   and human ownership. Release the escalation only through the authorized
   operator transition. Remove or disable the test channels and stop the
   tunnel/worker after the test.

Do not run `pnpm worker`, `pnpm outbox:retry`, or a direct Graph POST merely
to check credentials: those can send queued messages. The read-only command
never substitutes for the controlled inbound and outbound test.
