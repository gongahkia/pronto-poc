import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { demoInstagramConfiguration, isDemoInstagramChannel, assertDemoInstagramScope, demoInstagramAiProfile } from "@/lib/channels/instagram-demo";
import { instagramRelayRewrites } from "@/lib/channels/instagram-relay";
import { freeProviderApiKey } from "@/lib/llm/free-providers";
import { withAiExecutionProfile } from "@/lib/llm/execution-mode";
import { DEMO_CLIENT_ID } from "@/lib/customer-demo-boundary";
import { instagramPayloadMatchesChannel } from "@/lib/channels/instagram";
import type { Channel } from "@/lib/types";
const mock = vi.hoisted(() => ({ config: vi.fn(), boundary: vi.fn(), realConfig: vi.fn() }));
vi.mock("@/lib/deployment-profile", () => ({ protectedDemoConfiguration: mock.config }));
vi.mock("@/lib/customer-demo-boundary", async original => ({ ...await original<typeof import("@/lib/customer-demo-boundary")>(), assertCustomerDemoEnabled: mock.boundary }));
vi.mock("@/lib/customer-demo-ai", () => ({ requireRealDemoConfiguration: mock.realConfig, profileForDemoChoice: () => ({ provider: "groq" }) }));
const channelId = randomUUID(), accountId = "10001", senderId = "20002";
const channel: Channel = { id: channelId, client_id: DEMO_CLIENT_ID, kind: "instagram", name: "Instagram", status: "active",
  external_id: accountId, encrypted_credentials: "fixture", credentials: { igUserId: accountId }, settings: { authMode: "unified_login" },
  last_health_check_at: null, last_health_status: null, last_health_error: null, last_outbound_at: null, last_outbound_error: null };
beforeEach(() => {
  vi.clearAllMocks();mock.config.mockReturnValue({});mock.boundary.mockResolvedValue(undefined);
  mock.realConfig.mockResolvedValue({ provider: "groq", model: "openai/gpt-oss-20b", embeddingProvider: "none", embeddingModel: "none", retrievalMode: "local_text" });
  for (const [key, value] of Object.entries({ PRONTO_DEMO_INSTAGRAM_ENABLED: "1", PRONTO_DEMO_INSTAGRAM_CHANNEL_ID: channelId,
    PRONTO_DEMO_INSTAGRAM_ACCOUNT_ID: accountId, PRONTO_DEMO_INSTAGRAM_SENDER_IDS: senderId,
    GROQ_API_KEY: "fixture-key", PRONTO_DEMO_REAL_AI_APPROVED: "1", PRONTO_GROQ_FREE_TIER_CONFIRMED: "1" })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());
describe("explicit Instagram channel on the shared public demo", () => {
  it("retains the protected database boundary and binds Groq to the exact demo tenant", async () => {
    const profile = await demoInstagramAiProfile(channel, senderId);
    expect(mock.boundary).toHaveBeenCalled();expect(profile.syntheticDemo).toBeUndefined();
    expect(profile.instagramDemoClientId).toBe(DEMO_CLIENT_ID);
    withAiExecutionProfile(profile, () => {
      expect(freeProviderApiKey("groq", DEMO_CLIENT_ID)).toBe("fixture-key");
      expect(() => freeProviderApiKey("groq", randomUUID())).toThrow();
    });
    mock.boundary.mockRejectedValue(new Error("Database mismatch"));
    await expect(demoInstagramAiProfile(channel, senderId)).rejects.toThrow(/mismatch/);
  });
  it("rejects unknown senders, tenants, channels, accounts and inactive configurations", async () => {
    await expect(assertDemoInstagramScope(channel, "99999")).rejects.toThrow(/outside/);
    for (const change of [{ id: randomUUID() }, { client_id: randomUUID() }, { external_id: "99999" }, { status: "draft" }, { encrypted_credentials: null }])
      await expect(assertDemoInstagramScope({ ...channel, ...change } as Channel, senderId)).rejects.toThrow(/outside/);
    vi.stubEnv("PRONTO_DEMO_INSTAGRAM_ENABLED", "0");
    expect(isDemoInstagramChannel(channel)).toBe(false);
    await expect(assertDemoInstagramScope(channel, senderId)).rejects.toThrow(/outside/);
  });
  it("requires a valid explicit configuration and the normal protected profile", () => {
    vi.stubEnv("PRONTO_DEMO_INSTAGRAM_SENDER_IDS", accountId);expect(() => demoInstagramConfiguration()).toThrow(/invalid/);
    vi.stubEnv("PRONTO_DEMO_INSTAGRAM_SENDER_IDS", senderId);mock.config.mockImplementation(() => { throw new Error("Invalid protected profile"); });
    expect(() => demoInstagramConfiguration()).toThrow(/protected profile/);
  });
  it("accepts business-sent echoes without treating another recipient's message as incoming", () => {
    const payload = (sender: string, echo: boolean) => ({ object: "instagram", entry: [{ id: accountId, messaging: [{
      sender: { id: sender }, recipient: { id: senderId }, message: { mid: "fixture", text: "Reply", is_echo: echo },
    }] }] });
    expect(instagramPayloadMatchesChannel(payload(accountId, true), accountId)).toBe(true);
    expect(instagramPayloadMatchesChannel(payload(senderId, true), accountId)).toBe(false);
    expect(instagramPayloadMatchesChannel(payload(accountId, false), accountId)).toBe(false);
  });
});
describe("fixed Instagram callback relay", () => {
  const target = "https://pronto-ai-poc.onrender.com/api/webhooks/instagram/" + channelId;
  const env = { PRONTO_HOSTED_INSTAGRAM: "1", PRONTO_HOSTED_INSTAGRAM_WORKER: "0", PRONTO_DEPLOYMENT_PROFILE: "standard", PRONTO_INSTAGRAM_RELAY_TARGET: target };
  it("proxies only the existing callback path when explicitly configured", () => {
    expect(instagramRelayRewrites({})).toEqual([]);
    expect(instagramRelayRewrites(env)).toEqual([{ source: new URL(target).pathname, destination: target }]);
  });
  it.each(["http://pronto-ai-poc.onrender.com/api/webhooks/instagram/" + channelId,
    "https://other.invalid/api/webhooks/instagram/" + channelId, target + "?token=private", target + "#fragment",
    "https://pronto-ai-poc.onrender.com/api/operator/channels"])("rejects unsafe relay target %s", target => {
      expect(() => instagramRelayRewrites({ ...env, PRONTO_INSTAGRAM_RELAY_TARGET: target })).toThrow();
    });
  it("requires the isolated service with its worker disabled", () => {
    expect(() => instagramRelayRewrites({ ...env, PRONTO_HOSTED_INSTAGRAM_WORKER: "1" })).toThrow();
    expect(() => instagramRelayRewrites({ ...env, PRONTO_DEPLOYMENT_PROFILE: "protected-demo" })).toThrow();
  });
});
