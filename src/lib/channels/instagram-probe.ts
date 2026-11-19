import { createHash, timingSafeEqual } from "node:crypto";
import { transaction } from "@/lib/db";
import { recordAuditLog } from "@/lib/audit";
import { decryptChannelCredentials, usesLegacyPlaintextCredentials } from "./credentials";
import { instagramPayloadMatchesChannel, normalizeInstagramPayload, verifyInstagramSignature } from "./instagram";
import type { Channel } from "@/lib/types";

export type InstagramProbe = { id: string; nonceHash: string; startedAt: string; expiresAt: string };
const maximumWindowMs = 2 * 60 * 60 * 1000;

export function instagramProbeConfig(channel: Channel, now = Date.now()): InstagramProbe | null {
  if (process.env.PRONTO_HOSTED_INSTAGRAM !== "1" || process.env.PRONTO_DEPLOYMENT_PROFILE !== "standard" ||
      process.env.PRONTO_HOSTED_INSTAGRAM_WORKER !== "0" || channel.kind !== "instagram" ||
      channel.status !== "draft" || channel.settings.authMode !== "unified_login") return null;
  const probe = channel.settings.instagramProbe as InstagramProbe | undefined;
  if (!probe || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(probe.id ?? "") ||
      !/^[0-9a-f]{64}$/.test(probe.nonceHash ?? "") || typeof probe.startedAt !== "string" || typeof probe.expiresAt !== "string") return null;
  const start = Date.parse(probe.startedAt), end = Date.parse(probe.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > now || end <= now ||
      end <= start || end - start > maximumWindowMs) return null;
  return probe;
}

export function matchesInstagramProbe(text: string, probe: InstagramProbe): boolean {
  if (!/^pronto-test [A-Za-z0-9_-]{32,128}$/.test(text) || !/^[0-9a-f]{64}$/.test(probe.nonceHash)) return false;
  return timingSafeEqual(createHash("sha256").update(text).digest(), Buffer.from(probe.nonceHash, "hex"));
}

// record transport evidence only. draft channels still cannot create queue jobs
// or send replies; normal activation and its business approvals remain required.
export async function recordInstagramProbe(input: {
  channel: Channel; rawBody: string; signature: string | null;
}): Promise<{ duplicate: boolean } | null> {
  const probe = instagramProbeConfig(input.channel);
  if (!probe) return null;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(input.rawBody); } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const matches = normalizeInstagramPayload(input.channel.id, payload).filter(message => matchesInstagramProbe(message.text, probe));
  if (!matches.length || new Set(matches.map(message => message.externalThreadId)).size !== 1) return null;
  const message = matches[0];
  return transaction(async db => {
    const { rows: [stored] } = await db.query<Channel>(
      "select * from channels where id=$1 and client_id=$2 for update", [input.channel.id, input.channel.client_id]);
    if (!stored || !stored.encrypted_credentials || usesLegacyPlaintextCredentials(stored)) return null;
    const liveProbe = instagramProbeConfig(stored);
    if (!liveProbe || liveProbe.id !== probe.id || liveProbe.nonceHash !== probe.nonceHash) return null;
    const live = decryptChannelCredentials(stored);
    const account = live.credentials.igUserId ?? live.external_id;
    // recheck the current credentials/account after the lock, so a concurrent
    // disable, reconfiguration or credential rotation closes an in-flight probe.
    if (typeof account !== "string" || typeof live.credentials.appSecret !== "string" ||
        !verifyInstagramSignature(input.rawBody, input.signature, live.credentials.appSecret) ||
        !instagramPayloadMatchesChannel(payload, account)) return null;
    const prior = await db.query<{ metadata: Record<string, unknown> }>(
      `select metadata from audit_logs where client_id=$1 and target_id=$2
       and action='instagram.probe_received' and metadata->>'probeId'=$3 limit 1`,
      [live.client_id, live.id, probe.id]);
    if (prior.rows[0]) return prior.rows[0].metadata.senderId === message.externalThreadId ? { duplicate: true } : null;
    await recordAuditLog({ clientId: live.client_id, actorUserId: null,
      action: "instagram.probe_received", targetType: "channel", targetId: live.id,
      metadata: { probeId: probe.id, providerMessageId: message.externalMessageId,
        senderId: message.externalThreadId, receivedAt: new Date().toISOString(),
        providerOccurredAt: message.occurredAt ?? null, textHash: probe.nonceHash,
        signatureVerified: true, automatedReplyEnabled: false } }, db);
    return { duplicate: false };
  });
}
