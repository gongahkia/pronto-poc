import { recordAuditLog } from "@/lib/audit";
import {
  decryptChannelCredentials,
  encryptedChannelCredentialValues,
  protectChannelSettingsSecrets,
} from "@/lib/channels/credentials";
import { runChannelHealthCheck, type ChannelHealthResult } from "@/lib/channels/health";
import { query, transaction } from "@/lib/db";
import { assertChannelActivationEvidence, assertConfigurationApproved, assertOnboardingReadyForChannelActivation } from "@/lib/managed-approvals";
import type { Channel, ChannelKind, ChannelStatus } from "@/lib/types";

export type ChannelDraft = {
  channel_id: string;
  client_id: string;
  base_updated_at: Date;
  status: ChannelStatus;
  external_id: string | null;
  settings: Record<string, unknown>;
  encrypted_credentials: string | null;
  credentials_encryption_nonce: string | null;
  credentials_encryption_tag: string | null;
  health_status: string | null;
  health_detail: string | null;
  checked_at: Date | null;
  updated_at: Date;
};

function exposedDraft(draft: ChannelDraft): ChannelDraft & { credentials: Record<string, unknown> } {
  return decryptChannelCredentials({ ...draft, credentials: {} });
}

export type ChannelField = {
  scope: "credentials" | "settings";
  name: string;
  label: string;
  secret?: boolean;
  options?: string[];
};

export const channelSetupFields: Record<ChannelKind, ChannelField[]> = {
  console: [],
  whatsapp: [
    { scope: "credentials", name: "accessToken", label: "Access token", secret: true },
    { scope: "credentials", name: "phoneNumberId", label: "Phone number ID" },
    { scope: "credentials", name: "appSecret", label: "App secret", secret: true },
    { scope: "settings", name: "verifyToken", label: "Webhook verify token", secret: true },
  ],
  telegram: [
    { scope: "credentials", name: "botToken", label: "Bot token", secret: true },
    { scope: "settings", name: "webhookSecret", label: "Webhook secret", secret: true },
  ],
  messenger: [
    { scope: "credentials", name: "pageAccessToken", label: "Page access token", secret: true },
    { scope: "credentials", name: "pageId", label: "Facebook Page ID" },
    { scope: "credentials", name: "appSecret", label: "App secret", secret: true },
    { scope: "settings", name: "verifyToken", label: "Webhook verify token", secret: true },
  ],
  instagram: [
    { scope: "settings", name: "authMode", label: "Instagram authentication", options: ["facebook_login", "instagram_login", "unified_login"] },
    { scope: "credentials", name: "accessToken", label: "Unified Login access token", secret: true },
    { scope: "credentials", name: "configId", label: "Unified Login configuration ID (optional)" },
    { scope: "credentials", name: "businessId", label: "Unified Login business ID (optional for manual test tokens)" },
    { scope: "credentials", name: "pageAccessToken", label: "Page access token", secret: true },
    { scope: "credentials", name: "instagramAccessToken", label: "Instagram Login token", secret: true },
    { scope: "credentials", name: "tokenExpiresAt", label: "Instagram Login token expiry (ISO date)" },
    { scope: "credentials", name: "appSecret", label: "App secret", secret: true },
    { scope: "credentials", name: "igUserId", label: "Instagram user ID" },
    { scope: "credentials", name: "pageId", label: "Linked Facebook Page ID" },
    { scope: "settings", name: "verifyToken", label: "Webhook verify token", secret: true },
  ],
  email: [
    { scope: "credentials", name: "provider", label: "Email provider", options: ["postmark", "resend", "local_smtp"] },
    { scope: "credentials", name: "apiKey", label: "API key", secret: true },
    { scope: "credentials", name: "fromAddress", label: "Verified sender address" },
    { scope: "settings", name: "webhookSecret", label: "Inbound webhook secret", secret: true },
    { scope: "settings", name: "eventWebhookSecret", label: "Delivery event webhook secret", secret: true },
  ],
};

export async function listChannelDrafts(clientId: string): Promise<ChannelDraft[]> {
  const result = await query<ChannelDraft>(
    "select * from channel_drafts where client_id = $1 order by updated_at desc",
    [clientId],
  );
  return result.rows;
}

export async function saveChannelDraft(input: {
  clientId: string;
  channelId: string;
  actorUserId: string;
  status: ChannelStatus;
  externalId: string | null;
  values: Record<string, string>;
}): Promise<void> {
  const live = await getLiveChannel(input.clientId, input.channelId);
  const existing = await getChannelDraft(input.clientId, input.channelId);
  const current = existing
    ? exposedDraft(existing)
    : live;
  const settings = { ...current.settings };
  const credentials = { ...current.credentials };
  for (const field of channelSetupFields[live.kind]) {
    const key = `${field.scope}.${field.name}`;
    if (!(key in input.values)) continue;
    const value = input.values[key].trim();
    if (value && field.options && !field.options.includes(value))
      throw new Error(`Invalid ${field.label.toLowerCase()} value.`);
    if (field.secret && !value) continue;
    const target = field.scope === "settings" ? settings : credentials;
    if (value) target[field.name] = value;
    else delete target[field.name];
  }
  const protectedValues = protectChannelSettingsSecrets(
    settings,
    credentials,
    channelSetupFields[live.kind]
      .filter((field) => field.scope === "settings" && field.secret)
      .map((field) => field.name),
  );
  const encrypted = encryptedChannelCredentialValues(protectedValues.credentials);
  await query(
    `insert into channel_drafts
     (channel_id, client_id, base_updated_at, status, external_id, settings,
      encrypted_credentials, credentials_encryption_nonce, credentials_encryption_tag, updated_by)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     on conflict (channel_id) do update set
       status = excluded.status, external_id = excluded.external_id,
       settings = excluded.settings,
       encrypted_credentials = excluded.encrypted_credentials,
       credentials_encryption_nonce = excluded.credentials_encryption_nonce,
       credentials_encryption_tag = excluded.credentials_encryption_tag,
       health_status = null, health_detail = null, checked_at = null,
       updated_by = excluded.updated_by, updated_at = now()`,
    [input.channelId, input.clientId, existing?.base_updated_at ?? live.updated_at,
      input.status, input.externalId, JSON.stringify(protectedValues.settings),
      encrypted.encryptedCredentials, encrypted.nonce, encrypted.tag, input.actorUserId],
  );
}

export async function checkChannelDraft(
  clientId: string,
  channelId: string,
): Promise<ChannelHealthResult> {
  const live = await getLiveChannel(clientId, channelId);
  const draft = await getChannelDraft(clientId, channelId);
  if (!draft) throw new Error("Save the channel settings before checking them.");
  const candidate = decryptChannelCredentials({
    ...live,
    status: draft.status,
    external_id: draft.external_id,
    settings: draft.settings,
    credentials: {},
    encrypted_credentials: draft.encrypted_credentials,
    credentials_encryption_nonce: draft.credentials_encryption_nonce,
    credentials_encryption_tag: draft.credentials_encryption_tag,
  });
  const result = await runChannelHealthCheck(candidate);
  await query(
    `update channel_drafts set health_status = $3, health_detail = $4,
       checked_at = now() where channel_id = $1 and client_id = $2`,
    [channelId, clientId, result.status, result.detail],
  );
  return result;
}

export async function publishChannelDraft(input: {
  clientId: string;
  channelId: string;
  actorUserId: string;
}): Promise<void> {
  await transaction(async (db) => {
    const actor = await db.query<{ role: string }>("select role from users where id = $1", [input.actorUserId]);
    if (actor.rows[0]?.role !== "operator") throw new Error("Only a Pronto operator may publish channel settings.");
    const draftResult = await db.query<ChannelDraft>(
      "select * from channel_drafts where channel_id = $1 and client_id = $2 for update",
      [input.channelId, input.clientId],
    );
    const draft = draftResult.rows[0];
    if (!draft) throw new Error("There are no channel changes to publish.");
    const liveResult = await db.query<Channel & { updated_at: Date }>(
      "select * from channels where id = $1 and client_id = $2 for update",
      [input.channelId, input.clientId],
    );
    const live = liveResult.rows[0];
    if (!live) throw new Error("Channel not found.");
    if (new Date(live.updated_at).getTime() !== new Date(draft.base_updated_at).getTime()) {
      throw new Error("This channel changed since the draft was started. Review it before publishing.");
    }
    if (draft.status === "active" && (draft.health_status !== "healthy" || !draft.checked_at)) {
      throw new Error("Run a successful live health check before activating the channel.");
    }
    if (draft.status === "active") {
      const revision = new Date(draft.updated_at).toISOString();
      const candidate = decryptChannelCredentials({ ...live, settings: draft.settings,
        credentials: {}, encrypted_credentials: draft.encrypted_credentials,
        credentials_encryption_nonce: draft.credentials_encryption_nonce,
        credentials_encryption_tag: draft.credentials_encryption_tag });
      const localOnly = live.kind === "email" && (candidate.credentials as Record<string, unknown>).provider === "local_smtp" &&
        process.env.PRONTO_LOCAL_EMAIL_ENABLED === "1" && process.env.NODE_ENV !== "production";
      await assertConfigurationApproved(db, input.clientId, "channel", input.channelId, revision);
      await assertChannelActivationEvidence(db, input.clientId, input.channelId, revision, localOnly);
      await assertOnboardingReadyForChannelActivation(db, input.clientId);
    }
    if (draft.status === "active" && live.kind === "instagram" &&
        draft.settings.authMode === "instagram_login" && process.env.PRONTO_INSTAGRAM_LOGIN_ENABLED !== "1")
      throw new Error("Instagram Login remains disabled until authorized test-account configuration is enabled.");
    if (draft.status === "active" && live.kind === "email" &&
        process.env.PRONTO_LOCAL_EMAIL_ENABLED !== "1") {
      const candidate = decryptChannelCredentials({ ...live, settings: draft.settings,
        credentials: {}, encrypted_credentials: draft.encrypted_credentials,
        credentials_encryption_nonce: draft.credentials_encryption_nonce,
        credentials_encryption_tag: draft.credentials_encryption_tag });
      if ((candidate.credentials as Record<string, unknown>).provider === "local_smtp")
        throw new Error("Local SMTP remains disabled outside the explicit sandbox.");
    }
    await db.query(
      `update channels set status = $3, external_id = $4, settings = $5::jsonb,
       credentials = '{}'::jsonb, encrypted_credentials = $6,
       credentials_encryption_nonce = $7, credentials_encryption_tag = $8,
       updated_at = now() where id = $1 and client_id = $2`,
      [input.channelId, input.clientId, draft.status, draft.external_id,
        JSON.stringify(draft.settings), draft.encrypted_credentials,
        draft.credentials_encryption_nonce, draft.credentials_encryption_tag],
    );
    await db.query("delete from channel_drafts where channel_id = $1 and client_id = $2", [
      input.channelId, input.clientId,
    ]);
    await recordAuditLog({
      clientId: input.clientId, actorUserId: input.actorUserId,
      action: "channel.client_published", targetType: "channel", targetId: input.channelId,
      metadata: { status: draft.status, approvedRevision: draft.status === "active"
        ? new Date(draft.updated_at).toISOString() : null },
    }, db);
  }, { isolationLevel: "serializable", retries: 2 });
}

async function getChannelDraft(clientId: string, channelId: string): Promise<ChannelDraft | null> {
  const result = await query<ChannelDraft>(
    "select * from channel_drafts where client_id = $1 and channel_id = $2",
    [clientId, channelId],
  );
  return result.rows[0] ?? null;
}

async function getLiveChannel(clientId: string, channelId: string): Promise<Channel & { updated_at: Date }> {
  const result = await query<Channel & { updated_at: Date }>(
    "select * from channels where client_id = $1 and id = $2",
    [clientId, channelId],
  );
  if (!result.rows[0]) throw new Error("Channel not found.");
  return decryptChannelCredentials(result.rows[0]);
}
