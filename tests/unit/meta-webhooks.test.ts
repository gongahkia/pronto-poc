import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getWhatsAppChannel: vi.fn(), getInstagramChannel: vi.fn(),
  recordWhatsAppStatusEvents: vi.fn(async () => 0),
  processInboundMessages: vi.fn(async (messages: unknown[]) => ({
    ok: true, accepted: messages.length, duplicates: 0, jobIds: ["job-1"],
  })),
}));
vi.mock("@/lib/channels/whatsapp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/channels/whatsapp")>()),
  getWhatsAppChannel: fakes.getWhatsAppChannel,
  recordWhatsAppStatusEvents: fakes.recordWhatsAppStatusEvents,
}));
vi.mock("@/lib/channels/instagram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/channels/instagram")>()),
  getInstagramChannel: fakes.getInstagramChannel,
}));
vi.mock("@/lib/channels/process", () => ({ processInboundMessages: fakes.processInboundMessages }));

import { GET as whatsAppGet, POST as whatsAppPost } from "@/app/api/webhooks/whatsapp/[channelId]/route";
import { GET as instagramGet, POST as instagramPost } from "@/app/api/webhooks/instagram/[channelId]/route";

const context = { params: Promise.resolve({ channelId: "channel-a" }) };
const channel = (kind: "whatsapp" | "instagram", status = "active") => ({
  id: "channel-a", client_id: "tenant-a", kind, status,
  external_id: kind === "whatsapp" ? "phone-a" : "ig-business-a",
  credentials: { appSecret: "test-meta-secret", phoneNumberId: "phone-a", igUserId: "ig-business-a" },
  settings: { verifyToken: "test-verify-token" },
});
const whatsAppPayload = {
  object: "whatsapp_business_account", entry: [{ id: "waba-a", changes: [{ field: "messages",
    value: { metadata: { phone_number_id: "phone-a" }, messages: [{ id: "wamid.1",
      from: "6590000000", type: "text", text: { body: "What time do you close?" } }] } }] }],
};
const instagramPayload = {
  object: "instagram", entry: [{ id: "ig-business-a", messaging: [{
    sender: { id: "ig-customer-a" }, recipient: { id: "ig-business-a" },
    message: { mid: "mid.1", text: "Vegetarian options?" },
  }] }],
};

function signedRequest(provider: "whatsapp" | "instagram", payload: unknown, secret = "test-meta-secret") {
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  return new Request(`http://localhost:3000/api/webhooks/${provider}/channel-a`, {
    method: "POST", headers: { "x-hub-signature-256": `sha256=${signature}` }, body: raw,
  });
}

describe("Meta webhook entry points", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.getWhatsAppChannel.mockResolvedValue(channel("whatsapp"));
    fakes.getInstagramChannel.mockResolvedValue(channel("instagram"));
  });

  it("verifies WhatsApp and Instagram webhook challenges only for active configured channels", async () => {
    for (const route of [whatsAppGet, instagramGet]) {
      const url = "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=challenge-123";
      const response = await route(new Request(url), context);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("challenge-123");
      expect((await route(new Request(url.replace("test-verify-token", "wrong")), context)).status).toBe(403);
    }
    fakes.getWhatsAppChannel.mockResolvedValue(channel("whatsapp", "disabled"));
    expect((await whatsAppGet(new Request("http://localhost:3000/webhook"), context)).status).toBe(403);
  });

  it("authenticates, maps and acknowledges a WhatsApp text without running the agent", async () => {
    const response = await whatsAppPost(signedRequest("whatsapp", whatsAppPayload), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: 1 });
    expect(fakes.processInboundMessages).toHaveBeenCalledWith([
      expect.objectContaining({ channelId: "channel-a", externalMessageId: "wamid.1",
        externalThreadId: "6590000000", text: "What time do you close?" }),
    ], expect.any(Object));
  });

  it("rejects bad signatures, disabled channels and wrong WhatsApp business numbers", async () => {
    expect((await whatsAppPost(signedRequest("whatsapp", whatsAppPayload, "wrong"), context)).status).toBe(401);
    const wrong = structuredClone(whatsAppPayload);
    wrong.entry[0].changes[0].value.metadata.phone_number_id = "phone-b";
    expect((await whatsAppPost(signedRequest("whatsapp", wrong), context)).status).toBe(403);
    fakes.getWhatsAppChannel.mockResolvedValue(channel("whatsapp", "disabled"));
    expect((await whatsAppPost(signedRequest("whatsapp", whatsAppPayload), context)).status).toBe(403);
    expect(fakes.processInboundMessages).not.toHaveBeenCalled();
  });

  it("ignores WhatsApp delivery statuses as customer messages", async () => {
    const status = structuredClone(whatsAppPayload);
    delete (status.entry[0].changes[0].value as Record<string, unknown>).messages;
    (status.entry[0].changes[0].value as Record<string, unknown>).statuses = [{ id: "wamid.out", status: "delivered" }];
    const response = await whatsAppPost(signedRequest("whatsapp", status), context);
    expect(response.status).toBe(200);
    expect(fakes.processInboundMessages).toHaveBeenCalledWith([], expect.any(Object));
  });

  it("accepts only customer Instagram DMs for the mapped professional account", async () => {
    const response = await instagramPost(signedRequest("instagram", instagramPayload), context);
    expect(response.status).toBe(200);
    expect(fakes.processInboundMessages).toHaveBeenCalledWith([
      expect.objectContaining({ externalMessageId: "mid.1", externalThreadId: "ig-customer-a" }),
    ], expect.any(Object));
    const echo = structuredClone(instagramPayload);
    echo.entry[0].messaging[0].message = { ...echo.entry[0].messaging[0].message, is_echo: true } as typeof echo.entry[0]["messaging"][0]["message"];
    await instagramPost(signedRequest("instagram", echo), context);
    expect(fakes.processInboundMessages).toHaveBeenLastCalledWith([], expect.any(Object));
  });

  it("authenticates Unified Login DMs with the channel secret and exact account mapping", async () => {
    fakes.getInstagramChannel.mockResolvedValue({ ...channel("instagram"),
      settings: { authMode: "unified_login", verifyToken: "test-verify-token" } });
    const response = await instagramPost(signedRequest("instagram", instagramPayload), context);
    expect(response.status).toBe(200);
    expect(fakes.processInboundMessages).toHaveBeenCalledWith([
      expect.objectContaining({ channelId: "channel-a", externalThreadId: "ig-customer-a", text: "Vegetarian options?" }),
    ], expect.any(Object));
    expect((await instagramPost(signedRequest("instagram", instagramPayload, "foreign-secret"), context)).status).toBe(401);
    const wrong = structuredClone(instagramPayload);
    wrong.entry[0].id = "ig-business-b";
    expect((await instagramPost(signedRequest("instagram", wrong), context)).status).toBe(403);
    expect(fakes.processInboundMessages).toHaveBeenCalledTimes(1);
  });

  it("rejects Instagram signature, disabled account and tenant account mismatch", async () => {
    expect((await instagramPost(signedRequest("instagram", instagramPayload, "wrong"), context)).status).toBe(401);
    const wrong = structuredClone(instagramPayload);
    wrong.entry[0].id = "ig-business-b";
    expect((await instagramPost(signedRequest("instagram", wrong), context)).status).toBe(403);
    fakes.getInstagramChannel.mockResolvedValue(channel("instagram", "disabled"));
    expect((await instagramPost(signedRequest("instagram", instagramPayload), context)).status).toBe(403);
    expect(fakes.processInboundMessages).not.toHaveBeenCalled();
  });

  it("does not authenticate one tenant's webhook with process-wide Meta secrets", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", "test-meta-secret");
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "test-verify-token");
    vi.stubEnv("INSTAGRAM_APP_SECRET", "test-meta-secret");
    vi.stubEnv("INSTAGRAM_VERIFY_TOKEN", "test-verify-token");
    fakes.getWhatsAppChannel.mockResolvedValue({ ...channel("whatsapp"), credentials: {}, settings: {} });
    fakes.getInstagramChannel.mockResolvedValue({ ...channel("instagram"), credentials: {}, settings: {} });
    const challenge = new Request("http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=challenge-123");
    expect((await whatsAppGet(challenge, context)).status).toBe(403);
    expect((await instagramGet(challenge, context)).status).toBe(403);
    expect((await whatsAppPost(signedRequest("whatsapp", whatsAppPayload), context)).status).toBe(401);
    expect((await instagramPost(signedRequest("instagram", instagramPayload), context)).status).toBe(401);
    expect(fakes.processInboundMessages).not.toHaveBeenCalled();
  });
});
