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
