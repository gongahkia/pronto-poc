// @vitest-environment node
import { beforeEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";
const mocks = vi.hoisted(() => ({ query: vi.fn(), generate: vi.fn(), boundary: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: mocks.query }));
vi.mock("@/lib/llm/structured-insights", () => ({ generateStructuredInsights: mocks.generate }));
vi.mock("@/lib/customer-demo-boundary", () => ({ assertCustomerDemoEnabled: mocks.boundary }));
import { selfServeModel } from "@/lib/self-serve/model";
import { aiExecutionProfile } from "@/lib/llm/execution-mode";
import { demoBusinessScope } from "@/lib/demo-business";
const schema = z.object({ reply: z.string() });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("select response_provider")
    ? [{ response_provider: "mock", response_model: "mock" }] : [] }));
  mocks.generate.mockImplementation(async () => {
    expect(aiExecutionProfile()).toMatchObject({ mode: "real", provider: "groq", model: "openai/gpt-oss-20b" });
    return { actualModel: "openai/gpt-oss-20b", responseId: "fixture-response", value: { reply: "Generated fixture output" }, usage: { inputTokens: 10, outputTokens: 5 } };
  });
});
describe("real self-serve inference selection", () => {
  it("uses genuine-provider execution for demo setup and voice previews despite the test mock default", async () => {
    const result = await selfServeModel(demoBusinessScope().clientId, "preview", "Show the voice", { notes: ["Warm"] }, schema);
    expect(result).toEqual({ model: "openai/gpt-oss-20b", value: { reply: "Generated fixture output" } });
    expect(mocks.boundary).toHaveBeenCalledOnce();
    expect(mocks.generate).toHaveBeenCalledOnce();
    const usage = mocks.query.mock.calls.find(([sql]) => sql.includes("insert into agent_usage_events"));
    expect(usage?.[1]).toContain("groq");
  });
  it("surfaces provider failure and unexpected model identities without canned fallback", async () => {
    mocks.generate.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(selfServeModel(demoBusinessScope().clientId, "notes", "Describe style", {}, schema)).rejects.toThrow("Provider unavailable");
    mocks.generate.mockResolvedValueOnce({ actualModel: "mock", value: { reply: "Wrong model" } });
    await expect(selfServeModel(demoBusinessScope().clientId, "preview", "Show style", {}, schema)).rejects.toThrow("unexpected model");
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });
});
