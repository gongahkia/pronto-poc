import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { query, transaction, type Queryable } from "@/lib/db";
import { recordAuditLog } from "@/lib/audit";
import { metaGraphVersion } from "@/lib/env";
import { decryptChannelCredentials, usesLegacyPlaintextCredentials } from "./credentials";
import { instagramProbeConfig } from "./instagram-probe";
import { requestInstagramGraph } from "./instagram-graph";
import { sendInstagramText } from "./instagram";
import { ProviderSendError } from "./provider-error";
import type { Channel } from "@/lib/types";

export const instagramProbeReplyText = "Pronto connection test: your message reached our test server. This is a test acknowledgement; AI replies are not enabled yet.";
export const instagramProbeReplyPlan = z.object({
  clientId: z.uuid(), channelId: z.uuid(), probeId: z.uuid(), receiptId: z.uuid(),
  databaseMarker: z.string().regex(/^pronto:instagram-hosted:v1:[0-9a-f-]{36}$/),
  accountId: z.string().regex(/^\d+$/), expectedUsername: z.string().regex(/^[a-zA-Z0-9_.]{1,30}$/),
}).strict();
type Plan = z.infer<typeof instagramProbeReplyPlan>;
type Receipt = { id: string; metadata: Record<string, unknown> };

async function checkDatabase(db: Queryable, plan: Plan) {
  const { rows: [row] } = await db.query<{ marker: string }>(
    "select shobj_description(oid,'pg_database') as marker from pg_database where datname=current_database()");
  if (row?.marker !== plan.databaseMarker) throw new Error("Database marker mismatch; no send attempted.");
}

async function readProbe(db: Queryable, plan: Plan, lock = false) {
  const { rows: [stored] } = await db.query<Channel>(
    "select * from channels where id=$1 and client_id=$2" + (lock ? " for update" : ""), [plan.channelId, plan.clientId]);
  if (!stored?.encrypted_credentials || usesLegacyPlaintextCredentials(stored)) throw new Error("Encrypted channel required.");
  const probe = instagramProbeConfig(stored);
  const channel = decryptChannelCredentials(stored);
  if (!probe || probe.id !== plan.probeId || channel.credentials.igUserId !== plan.accountId ||
      channel.external_id !== plan.accountId || typeof channel.credentials.accessToken !== "string" || !channel.credentials.accessToken)
    throw new Error("Current draft probe/account is unavailable or expired.");
  const { rows: [receipt] } = await db.query<Receipt>(
    `select id,metadata from audit_logs where id=$1 and client_id=$2 and target_id=$3
     and action='instagram.probe_received' and metadata->>'probeId'=$4`,
    [plan.receiptId, plan.clientId, plan.channelId, plan.probeId]);
  const metadata = receipt?.metadata;
  const occurred = typeof metadata?.providerOccurredAt === "string" ? Date.parse(metadata.providerOccurredAt) : NaN;
  if (!metadata || metadata.signatureVerified !== true || metadata.textHash !== probe.nonceHash ||
      typeof metadata.senderId !== "string" || !/^\d+$/.test(metadata.senderId) || metadata.senderId === plan.accountId ||
      !Number.isFinite(occurred) || occurred < Date.parse(probe.startedAt) ||
      occurred > Date.now() + 60000 || Date.now() - occurred >= 24 * 3600000)
    throw new Error("A recent signed receipt from a separate sender is required.");
  const prior = await db.query(
    `select id from audit_logs where client_id=$1 and target_id=$2
     and action='instagram.probe_reply_started' and metadata->>'probeId'=$3 limit 1`,
    [plan.clientId, plan.channelId, plan.probeId]);
  if (prior.rows.length) throw new Error("A reply was already attempted; reconcile its outcome without resending.");
  return { channel, senderId: metadata.senderId, nonceHash: probe.nonceHash };
}

// Operator CLI only: this diagnostic never activates a channel, starts inference,
// or enables ordinary draft-channel delivery. A committed claim survives crashes.
export async function runInstagramProbeReply(rawPlan: unknown, send = false) {
  const plan = instagramProbeReplyPlan.parse(rawPlan);
  if (send && process.env.PRONTO_META_PROBE_REPLY_APPROVED !== "1") throw new Error("Explicit probe-reply approval required.");
  await checkDatabase({ query }, plan);
  const initial = await readProbe({ query }, plan);
  const profile = await requestInstagramGraph({ version: metaGraphVersion(), path: initial.senderId,
    token: initial.channel.credentials.accessToken as string, query: { fields: "id,username" } });
  if (!profile.ok || profile.body.id !== initial.senderId || typeof profile.body.username !== "string" ||
      profile.body.username.toLowerCase() !== plan.expectedUsername.toLowerCase())
    throw new Error("Meta could not confirm the planned recipient; no send attempted.");
  if (!send) return { status: "ready", recipient: "@" + plan.expectedUsername, text: instagramProbeReplyText,
    expiresAt: instagramProbeConfig(initial.channel)!.expiresAt, sendAttempted: false };

  const attemptId = randomUUID();
  const audit = (action: string, metadata: Record<string, unknown>, db?: Queryable) => recordAuditLog({
    clientId: plan.clientId, actorUserId: null, targetType: "channel", targetId: plan.channelId, action,
    metadata: { probeId: plan.probeId, receiptId: plan.receiptId, attemptId, ...metadata },
  }, db);
  const current = await transaction(async db => {
    await checkDatabase(db, plan);
    const live = await readProbe(db, plan, true);
    if (live.channel.encrypted_credentials !== initial.channel.encrypted_credentials ||
        live.channel.credentials_encryption_nonce !== initial.channel.credentials_encryption_nonce ||
        live.channel.credentials_encryption_tag !== initial.channel.credentials_encryption_tag ||
        live.senderId !== initial.senderId || live.nonceHash !== initial.nonceHash)
      throw new Error("Probe changed during recipient verification; no send attempted.");
    await audit("instagram.probe_reply_started", { senderId: live.senderId,
      textHash: createHash("sha256").update(instagramProbeReplyText).digest("hex"),
      approved: true, automatedReplyEnabled: false }, db);
    return live;
  });

  let providerMessageId: string;
  try {
    // Exactly one invocation after the claim commits; never retry an ambiguous send.
    providerMessageId = await sendInstagramText({ channel: current.channel,
      externalThreadId: current.senderId, text: instagramProbeReplyText });
  } catch (error) {
    const rejected = error instanceof ProviderSendError && !error.ambiguous;
    const status = rejected ? "rejected" : "uncertain";
    try { await audit("instagram.probe_reply_" + status, {
      ...(error instanceof ProviderSendError ? { httpStatus: error.statusCode, providerCode: error.providerCode } : {}),
    }); } catch { /* the committed starter still blocks repeat sends */ }
    return { status, sendAttempted: true, retryAllowed: false, deliveryObserved: false };
  }
  try { await audit("instagram.probe_reply_accepted", { providerMessageId, deliveryObserved: false }); }
  catch { return { status: "uncertain", sendAttempted: true, retryAllowed: false, deliveryObserved: false }; }
  return { status: "accepted", sendAttempted: true, retryAllowed: false, deliveryObserved: false };
}
