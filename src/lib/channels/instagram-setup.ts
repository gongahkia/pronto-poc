import { randomBytes } from "node:crypto";
import { checkInstagramTestCredentials } from "./instagram-smoke";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type InstagramConnection = {
  schema: "pronto.instagram-test.v1"; appId: string; accountId: string;
  clientId: string; channelId: string; callbackUrl: string; verifyToken: string;
};

export function validateInstagramConnection(value: unknown): InstagramConnection {
  if (!value || typeof value !== "object") throw new Error("Invalid Instagram setup file.");
  const item = value as InstagramConnection;
  if (item.schema !== "pronto.instagram-test.v1" || !/^\d+$/.test(item.appId ?? "") || !/^\d+$/.test(item.accountId ?? "") ||
    !uuid.test(item.clientId ?? "") || !uuid.test(item.channelId ?? "") ||
    typeof item.verifyToken !== "string" || !/^[a-zA-Z0-9_-]{32,128}$/.test(item.verifyToken))
    throw new Error("Invalid Instagram setup identity or verify token.");
  let callback: URL;
  try { callback = new URL(item.callbackUrl); } catch { throw new Error("Invalid Instagram callback URL."); }
  if (callback.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash ||
    callback.pathname !== `/api/webhooks/instagram/${item.channelId}`)
    throw new Error("Use a public HTTPS callback with the exact channel path, without credentials or query parameters.");
  return item;
}

export async function prepareInstagramSetup(env: Record<string, string | undefined>, input: {
  clientId: string; channelId: string; callbackOrigin: string;
}) {
  if ((await checkInstagramTestCredentials(env)).status !== "configured")
    throw new Error("Instagram environment is incomplete. Run pnpm instagram:smoke for field names.");
  let origin: URL;
  try { origin = new URL(input.callbackOrigin); } catch { throw new Error("Invalid callback origin."); }
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password)
    throw new Error("Callback origin must not contain a path, credentials or query parameters.");
  const connection = validateInstagramConnection({ schema: "pronto.instagram-test.v1",
    appId: env.PRONTO_INSTAGRAM_TEST_APP_ID!.trim(), accountId: env.PRONTO_INSTAGRAM_TEST_ACCOUNT_ID!.trim(),
    clientId: input.clientId, channelId: input.channelId,
    callbackUrl: `${origin.origin}/api/webhooks/instagram/${input.channelId}`,
    verifyToken: randomBytes(32).toString("base64url"),
  });
  const form: Record<string, string> = {
    clientId: connection.clientId, channelId: connection.channelId, status: "draft", externalId: connection.accountId,
    "settings.authMode": "unified_login", "settings.verifyToken": connection.verifyToken,
    "credentials.accessToken": env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN!.trim(),
    "credentials.appSecret": env.PRONTO_INSTAGRAM_TEST_APP_SECRET!.trim(), "credentials.igUserId": connection.accountId,
  };
  for (const [key, field] of [["PRONTO_INSTAGRAM_TEST_CONFIG_ID", "configId"], ["PRONTO_INSTAGRAM_TEST_BUSINESS_ID", "businessId"]]) {
    if (env[key]?.trim()) form[`credentials.${field}`] = env[key]!.trim();
  }
  const handoff = `Keith / Meta app administrator:\n\nIn the existing Meta app's API setup with Unified login, open Configure webhooks.\nCallback URL: ${connection.callbackUrl}\nVerify token: ${connection.verifyToken}\nVerify and save, then select messages for the initial text-DM test. Preserve other existing subscriptions.\nConfirm the app's mode, account/tester access and any review errors.\nWe handle the separate account subscription. Coordinate the first DM with us.\n\nThis file contains a private verification token. It does not contain the access token or app secret.\n`;
  return { connection, form, handoff };
}
