import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertInstagramTestAiReady, instagramTestAiConfiguration, instagramTestAiProfile, usesInstagramTestTextKnowledge } from "@/lib/channels/instagram-test-ai";
import { freeProviderApiKey } from "@/lib/llm/free-providers";
import { withAiExecutionProfile, aiExecutionProfile } from "@/lib/llm/execution-mode";
import type { Channel } from "@/lib/types";

const mocks = vi.hoisted(() => ({ query: vi.fn(), knowledge: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: mocks.query }));
vi.mock("@/lib/knowledge/retrieve", () => ({ hasApprovedTextKnowledge: mocks.knowledge }));
const clientId = randomUUID(), channelId = randomUUID(), accountId = "10001", senderId = "20002";
const published = { response_provider: "groq", response_model: "openai/gpt-oss-20b", embedding_provider: "none", embedding_model: "none" };
const channel: Channel = { id: channelId, client_id: clientId, kind: "instagram", name: "Test", status: "active", external_id: accountId,
  encrypted_credentials: "fixture-encrypted", credentials: { igUserId: accountId }, settings: { authMode: "unified_login" },
  last_health_check_at: null, last_health_status: null, last_health_error: null, last_outbound_at: null, last_outbound_error: null };
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ PRONTO_HOSTED_INSTAGRAM_AI: "1", PRONTO_HOSTED_INSTAGRAM: "1",
    PRONTO_DEPLOYMENT_PROFILE: "standard", PRONTO_USE_MOCK_AI: "0", PRONTO_CUSTOMER_DEMO_ENABLED: "0", PRONTO_DEMO_ONLY_DELIVERY: "0",
    PRONTO_HOSTED_INSTAGRAM_CLIENT_ID: clientId, PRONTO_HOSTED_INSTAGRAM_CHANNEL_ID: channelId,
    PRONTO_HOSTED_INSTAGRAM_ACCOUNT_ID: accountId, PRONTO_HOSTED_INSTAGRAM_SENDER_IDS: senderId,
    PRONTO_HOSTED_INSTAGRAM_DATABASE_MARKER: "pronto:instagram-hosted:v1:" + randomUUID(),
    GROQ_API_KEY: "fixture-groq-key", PRONTO_GROQ_FREE_TIER_CONFIRMED: "1", PRONTO_DEMO_REAL_AI_APPROVED: "0" })) vi.stubEnv(name, value);
  mocks.knowledge.mockResolvedValue(true);
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("pg_database") ? [{ safe: true }]
    : sql.includes("from agent_configs") ? [published] : [channel] }));
});
afterEach(() => vi.unstubAllEnvs());
describe("isolated Instagram test AI", () => {
  it("selects the explicit Groq/text profile without pretending to be the public demo", async () => {
    const profile = await instagramTestAiProfile(channel, senderId);
    expect(profile).toEqual({ mode: "real", provider: "groq", model: published.response_model,
      embeddingProvider: "none", embeddingModel: "none", retrievalMode: "local_text", instagramTestClientId: clientId });
    await withAiExecutionProfile(profile!, async () => {
      expect(freeProviderApiKey("groq", clientId)).toBe("fixture-groq-key");
      expect(() => freeProviderApiKey("groq", randomUUID())).toThrow();
      expect(() => freeProviderApiKey("gemini", clientId)).toThrow();
    });
    expect(aiExecutionProfile()).toBeUndefined();
    expect(() => freeProviderApiKey("groq", clientId)).toThrow();
  });
  it("requires matching database identity and retains tenant-scoped authoring", async () => {
    expect(await usesInstagramTestTextKnowledge(clientId)).toBe(true);
    expect(await usesInstagramTestTextKnowledge(randomUUID())).toBe(false);
    mocks.query.mockResolvedValue({ rows: [{ safe: false }] });
    await expect(instagramTestAiProfile(channel, senderId)).rejects.toThrow(/database identity/);
    await expect(usesInstagramTestTextKnowledge(clientId)).rejects.toThrow(/database identity/);
  });
  it.each([
    { id: randomUUID() }, { client_id: randomUUID() }, { external_id: "30003" }, { status: "draft" },
    { status: "disabled" }, { credentials: { igUserId: "30003" } }, { settings: { authMode: "instagram_login" } },
    { encrypted_credentials: null },
  ])("rejects an unapproved channel identity/state: %j", async change => {
    await expect(instagramTestAiProfile({ ...channel, ...change } as Channel, senderId)).rejects.toThrow(/approved channel/);
  });
  it("rejects other senders before reading knowledge or making inference", async () => {
    await expect(instagramTestAiProfile(channel, "99999")).rejects.toThrow(/allowlisted tester/);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("does not override unpublished model settings or use unreviewed knowledge", async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("pg_database") ? [{ safe: true }]
      : sql.includes("from agent_configs") ? [{ ...published, response_provider: "openai" }] : [channel] }));
    await expect(instagramTestAiProfile(channel, senderId)).rejects.toThrow(/published model settings/);
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("pg_database") ? [{ safe: true }]
      : sql.includes("from agent_configs") ? [published] : [channel] }));
    mocks.knowledge.mockResolvedValue(false);
    await expect(instagramTestAiProfile(channel, senderId)).rejects.toThrow(/approved knowledge/);
  });
  it("checks readiness without model calls and rejects an inactive channel", async () => {
    await expect(assertInstagramTestAiReady()).resolves.toBeUndefined();
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("pg_database") ? [{ safe: true }]
      : sql.includes("from agent_configs") ? [published] : [{ ...channel, status: "draft" }] }));
    await expect(assertInstagramTestAiReady()).rejects.toThrow(/approved channel/);
  });
  it.each([["GROQ_API_KEY", ""], ["PRONTO_GROQ_FREE_TIER_CONFIRMED", "0"]])("requires %s", async (key, value) => {
    vi.stubEnv(key, value); await expect(instagramTestAiProfile(channel, senderId)).rejects.toThrow(/free-tier key/);
  });
  it.each([["PRONTO_DEPLOYMENT_PROFILE", "protected-demo"], ["PRONTO_CUSTOMER_DEMO_ENABLED", "1"],
    ["PRONTO_USE_MOCK_AI", "1"], ["PRONTO_HOSTED_INSTAGRAM_CLIENT_ID", "bad-id"],
    ["PRONTO_HOSTED_INSTAGRAM_DATABASE_MARKER", "ordinary-database"], ["PRONTO_HOSTED_INSTAGRAM_SENDER_IDS", accountId]])(
    "rejects invalid test configuration: %s", (key, value) => {
      vi.stubEnv(key, value); expect(() => instagramTestAiConfiguration()).toThrow(/scope is invalid/);
    });
  it("leaves ordinary deployments unchanged and fails closed on the hosted test when AI is disabled", async () => {
    vi.stubEnv("PRONTO_HOSTED_INSTAGRAM_AI", "0");
    await expect(instagramTestAiProfile(channel, senderId)).rejects.toThrow(/approved channel/);
    expect(await usesInstagramTestTextKnowledge(clientId)).toBe(false);
    vi.stubEnv("PRONTO_HOSTED_INSTAGRAM", "0");
    expect(await instagramTestAiProfile(channel, senderId)).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
