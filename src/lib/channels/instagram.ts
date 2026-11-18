import { createHmac, timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";
import { decryptChannelCredentials, usesLegacyPlaintextCredentials } from "@/lib/channels/credentials";
import { fetchWithTimeout } from "@/lib/http/fetch";
import { AmbiguousProviderAcceptanceError, ProviderSendError } from "@/lib/channels/provider-error";
import { metaGraphVersion } from "@/lib/env";
import type { NormalizedInboundMessage } from "@/lib/channels/types";
import type { Channel } from "@/lib/types";

export function verifyInstagramSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined,
): boolean {
  if (!appSecret) {
    return false;
  }
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  return (
    expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)
  );
}

export function instagramPayloadMatchesChannel(payload: Record<string, unknown>, igUserId: string): boolean {
  if (payload.object !== "instagram" || !igUserId) return false;
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  if (!entries.length) return false;
  return entries.every((entry) => isRecord(entry) && entry.id === igUserId &&
    (Array.isArray(entry.messaging) ? entry.messaging.every((event) =>
      !isRecord(event) || !isRecord(event.recipient) || event.recipient.id === igUserId) : true));
}

export function normalizeInstagramPayload(
  channelId: string,
  payload: Record<string, unknown>,
): NormalizedInboundMessage[] {
  const messages: NormalizedInboundMessage[] = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of messaging) {
      if (!isRecord(event) || !isRecord(event.message) || !isRecord(event.sender)) continue;
      const message = event.message;
      const sender = event.sender;
      if (typeof sender.id !== "string" || typeof message.mid !== "string") continue;
      if (message.is_echo === true) continue;
      if (isRecord(event.recipient) && sender.id === event.recipient.id) continue;

      const text = typeof message.text === "string" ? message.text : null;
      const unsupportedMediaType = text ? undefined : instagramUnsupportedType(message);
      if (!text && !unsupportedMediaType) continue;

      messages.push({
        channelId,
        channelKind: "instagram",
        externalMessageId: message.mid,
        externalThreadId: sender.id,
        customerHandle: sender.id,
        ...(typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
          ? { occurredAt: new Date(event.timestamp < 1_000_000_000_000
              ? event.timestamp * 1000 : event.timestamp).toISOString() } : {}),
        text: text ?? `[Unsupported Instagram ${unsupportedMediaType} message]`,
        unsupportedMediaType,
        raw: event,
      });
    }
  }
  return messages;
}

function instagramUnsupportedType(message: Record<string, unknown>): string | undefined {
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const first = message.attachments[0];
    if (isRecord(first) && typeof first.type === "string") return first.type;
    return "attachment";
  }
  if (isRecord(message.reaction)) return "reaction";
  if (isRecord(message.story_mention)) return "story_mention";
  return undefined;
}

export async function sendInstagramText(input: {
  channel: Channel;
  externalThreadId: string;
  text: string;
}): Promise<string> {
  if (input.channel.settings.authMode && !["facebook_login", "instagram_login", "unified_login"].includes(String(input.channel.settings.authMode)))
    throw new Error("Unsupported Instagram login mode.");
  const direct = input.channel.settings.authMode === "instagram_login";
  const unified = input.channel.settings.authMode === "unified_login";
  if (direct && process.env.PRONTO_INSTAGRAM_LOGIN_ENABLED !== "1")
    throw new Error("Instagram Login is disabled until authorized test-account configuration is enabled.");
  const token = input.channel.credentials[unified ? "accessToken" : direct ? "instagramAccessToken" : "pageAccessToken"] as string | undefined;
  const igUserId =
    (input.channel.credentials.igUserId as string | undefined) ??
    input.channel.external_id;
  if (!token || !igUserId) {
    throw new Error("Instagram scoped token or IG user ID missing; outbound send skipped.");
  }
  if (direct && isInstagramTokenExpired(input.channel)) {
    throw new ProviderSendError("Instagram expired token", 401);
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(
    `https://${direct ? "graph.instagram.com" : "graph.facebook.com"}/${metaGraphVersion()}/${igUserId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: input.externalThreadId },
        message: { text: input.text },
      }),
    },
    channelFetchTimeoutMs(),
    );
  } catch {
    throw new AmbiguousProviderAcceptanceError("Instagram");
  }

  if (!response.ok) {
    throw new ProviderSendError("Instagram", response.status);
  }
  let body: { message_id?: unknown };
  try {
    body = (await response.json()) as { message_id?: unknown };
  } catch {
    throw new AmbiguousProviderAcceptanceError("Instagram");
  }
  if (typeof body.message_id !== "string") throw new AmbiguousProviderAcceptanceError("Instagram");
  return body.message_id;
}

export function isInstagramTokenExpired(channel: Channel, now = Date.now()): boolean {
  if (channel.settings.authMode !== "instagram_login") return false;
  const expiry = channel.credentials.tokenExpiresAt;
  return typeof expiry !== "string" || !Number.isFinite(Date.parse(expiry)) ||
    Date.parse(expiry) <= now;
}

function channelFetchTimeoutMs(): number {
  return Number(process.env.PRONTO_CHANNEL_FETCH_TIMEOUT_MS ?? 10_000);
}

export async function getInstagramChannel(channelId: string): Promise<Channel | null> {
  const result = await query<Channel>(
    "select * from channels where id = $1 and kind = 'instagram'",
    [channelId],
  );
  const row = result.rows[0];
  if (!row || usesLegacyPlaintextCredentials(row) ||
      (row.settings.authMode === "instagram_login" && process.env.PRONTO_INSTAGRAM_LOGIN_ENABLED !== "1")) return null;
  return decryptChannelCredentials(row);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
