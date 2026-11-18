# Channel Webhook Setup

For the isolated Meta test-account sequence and evidence levels, see
[Meta sandbox activation](meta-sandbox-verification.md).

## Local HTTPS Tunnel

Run the app locally and expose it with an HTTPS tunnel:

```bash
pnpm dev
ngrok http 3000
```

Use the HTTPS forwarding URL as `APP_BASE_URL` for local channel testing.
Use only an authorized sandbox or test account. The webhook route requires an
active channel and encrypted channel credentials. Start `pnpm worker` against
the same migrated database; the webhook itself only stores a durable job.

## WhatsApp Cloud API

Webhook URL:

```text
https://<public-host>/api/webhooks/whatsapp/<channelId>
```

Verification:

- Meta sends `hub.mode`, `hub.verify_token`, and `hub.challenge`.
- Pronto compares `hub.verify_token` against that channel's encrypted `verifyToken` setting.
- On success, Pronto returns `hub.challenge`.

Inbound security:

- Pronto verifies `X-Hub-Signature-256` with that channel's encrypted `appSecret` credential.

Outbound send:

- The worker sends text replies through Graph `/messages` while the customer
  service window is open; approved templates use the template payload.
- Required channel credential fields are `accessToken` and `phoneNumberId`.

Delivery status callbacks update matching outbound rows and never enter the
agent. Stale in-flight sends require manual reconciliation.

## Instagram Direct Messages

Webhook URL:

```text
https://<public-host>/api/webhooks/instagram/<channelId>
```

Select the authentication mode for the professional account:

- `unified_login`: a manually provisioned Unified Login token in
  `credentials.accessToken`, Instagram account ID, app secret and verify token.
  Uses `graph.facebook.com`; no linked Facebook Page is required.
- `facebook_login`: a linked Page access token, linked Page ID, Instagram account
  ID, app secret and verify token. Uses `graph.facebook.com`.
- `instagram_login`: the existing opt-in Instagram Login OAuth flow, with an
  Instagram User token and verified expiry. Uses `graph.instagram.com`.

Personal business-side accounts are unsupported. The route validates the
signature and account mapping, ignores echo events, and persists customer DMs
for the shared worker. Outbound replies use the same tenant's professional
account and the customer sender ID. Use the [credential smoke check and sandbox
guide](meta-sandbox-verification.md) before a controlled real-account test.
Webhook verification and account/event subscriptions are separate setup steps;
the smoke check does not perform them or activate the channel.

## Telegram

Webhook URL:

```text
https://<public-host>/api/webhooks/telegram/<channelId>
```

Register webhook:

```bash
curl "https://api.telegram.org/bot<bot-token>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<public-host>/api/webhooks/telegram/<channelId>",
    "secret_token": "<webhook-secret>"
  }'
```

Inbound security:

- Telegram sends `X-Telegram-Bot-Api-Secret-Token`.
- Pronto compares the header against channel setting `webhookSecret`, then `TELEGRAM_WEBHOOK_SECRET`.

Outbound send:

- Pronto sends replies with `sendMessage`.
- Required channel credential field is `botToken`.
