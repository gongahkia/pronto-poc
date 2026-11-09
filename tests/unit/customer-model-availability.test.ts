import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import { hasApprovedTextKnowledge } from "@/lib/knowledge/retrieve";
import { demoModelAvailability } from "@/lib/customer-demo-ai";

vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/knowledge/retrieve", () => ({ hasApprovedTextKnowledge: vi.fn() }));

beforeEach(() => {
  vi.mocked(query).mockResolvedValue({ command: "SELECT", rowCount: 1, oid: 0, fields: [],
    rows: [{ response_provider: "openai", response_model: "gpt-5.5",
      embedding_provider: "openai", embedding_model: "text-embedding-3-small" }] });
  vi.mocked(hasApprovedTextKnowledge).mockResolvedValue(true);
  for (const key of ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "ANTHROPIC_API_KEY"])
    vi.stubEnv(key, "");
  vi.stubEnv("PRONTO_DEMO_REAL_AI_APPROVED", "1");
  vi.stubEnv("PRONTO_GROQ_FREE_TIER_CONFIRMED", "1");
});
afterEach(() => vi.unstubAllEnvs());

describe("server model availability", () => {
  it("offers local OpenAI only in an explicitly enabled non-hosted environment", async () => {
    vi.stubEnv("PRONTO_DEMO_LOCAL_OPENAI", "1");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PRONTO_DEPLOYMENT_PROFILE", "");
    expect((await demoModelAvailability()).find(choice => choice.id === "openai-local")?.available).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect((await demoModelAvailability()).some(choice => choice.id === "openai-local")).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PRONTO_DEPLOYMENT_PROFILE", "protected-demo");
    expect((await demoModelAvailability()).some(choice => choice.id === "openai-local")).toBe(false);
  });
  it.each(["development", "production"])("marks missing provider keys unavailable in %s", async mode => {
    vi.stubEnv("NODE_ENV", mode);
    const choices = await demoModelAvailability();
    for (const id of ["groq-oss", "gemini-flash", "gemini-lite"])
      expect(choices.find(choice => choice.id === id)?.available).toBe(false);
  });

  it("enables configured Groq independently of unconfigured Gemini without exposing secrets", async () => {
    const key = "synthetic-provider-key-never-return";
    vi.stubEnv("GROQ_API_KEY", key);
    const choices = await demoModelAvailability();
    expect(choices.find(choice => choice.id === "groq-oss")?.available).toBe(true);
    expect(choices.find(choice => choice.id === "gemini-flash")?.available).toBe(false);
    expect(choices.find(choice => choice.id === "gemini-lite")?.available).toBe(false);
    expect(JSON.stringify(choices)).not.toContain(key);
  });
});
