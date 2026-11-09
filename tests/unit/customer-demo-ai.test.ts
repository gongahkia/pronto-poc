import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldUseMockAi } from "@/lib/env";
import { withAiExecutionMode, aiExecutionMode } from "@/lib/llm/execution-mode";
import { getGenerationProvider, getEmbeddingProvider } from "@/lib/llm";
import { profileForDemoChoice, realDemoConfiguration, storedDemoProfile } from "@/lib/customer-demo-ai";
import type { AgentConfig } from "@/lib/types";

const config = { response_provider: "openai", response_model: "gpt-5.5",
  embedding_provider: "openai", embedding_model: "text-embedding-3-small" } as AgentConfig;
afterEach(() => vi.unstubAllEnvs());

describe("explicit customer demo AI mode", () => {
  it("uses the Groq text retrieval path for explicitly enabled local OpenAI without embeddings", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PRONTO_DEPLOYMENT_PROFILE", "");
    vi.stubEnv("PRONTO_DEMO_LOCAL_OPENAI", "1");
    vi.stubEnv("PRONTO_DEMO_REAL_AI_APPROVED", "1");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
    const profile = profileForDemoChoice("openai-local")!;
    expect(realDemoConfiguration(config, profile)).toMatchObject({ provider: "openai", model: "gpt-6-luna",
      retrievalMode: "local_text", embeddingProvider: "none", missing: [] });
    expect(storedDemoProfile({ ai_selection: "openai-local", ai_configuration: profile })).toEqual(profile);
    vi.stubEnv("PRONTO_DEMO_REAL_AI_APPROVED", "0");
    expect(realDemoConfiguration(config, profile).missing).toContain("PRONTO_DEMO_REAL_AI_APPROVED=1");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => profileForDemoChoice("openai-local")).toThrow(/not enabled/);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PRONTO_DEPLOYMENT_PROFILE", "protected-demo");
    expect(() => profileForDemoChoice("openai-local")).toThrow(/not enabled/);
  });
  it("Groq local retrieval needs only the Groq key plus explicit free-tier/testing approval", () => {
    vi.stubEnv("GROQ_API_KEY", "synthetic-test-key");
    vi.stubEnv("PRONTO_DEMO_REAL_AI_APPROVED", "1");vi.stubEnv("PRONTO_GROQ_FREE_TIER_CONFIRMED", "1");
    for (const key of ["GEMINI_API_KEY","OPENAI_API_KEY","AZURE_OPENAI_API_KEY","ANTHROPIC_API_KEY"])
      vi.stubEnv(key, "");
    vi.stubEnv("PRONTO_EMBEDDING_PROVIDER", "gemini");
    const profile = profileForDemoChoice("groq-oss")!;
    expect(realDemoConfiguration(config, profile)).toMatchObject({provider:"groq",model:"openai/gpt-oss-20b",
      embeddingProvider:"none",embeddingModel:"none",retrievalMode:"local_text",missing:[]});
    expect(storedDemoProfile({ai_selection:"groq-oss",ai_configuration:profile})).toEqual(profile);
    expect(() => storedDemoProfile({ai_selection:"groq-oss",ai_configuration:{...profile,embeddingProvider:"gemini"}})).toThrow(/stored/);
    expect(realDemoConfiguration(config, profileForDemoChoice("gemini-flash")).missing).toContain("GEMINI_API_KEY");
  });
  it("names missing variables without returning credential values", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(realDemoConfiguration(config).missing).toContain("OPENAI_API_KEY");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-secret-never-display");
    expect(JSON.stringify(realDemoConfiguration(config))).not.toContain("synthetic-secret-never-display");
    expect(realDemoConfiguration(config).missing).toEqual([]);
  });
  it("requires a supported real embedding provider and Azure deployment configuration", () => {
    vi.stubEnv("PRONTO_EMBEDDING_PROVIDER", "anthropic");
    expect(realDemoConfiguration(config).missing).toContain("PRONTO_EMBEDDING_PROVIDER=openai or azure or gemini");
    vi.stubEnv("PRONTO_LLM_PROVIDER", "azure"); vi.stubEnv("PRONTO_EMBEDDING_PROVIDER", "azure");
    for (const key of ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_RESPONSE_DEPLOYMENT"])
      vi.stubEnv(key, "");
    expect(realDemoConfiguration(config).missing).toEqual(expect.arrayContaining(["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT"]));
    vi.stubEnv("PRONTO_LLM_PROVIDER", "openai");
    expect(realDemoConfiguration(config).missing).not.toContain("AZURE_OPENAI_RESPONSE_DEPLOYMENT or AZURE_OPENAI_DEPLOYMENT");
    vi.stubEnv("PRONTO_LLM_PROVIDER", "azure"); vi.stubEnv("PRONTO_EMBEDDING_PROVIDER", "openai");
    expect(realDemoConfiguration(config).missing).not.toContain("AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
  });
  it("isolates concurrent job modes while preserving the default mock setting", async () => {
    vi.stubEnv("PRONTO_USE_MOCK_AI", "1");
    const values = await Promise.all([withAiExecutionMode("real", async () => { await Promise.resolve(); return shouldUseMockAi(); }),
      withAiExecutionMode("mock", async () => { await Promise.resolve(); return shouldUseMockAi(); })]);
    expect(values).toEqual([false, true]); expect(shouldUseMockAi()).toBe(true); expect(aiExecutionMode()).toBeUndefined();
  });
  it("never substitutes mock generation or embeddings in real mode", async () => {
    vi.stubEnv("PRONTO_USE_MOCK_AI", "1"); vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => withAiExecutionMode("real", () => getGenerationProvider("mock"))).toThrow(/Real demo mode/);
    expect(() => withAiExecutionMode("real", () => getEmbeddingProvider("mock"))).toThrow(/Real demo mode/);
    await expect(withAiExecutionMode("real", () => getEmbeddingProvider("openai").embed(["Synthetic test"], "text-embedding-3-small")))
      .rejects.toThrow(/OPENAI_API_KEY/);
    expect((await withAiExecutionMode("mock", () => getEmbeddingProvider("openai").embed(["Synthetic test"], "text-embedding-3-small")))[0]).toHaveLength(1536);
  });
});
