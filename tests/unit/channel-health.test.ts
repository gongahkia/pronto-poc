import { afterEach, describe, expect, it, vi } from "vitest";
import { runChannelHealthCheck, validateChannelHealthConfig } from "@/lib/channels/health";
import type { Channel } from "@/lib/types";

const baseChannel: Channel = {
  id: "channel-1",
  client_id: "client-1",
  kind: "telegram",
  name: "Telegram",
  status: "draft",
  external_id: null,
  credentials: {},
  settings: {},
  last_health_check_at: null,
  last_health_status: null,
  last_health_error: null,
  last_outbound_at: null,
  last_outbound_error: null,
};

describe("channel health config validation", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it("requires Telegram token and webhook secret", () => {
    expect(validateChannelHealthConfig(baseChannel)).toBe("Telegram bot token is missing.");
    expect(
      validateChannelHealthConfig({
        ...baseChannel,
        credentials: { botToken: "token" },
      }),
    ).toBe("Telegram webhook secret is missing.");
    expect(
      validateChannelHealthConfig({
        ...baseChannel,
        credentials: { botToken: "token" },
        settings: { webhookSecret: "secret" },
      }),
    ).toBeNull();
  });

  it("requires WhatsApp credentials and secrets", () => {
    const whatsapp: Channel = {
      ...baseChannel,
      kind: "whatsapp",
      name: "WhatsApp",
    };

    expect(validateChannelHealthConfig(whatsapp)).toBe("WhatsApp access token is missing.");
    expect(
      validateChannelHealthConfig({
        ...whatsapp,
        credentials: { accessToken: "token", phoneNumberId: "phone", appSecret: "secret" },
        settings: { verifyToken: "verify" },
      }),
    ).toBeNull();
  });

  it("does not mark an expired Meta Graph API version configured", () => {
    vi.stubEnv("WHATSAPP_GRAPH_VERSION", "v20.0");
    const whatsapp = { ...baseChannel, kind: "whatsapp" as const };
    expect(validateChannelHealthConfig(whatsapp)).toMatch(/expired/);
    vi.stubEnv("META_GRAPH_VERSION", "v20.0");
    const instagram = { ...baseChannel, kind: "instagram" as const };
    expect(validateChannelHealthConfig(instagram)).toMatch(/expired/);
  });

  it("requires and verifies Instagram's linked Page to professional-account mapping", async () => {
    const instagram: Channel = { ...baseChannel, kind: "instagram", status: "active",
      external_id: "ig-a", credentials: { pageAccessToken: "token", appSecret: "secret",
        igUserId: "ig-a" }, settings: { verifyToken: "verify" } };
    expect(validateChannelHealthConfig(instagram)).toMatch(/Page ID/);
    const configured = { ...instagram, credentials: { ...instagram.credentials, pageId: "page-a" } };
    expect(validateChannelHealthConfig(configured)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "page-a",
      instagram_business_account: { id: "ig-a" } }), { status: 200 })));
    expect(await runChannelHealthCheck(configured)).toMatchObject({ status: "healthy", checkedLive: true });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/page-a?fields=id,instagram_business_account"),
      expect.objectContaining({ headers: { Authorization: "Bearer token" } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "page-a",
      instagram_business_account: { id: "ig-b" } }), { status: 200 })));
    expect(await runChannelHealthCheck(configured)).toMatchObject({ status: "degraded", checkedLive: true });
  });

  it("checks a Unified Login account directly, without a linked Page or Instagram Login opt-in", async () => {
    vi.stubEnv("PRONTO_INSTAGRAM_LOGIN_ENABLED", "0");
    const instagram: Channel = { ...baseChannel, kind: "instagram", external_id: "ig-a",
      credentials: { accessToken: "unified-token", appSecret: "secret" },
      settings: { authMode: "unified_login", verifyToken: "verify" } };
    expect(validateChannelHealthConfig(instagram)).toBeNull();
    expect(validateChannelHealthConfig({ ...instagram, credentials: { pageAccessToken: "wrong-path", appSecret: "secret" } })).toMatch(/token/);
    expect(validateChannelHealthConfig({ ...instagram, credentials: { accessToken: "unified-token" } })).toMatch(/secret/);
    expect(validateChannelHealthConfig({ ...instagram, settings: { authMode: "unified_login" } })).toMatch(/verify token/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "ig-a", username: "fixture" }))));
    expect(await runChannelHealthCheck(instagram)).toMatchObject({ status: "healthy", checkedLive: true });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("graph.facebook.com/v25.0/ig-a?fields=id,username"),
      expect.objectContaining({ headers: { Authorization: "Bearer unified-token" } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "ig-b" }))));
    expect(await runChannelHealthCheck(instagram)).toMatchObject({ status: "degraded", checkedLive: true });
  });

  it("rejects an unknown Instagram auth mode instead of treating it as Page login", () => {
    expect(validateChannelHealthConfig({ ...baseChannel, kind: "instagram", settings: { authMode: "other" } }))
      .toMatch(/Unsupported/);
  });
});
