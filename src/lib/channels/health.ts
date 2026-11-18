import { query } from "@/lib/db";
import { decryptChannelCredentials } from "@/lib/channels/credentials";
import { isInstagramTokenExpired } from "@/lib/channels/instagram";
import { isSupportedMetaGraphVersion, metaGraphVersion, whatsAppGraphVersion } from "@/lib/env";
import { fetchWithTimeout } from "@/lib/http/fetch";
import type { Channel } from "@/lib/types";

export type ChannelHealthStatus = "healthy" | "degraded" | "unconfigured";

export type ChannelHealthResult = {
  status: ChannelHealthStatus;
  detail: string;
  checkedLive: boolean;
};

export async function checkChannelHealth(channelId: string): Promise<ChannelHealthResult> {
  const result = await query<Channel>("select * from channels where id = $1", [
    channelId,
  ]);
  const channel = result.rows[0]
    ? decryptChannelCredentials(result.rows[0])
    : undefined;
  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  const health = await runChannelHealthCheck(channel);
  await query(
    `
      update channels
      set last_health_check_at = now(),
          last_health_status = $2,
          last_health_error = $3,
          updated_at = now()
      where id = $1
    `,
    [channel.id, health.status, health.status === "healthy" ? null : health.detail],
  );

  return health;
}

export async function runChannelHealthCheck(
  channel: Channel,
): Promise<ChannelHealthResult> {
  const configIssue = validateChannelHealthConfig(channel);
  if (configIssue) {
    return { status: "unconfigured", detail: configIssue, checkedLive: false };
  }

  if (process.env.PRONTO_SKIP_LIVE_HEALTH === "1") {
    return {
      status: "degraded",
      detail: "Live health check skipped by PRONTO_SKIP_LIVE_HEALTH=1.",
      checkedLive: false,
    };
  }

  if (channel.kind === "telegram") {
    return checkTelegramHealth(channel);
  }

  if (channel.kind === "whatsapp") {
    return checkWhatsAppHealth(channel);
  }

  if (channel.kind === "instagram") {
    return checkInstagramHealth(channel);
  }

  if (channel.kind === "messenger") {
    return checkMetaPlatformHealth(channel);
  }

  if (channel.kind === "email") {
    return checkEmailHealth(channel);
  }

  return { status: "unconfigured", detail: "Unsupported channel kind.", checkedLive: false };
}

export function validateChannelHealthConfig(channel: Channel): string | null {
  if (channel.kind === "telegram") {
    const token =
      (channel.credentials.botToken as string | undefined) ??
      process.env.TELEGRAM_BOT_TOKEN;
    const secret =
      (channel.settings.webhookSecret as string | undefined) ??
      process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!token) {
      return "Telegram bot token is missing.";
    }
    if (!secret) {
      return "Telegram webhook secret is missing.";
    }
    return null;
  }

  if (channel.kind === "whatsapp") {
    if (!isSupportedMetaGraphVersion(whatsAppGraphVersion())) return "WhatsApp Graph API version is expired or invalid.";
    const token = channel.credentials.accessToken as string | undefined;
    const phoneNumberId =
      (channel.credentials.phoneNumberId as string | undefined) ?? channel.external_id;
    const verifyToken = channel.settings.verifyToken as string | undefined;
    const appSecret = channel.credentials.appSecret as string | undefined;
    if (!token) {
      return "WhatsApp access token is missing.";
    }
    if (!phoneNumberId) {
      return "WhatsApp phone number ID is missing.";
    }
    if (!verifyToken) {
      return "WhatsApp webhook verify token is missing.";
    }
    if (!appSecret) {
      return "WhatsApp app secret is missing.";
    }
    return null;
  }

  if (channel.kind === "messenger") {
    if (!isSupportedMetaGraphVersion(metaGraphVersion())) return "Messenger Graph API version is expired or invalid.";
    const token = channel.credentials.pageAccessToken as string | undefined;
    const appSecret = channel.credentials.appSecret as string | undefined;
    const verifyToken = channel.settings.verifyToken as string | undefined;
    const pageId = (channel.credentials.pageId as string | undefined) ?? channel.external_id;
    if (!token) return "Messenger page access token is missing.";
    if (!pageId) return "Messenger Page ID is missing.";
    if (!appSecret) return "Messenger app secret is missing.";
    if (!verifyToken) return "Messenger webhook verify token is missing.";
    return null;
  }

  if (channel.kind === "instagram") {
    if (channel.settings.authMode && !["facebook_login", "instagram_login", "unified_login"].includes(String(channel.settings.authMode)))
      return "Unsupported Instagram login mode.";
    if (!isSupportedMetaGraphVersion(metaGraphVersion())) return "Instagram Graph API version is expired or invalid.";
    const direct = channel.settings.authMode === "instagram_login";
    const unified = channel.settings.authMode === "unified_login";
    if (direct && process.env.PRONTO_INSTAGRAM_LOGIN_ENABLED !== "1") return "Instagram Login is disabled pending test-account authorization.";
    const token = channel.credentials[unified ? "accessToken" : direct ? "instagramAccessToken" : "pageAccessToken"] as string | undefined;
    const appSecret = channel.credentials.appSecret as string | undefined;
    const verifyToken = channel.settings.verifyToken as string | undefined;
    const igUserId =
      (channel.credentials.igUserId as string | undefined) ?? channel.external_id;
    const pageId = channel.credentials.pageId as string | undefined;
    if (!token) return "Instagram scoped access token is missing.";
    if (direct && isInstagramTokenExpired(channel)) return "Instagram Login token has expired or has no verified expiry.";
    if (!appSecret) return "Instagram app secret is missing.";
    if (!verifyToken) return "Instagram webhook verify token is missing.";
    if (!igUserId) return "Instagram user ID is missing.";
    if (!direct && !unified && !pageId) return "Instagram linked Page ID is missing.";
    return null;
  }

  if (channel.kind === "email") {
    const provider =
      (channel.credentials.provider as string | undefined) ?? "postmark";
    if (!["postmark", "resend", "local_smtp"].includes(provider)) return "Unsupported email provider.";
    const apiKey =
      (channel.credentials.apiKey as string | undefined) ??
      (provider === "postmark"
        ? process.env.POSTMARK_API_TOKEN
        : process.env.RESEND_API_KEY);
    const fromAddress =
      (channel.credentials.fromAddress as string | undefined) ??
      (provider === "postmark"
        ? process.env.POSTMARK_FROM_ADDRESS
        : process.env.RESEND_FROM_ADDRESS);
    if (provider === "local_smtp") {
      if (process.env.NODE_ENV === "production" || process.env.PRONTO_LOCAL_EMAIL_ENABLED !== "1")
        return "Local SMTP sandbox is disabled.";
      if (!fromAddress) return "Local support address is missing.";
      return null;
    }
    if (!apiKey) return `Email ${provider} API key is missing.`;
    if (!fromAddress) return `Email ${provider} from-address is missing.`;
    return null;
  }

  return null;
}

export async function recordOutboundHealth(
  channelId: string,
  clientId: string,
  error?: unknown,
): Promise<void> {
  await query(
    `
      update channels
      set last_outbound_at = now(),
          last_outbound_error = $2,
          updated_at = now()
      where id = $1 and client_id = $3
    `,
    [channelId, error ? errorToMessage(error) : null, clientId],
  );
}

async function checkTelegramHealth(channel: Channel): Promise<ChannelHealthResult> {
  const token =
    (channel.credentials.botToken as string | undefined) ??
    process.env.TELEGRAM_BOT_TOKEN;
  const response = await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/getMe`,
    {},
    channelHealthTimeoutMs(),
  );
  if (!response.ok) {
    return {
      status: "degraded",
      detail: `Telegram getMe failed with HTTP ${response.status}.`,
      checkedLive: true,
    };
  }

  const body = (await response.json()) as { ok?: boolean; description?: string };
  if (!body.ok) {
    return {
      status: "degraded",
      detail: body.description ?? "Telegram getMe returned ok=false.",
      checkedLive: true,
    };
  }

  return { status: "healthy", detail: "Telegram bot credentials are valid.", checkedLive: true };
}

async function checkWhatsAppHealth(channel: Channel): Promise<ChannelHealthResult> {
  const token = channel.credentials.accessToken as string | undefined;
  const phoneNumberId =
    (channel.credentials.phoneNumberId as string | undefined) ?? channel.external_id;
  const response = await fetchWithTimeout(
    `https://graph.facebook.com/${whatsAppGraphVersion()}/${phoneNumberId}?fields=id,display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${token}` } },
    channelHealthTimeoutMs(),
  );
  if (!response.ok) {
    return {
      status: "degraded",
      detail: `WhatsApp phone number check failed with HTTP ${response.status}.`,
      checkedLive: true,
    };
  }

  let body: { id?: unknown };
  try { body = await response.json() as typeof body; }
  catch { return { status: "degraded", detail: "WhatsApp phone number response was invalid.", checkedLive: true }; }
  if (body.id !== phoneNumberId) return { status: "degraded",
    detail: "WhatsApp token does not resolve to the configured phone number ID.", checkedLive: true };

  return {
    status: "healthy",
    detail: "WhatsApp phone number credentials are valid.",
    checkedLive: true,
  };
}

async function checkMetaPlatformHealth(channel: Channel): Promise<ChannelHealthResult> {
  const token = (channel.credentials.pageAccessToken as string | undefined) ??
    (channel.kind === "messenger" ? process.env.MESSENGER_PAGE_ACCESS_TOKEN : undefined);
  const graphVersion = metaGraphVersion();
  const response = await fetchWithTimeout(
    `https://graph.facebook.com/${graphVersion}/me?fields=id,name`,
    { headers: { Authorization: `Bearer ${token}` } },
    channelHealthTimeoutMs(),
  );
  if (!response.ok) {
    return {
      status: "degraded",
      detail: `${channel.kind} Graph /me failed with HTTP ${response.status}.`,
      checkedLive: true,
    };
  }
  let body: { id?: unknown };
  try { body = await response.json() as typeof body; }
  catch { return { status: "degraded", detail: "Messenger Page response was invalid.", checkedLive: true }; }
  if (body.id !== ((channel.credentials.pageId as string | undefined) ?? channel.external_id))
    return { status: "degraded", detail: "Messenger token does not resolve to the configured Page.", checkedLive: true };
  return { status: "healthy", detail: "Messenger Page token and mapping are valid.", checkedLive: true };
}

async function checkInstagramHealth(channel: Channel): Promise<ChannelHealthResult> {
  const direct = channel.settings.authMode === "instagram_login";
  const unified = channel.settings.authMode === "unified_login";
  const token = channel.credentials[unified ? "accessToken" : direct ? "instagramAccessToken" : "pageAccessToken"] as string;
  const pageId = channel.credentials.pageId as string;
  const igUserId = (channel.credentials.igUserId as string | undefined) ?? channel.external_id;
  const response = await fetchWithTimeout(
    unified ? `https://graph.facebook.com/${metaGraphVersion()}/${igUserId}?fields=id,username` :
      direct ? `https://graph.instagram.com/${metaGraphVersion()}/me?fields=id,account_type` :
      `https://graph.facebook.com/${metaGraphVersion()}/${pageId}?fields=id,instagram_business_account`,
    { headers: { Authorization: `Bearer ${token}` } }, channelHealthTimeoutMs(),
  );
  if (!response.ok) return { status: "degraded",
    detail: `Instagram ${unified ? "account" : "linked Page"} check failed with HTTP ${response.status}.`, checkedLive: true };
  let body: { id?: unknown; account_type?: unknown; instagram_business_account?: { id?: unknown } };
  try { body = await response.json() as typeof body; }
  catch { return { status: "degraded", detail: "Instagram account response was invalid.", checkedLive: true }; }
  if (unified) {
    if (body.id !== igUserId) return { status: "degraded",
      detail: "Unified Login token does not resolve to the configured Instagram account.", checkedLive: true };
    return { status: "healthy", detail: "Unified Login token can read the configured Instagram account; messaging permission and delivery need separate verification.", checkedLive: true };
  }
  if (direct) {
    if (body.id !== igUserId || !["BUSINESS", "CREATOR", "MEDIA_CREATOR"].includes(String(body.account_type)))
      return { status: "degraded", detail: "Instagram Login token does not resolve to the configured professional account.", checkedLive: true };
    return { status: "healthy", detail: "Instagram Login token and professional-account identity are valid; messaging permission needs sandbox verification.", checkedLive: true };
  }
  if (body.id !== pageId || body.instagram_business_account?.id !== igUserId) {
    return { status: "degraded", detail: "Instagram linked Page does not match the configured professional account.",
      checkedLive: true };
  }
  return { status: "healthy", detail: "Instagram Page token and professional-account mapping are valid.",
    checkedLive: true };
}

async function checkEmailHealth(channel: Channel): Promise<ChannelHealthResult> {
  const provider =
    (channel.credentials.provider as string | undefined) ?? "postmark";
  if (provider === "local_smtp") {
    const port = Number(process.env.PRONTO_LOCAL_SMTP_PORT ?? 1025);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return {
      status: "unconfigured", detail: "Invalid local SMTP port.", checkedLive: false };
    try {
      const net = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.setTimeout(2000);
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("error", reject);
        socket.once("timeout", () => { socket.destroy(); reject(new Error("timeout")); });
      });
      return { status: "healthy", detail: "Local SMTP sandbox is reachable.", checkedLive: true };
    } catch { return { status: "degraded", detail: "Local SMTP sandbox is unavailable.", checkedLive: true }; }
  }
  const apiKey =
    (channel.credentials.apiKey as string | undefined) ??
    (provider === "postmark"
      ? process.env.POSTMARK_API_TOKEN
      : process.env.RESEND_API_KEY);

  const url =
    provider === "postmark"
      ? "https://api.postmarkapp.com/server"
      : "https://api.resend.com/domains";
  const headers: Record<string, string> =
    provider === "postmark"
      ? { Accept: "application/json", "X-Postmark-Server-Token": apiKey ?? "" }
      : { Authorization: `Bearer ${apiKey ?? ""}` };

  const response = await fetchWithTimeout(url, { headers }, channelHealthTimeoutMs());
  if (!response.ok) {
    return {
      status: "degraded",
      detail: `Email ${provider} health check failed with HTTP ${response.status}.`,
      checkedLive: true,
    };
  }
  return {
    status: "healthy",
    detail: `Email ${provider} credentials are valid.`,
    checkedLive: true,
  };
}

function channelHealthTimeoutMs(): number {
  return Number(process.env.PRONTO_CHANNEL_HEALTH_TIMEOUT_MS ?? 8_000);
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
