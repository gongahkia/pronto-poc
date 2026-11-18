import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeInstagramPayload, sendInstagramText, verifyInstagramSignature } from "@/lib/channels/instagram";

describe("Instagram adapter", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it("normalizes text DMs", () => {
    const result = normalizeInstagramPayload("ig-channel", {
      entry: [
        {
          messaging: [
            {
              sender: { id: "ig-user" },
              message: { mid: "mid-ig", text: "hi" },
            },
          ],
        },
      ],
    });
    expect(result).toEqual([
      {
        channelId: "ig-channel",
        channelKind: "instagram",
        externalMessageId: "mid-ig",
        externalThreadId: "ig-user",
        customerHandle: "ig-user",
        text: "hi",
        unsupportedMediaType: undefined,
        raw: expect.any(Object),
      },
    ]);
  });

  it("skips echo messages", () => {
    const result = normalizeInstagramPayload("ig-channel", {
      entry: [
        {
          messaging: [
            {
              sender: { id: "ig-user" },
              message: { mid: "mid-ig", text: "echo", is_echo: true },
            },
          ],
        },
      ],
    });
    expect(result).toHaveLength(0);
  });

  it("flags story_mention as unsupported", () => {
    const [message] = normalizeInstagramPayload("ig-channel", {
      entry: [
        {
          messaging: [
            {
              sender: { id: "ig-user" },
              message: { mid: "mid-ig", story_mention: { id: "story-1" } },
            },
          ],
        },
      ],
    });
    expect(message.unsupportedMediaType).toBe("story_mention");
  });

  it("requires an app secret for webhook authenticity", () => {
    expect(verifyInstagramSignature("{}", null, undefined)).toBe(false);
  });

  it("sends to the customer ID with the configured professional account and Page token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message_id: "mid.out" }),
      { status: 200, headers: { "Content-Type": "application/json" } })));
    const result = await sendInstagramText({
      channel: { id: "ig-channel", client_id: "tenant-a", kind: "instagram", name: "Instagram",
        status: "active", external_id: "ig-business-a", credentials: { pageAccessToken: "page-token" },
        settings: {}, last_health_check_at: null, last_health_status: null, last_health_error: null,
        last_outbound_at: null, last_outbound_error: null },
      externalThreadId: "ig-customer-a", text: "Vegetarian noodles are available.",
    });
    expect(result).toBe("mid.out");
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain("/ig-business-a/messages");
    expect((options?.headers as Record<string, string>).Authorization).toBe("Bearer page-token");
    expect(JSON.parse(String(options?.body))).toMatchObject({ recipient: { id: "ig-customer-a" },
      message: { text: "Vegetarian noodles are available." } });
  });

  it("does not use a process-wide Page token for an unconfigured tenant", async () => {
    vi.stubEnv("INSTAGRAM_PAGE_ACCESS_TOKEN", "other-tenant-token");
    await expect(sendInstagramText({
      channel: { id: "ig-channel", client_id: "tenant-a", kind: "instagram", name: "Instagram",
        status: "active", external_id: "ig-business-a", credentials: {}, settings: {},
        last_health_check_at: null, last_health_status: null, last_health_error: null,
        last_outbound_at: null, last_outbound_error: null },
      externalThreadId: "ig-customer-a", text: "Hello",
    })).rejects.toThrow(/token.*missing/i);
  });

  it("uses a Unified Login token on Facebook Graph without a linked Page", async () => {
    const channel = { id: "ig-channel", client_id: "tenant-a", kind: "instagram" as const,
      name: "Instagram", status: "active" as const, external_id: "ig-business-a",
      credentials: { accessToken: "unified-token", pageAccessToken: "unused-page-token",
        instagramAccessToken: "unused-direct-token" }, settings: { authMode: "unified_login" },
      last_health_check_at: null, last_health_status: null, last_health_error: null,
      last_outbound_at: null, last_outbound_error: null };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message_id: "mid.unified" }))));
    expect(await sendInstagramText({ channel, externalThreadId: "customer", text: "Hello" })).toBe("mid.unified");
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/graph.facebook.com\/v\d+\.\d+\/ig-business-a\/messages$/),
      expect.objectContaining({ headers: { Authorization: "Bearer unified-token", "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: "customer" }, message: { text: "Hello" } }) }));
    await expect(sendInstagramText({ channel: { ...channel, credentials: { pageAccessToken: "wrong-path" } },
      externalThreadId: "customer", text: "Hello" })).rejects.toThrow(/token.*missing/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not use environment test credentials as a tenant's send credentials", async () => {
    vi.stubEnv("PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN", "other-tenant-token");
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await expect(sendInstagramText({ channel: {
      id: "ig-channel", client_id: "tenant-a", kind: "instagram", name: "Instagram",
      status: "active", external_id: "ig-business-a", credentials: {}, settings: { authMode: "unified_login" },
      last_health_check_at: null, last_health_status: null, last_health_error: null,
      last_outbound_at: null, last_outbound_error: null,
    }, externalThreadId: "customer", text: "Hello" })).rejects.toThrow(/token.*missing/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("treats a Graph transport timeout as uncertain acceptance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timed out", "AbortError")));
    await expect(sendInstagramText({
      channel: { id: "ig-channel", client_id: "tenant-a", kind: "instagram", name: "Instagram",
        status: "active", external_id: "ig-business-a", credentials: { pageAccessToken: "token" }, settings: {},
        last_health_check_at: null, last_health_status: null, last_health_error: null,
        last_outbound_at: null, last_outbound_error: null },
      externalThreadId: "ig-customer-a", text: "Hello",
    })).rejects.toMatchObject({ name: "AmbiguousProviderAcceptanceError" });
  });

  it("uses a direct Instagram Login token without a Page and rejects expiry", async () => {
    vi.stubEnv("PRONTO_INSTAGRAM_LOGIN_ENABLED", "1");
    const channel = { id: "ig-channel", client_id: "tenant-a", kind: "instagram" as const,
      name: "Instagram", status: "active" as const, external_id: "ig-business-a",
      credentials: { instagramAccessToken: "direct-token", igUserId: "ig-business-a",
        tokenExpiresAt: new Date(Date.now() + 60_000).toISOString() },
      settings: { authMode: "instagram_login" }, last_health_check_at: null,
      last_health_status: null, last_health_error: null, last_outbound_at: null, last_outbound_error: null };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message_id: "mid.direct" }))));
    expect(await sendInstagramText({ channel, externalThreadId: "customer", text: "Hello" })).toBe("mid.direct");
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("graph.instagram.com");
    await expect(sendInstagramText({ channel: { ...channel, credentials: { ...channel.credentials,
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString() } }, externalThreadId: "customer",
      text: "Hello" })).rejects.toMatchObject({ statusCode: 401 });
  });

  it("classifies direct Instagram rate limit and revoked token responses", async () => {
    vi.stubEnv("PRONTO_INSTAGRAM_LOGIN_ENABLED", "1");
    const channel = { id: "ig-channel", client_id: "tenant-a", kind: "instagram" as const,
      name: "Instagram", status: "active" as const, external_id: "ig-business-a",
      credentials: { instagramAccessToken: "direct-token", tokenExpiresAt: new Date(Date.now() + 60_000).toISOString() },
      settings: { authMode: "instagram_login" }, last_health_check_at: null,
      last_health_status: null, last_health_error: null, last_outbound_at: null, last_outbound_error: null };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 })));
    await expect(sendInstagramText({ channel, externalThreadId: "customer", text: "Hello" }))
      .rejects.toMatchObject({ retryable: true, statusCode: 429 });
    await expect(sendInstagramText({ channel, externalThreadId: "customer", text: "Hello" }))
      .rejects.toMatchObject({ retryable: false, statusCode: 401 });
  });

  it("keeps the direct login send path disabled without explicit authorization configuration", async () => {
    vi.stubEnv("PRONTO_INSTAGRAM_LOGIN_ENABLED", "0");
    await expect(sendInstagramText({ channel: {
      id: "ig-channel", client_id: "tenant-a", kind: "instagram", name: "Instagram",
      status: "active", external_id: "ig-business-a",
      credentials: { instagramAccessToken: "fixture", tokenExpiresAt: new Date(Date.now() + 60_000).toISOString() },
      settings: { authMode: "instagram_login" }, last_health_check_at: null,
      last_health_status: null, last_health_error: null, last_outbound_at: null, last_outbound_error: null,
    }, externalThreadId: "customer", text: "Hello" })).rejects.toThrow(/disabled/);
  });

  it("logs only numeric provider rejection details and a hashed trace", async () => {
    vi.stubEnv("PRONTO_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: {
      code: 190, error_subcode: 463, message: "private provider explanation", fbtrace_id: "private-body-trace",
    } }), { status: 400, headers: { "x-fb-trace-id": "private-header-trace" } })));
    await expect(sendInstagramText({ channel: {
      id: "ig-channel", client_id: "tenant-a", kind: "instagram", name: "Instagram", status: "active",
      external_id: "private-account", credentials: { accessToken: "private-token" }, settings: { authMode: "unified_login" },
      last_health_check_at: null, last_health_status: null, last_health_error: null, last_outbound_at: null, last_outbound_error: null,
    }, externalThreadId: "private-customer", text: "private customer text" }))
      .rejects.toMatchObject({ statusCode: 400, providerCode: 190, retryable: false });
    const records = log.mock.calls.map(call => JSON.parse(String(call[0])));
    expect(records.find(record => record.event === "instagram.provider_rejected"))
      .toMatchObject({ httpStatus: 400, providerCode: 190, providerSubcode: 463, providerTraceHash: expect.stringMatching(/^sha256:/) });
    for (const value of ["private provider explanation", "private-body-trace", "private-header-trace", "private-token",
      "private-account", "private-customer", "private customer text"]) expect(JSON.stringify(records)).not.toContain(value);
  });

  it.each([null, {}, { message_id: "" }])("logs an ambiguous response without inventing provider acceptance", async response => {
    vi.stubEnv("PRONTO_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response))));
    await expect(sendInstagramText({ channel: {
      id: "ig-channel", client_id: "tenant-a", kind: "instagram", name: "Instagram", status: "active",
      external_id: "ig-business", credentials: { accessToken: "fixture-token" }, settings: { authMode: "unified_login" },
      last_health_check_at: null, last_health_status: null, last_health_error: null, last_outbound_at: null, last_outbound_error: null,
    }, externalThreadId: "customer", text: "Hello" })).rejects.toMatchObject({ name: "AmbiguousProviderAcceptanceError" });
    const events = log.mock.calls.map(call => JSON.parse(String(call[0])).event);
    expect(events).toContain("instagram.acceptance_unknown");
    expect(events).not.toContain("instagram.provider_accepted");
  });

  it("does not label an HTTP 5xx response a definite rejection", async () => {
    vi.stubEnv("PRONTO_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await expect(sendInstagramText({ channel: {
      id: "ig-channel", client_id: "tenant-a", kind: "instagram", name: "Instagram", status: "active",
      external_id: "ig-business", credentials: { accessToken: "fixture-token" }, settings: { authMode: "unified_login" },
      last_health_check_at: null, last_health_status: null, last_health_error: null, last_outbound_at: null, last_outbound_error: null,
    }, externalThreadId: "customer", text: "Hello" })).rejects.toMatchObject({ ambiguous: true });
    const records = log.mock.calls.map(call => JSON.parse(String(call[0])));
    expect(records.find(record => record.event === "instagram.acceptance_unknown")).toMatchObject({ httpStatus: 503, reason: "http_error" });
    expect(records.some(record => record.event === "instagram.provider_rejected")).toBe(false);
  });
});
