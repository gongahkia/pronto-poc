# Saved demo businesses

Each demo business has its own client, console channel, published knowledge,
voice, visitors, conversations and analytics. Selecting a business changes which
workspace new demo visitors use; it never renames an old conversation or copies
external credentials. PS.Cafe remains the default when all four identity settings
are omitted.

This is a configuration switch followed by a process restart. There is no public
business selector or zero-downtime switching endpoint. The existing protected
database boundary, named operator requirement, model approvals and publication
workflow remain in force. Ordinary deployments do not gain public demo access.

## Prepare a separate workspace

Use Node 24 and the repository's pinned pnpm. Copy
`config/demo-businesses/example-business.json` to a new profile. Replace its
fictional name, presentation, voice and source facts. Generate distinct UUIDs for
the client, console channel and every knowledge source (`uuidgen` on macOS).
Choose a distinct slug and seed. A logo is optional; supplied logos must be a
local file under `public/brands/`, referenced as `/brands/filename.webp` (or a
supported image extension). A new logo asset requires deployment; changing an
already deployed business does not require rebuilding.

Profiles contain public or synthetic demo facts, never tokens, passwords or
provider keys. Unofficial demo status is required. `policy_conflict_withheld`
sources remain stored but cannot be retrieved for answers. Preparing a workspace
does not enable bookings, payments, live availability or a real channel.

Preview without database access or provider calls:

```sh
pnpm demo:business plan --profile config/demo-businesses/my-business.json
```

Review the facts, voice and printed SHA-256. With the existing **verified demo**
database and server environment loaded, use an existing named operator UUID:

```sh
pnpm demo:business prepare --profile config/demo-businesses/my-business.json \
  --actor-id OPERATOR_UUID --profile-hash EXACT_HASH_FROM_PLAN
pnpm demo:business list --actor-id OPERATOR_UUID
```

Apply migration **062** using `pnpm migrate` before preparing a new business.
It adds verified enrollment for saved demo text knowledge, retaining the
ordinary-tenant and Instagram test database checks. Never run `seed`, fixture
setup/removal or reset commands against the hosted database.

Preparation is transactional and idempotent. An identity collision fails instead
of adopting another tenant. Repeating the same prepared profile preserves existing
settings, conversations and subsequently reviewed edits. An edited profile cannot
overwrite an already prepared workspace; use Business Knowledge and its existing
approval/publication flow for subsequent source or voice changes. The original
PS.Cafe profile is also available at `config/demo-businesses/ps-cafe.json`;
preparing an existing PS.Cafe workspace preserves its deployed voice and facts.

## Activate, or switch back

Pause new testing and stop any separate worker before switching. Allow requests
and external deliveries to finish. Keep ingress paused until the restart is
verified. The activation check is a snapshot, not a lock on other processes;
rerun it immediately before applying the configuration.

```sh
pnpm demo:business activation-plan --profile config/demo-businesses/my-business.json \
  --actor-id OPERATOR_UUID --detach-instagram --env-out output/my-business.env
```

This validates the prepared identity, console, available knowledge and publication
provenance. Pending, processing, failed or ambiguous deliveries on the current
business block a switch; reconcile them deliberately. Terminal stopped jobs and
history are retained. The command prints the activation plan and creates a
mode-600 environment file without overwriting an existing file. It does **not**
modify the running application or service environment.

Apply all four printed `PRONTO_DEMO_CLIENT_ID`, `PRONTO_DEMO_CHANNEL_ID`,
`PRONTO_DEMO_SLUG` and `PRONTO_DEMO_SEED` values together in the existing service
configuration and restart the web process and any worker. Partial settings fail
closed. Keep the database, authentication secret and encryption key unchanged.
On Render, update the existing public demo service; do not provision a new service.

`--detach-instagram` explicitly sets `PRONTO_DEMO_INSTAGRAM_ENABLED=0` in the plan
when moving away from an Instagram-enabled business. The stored channel,
credentials and Instagram history remain with their original business. Leave its
existing account/channel/tester environment values intact as historical scope.
Moving Instagram to another business requires its own reviewed channel binding;
never change a channel's `client_id` or copy its credentials as part of this switch.
The separate ingress relay needs no change for a console-only switch; delivery to
the disabled binding is rejected by the existing scope check.

Run `pnpm demo:protected preflight` with the newly selected hosted environment,
then check `/api/readiness`, `/status` and the demo chooser. Saved workspaces must
all remain within the verified synthetic boundary. An existing stopped job can
keep aggregate status degraded and must not be hidden by deleting history.
Resume testing only after confirming the deployed revision and selected business.

Sign out and re-enter the demo to create a visitor in the selected business.
Existing sessions stay owned by their original business; they cannot send chat
messages using the newly selected business's knowledge. Old business inboxes
retain history and branding, with customer replies paused while inactive.

To switch back, produce an activation plan from the original saved profile and
apply its four settings, then restart and verify again. If re-enabling Instagram,
explicitly restore its existing approved binding and verify readiness before
resuming DMs. No conversations need to be moved, deleted or reseeded.

## Verification

`tests/integration/demo-business.test.ts` exercises preparation, identity
collisions, preservation, A → B → A history isolation, tenant-specific retrieval,
durable console delivery with a canned model, activation checks and Instagram
detachment on a newly marked disposable database. This is separate from genuine
Groq acceptance and Meta delivery testing.
