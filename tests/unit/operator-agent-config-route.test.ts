import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  stageAgentConfig: vi.fn(),
  logWarn: vi.fn(),
  usesInstagramTestTextKnowledge: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireUser: mocks.requireUser,
}));

vi.mock("@/lib/assistant-drafts", () => ({
  stageAgentConfig: mocks.stageAgentConfig,
}));

vi.mock("@/lib/logger", () => ({
  logWarn: mocks.logWarn,
}));
vi.mock("@/lib/channels/instagram-test-ai", () => ({
  usesInstagramTestTextKnowledge: mocks.usesInstagramTestTextKnowledge, instagramTestModel: "openai/gpt-oss-20b",
}));

import { POST } from "@/app/api/operator/agent-config/route";

describe("operator agent config route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({
      userId: "operator-1",
      clientId: null,
      role: "operator",
    });
    mocks.stageAgentConfig.mockResolvedValue({ config: { id: "config-1" } });
    mocks.usesInstagramTestTextKnowledge.mockResolvedValue(false);
  });

  it("stages agent tuning for a client and returns JSON", async () => {
    const form = validForm();
    form.set("returnTo", "/operator/clients/client-1");

    const response = await POST(formRequest(form));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.stageAgentConfig).toHaveBeenCalledWith({
      clientId: "client-1",
      responseProvider: "mock",
      responseModel: "mock",
      embeddingProvider: "mock",
      embeddingModel: "mock",
      retrievalThreshold: 0.63,
      promptPreamble: "Answer from verified source material.",
      escalationRules: { sentimentTriggers: ["annoyed"] },
      actorUserId: "operator-1",
      changeReason: "Pilot tuning",
    });
  });

  it("accepts Anthropic response generation with OpenAI embeddings", async () => {
    const form = validForm();
    form.set("responseProvider", "anthropic");
    form.set("responseModel", "claude-sonnet-4-5");
    form.set("embeddingProvider", "openai");
    form.set("embeddingModel", "text-embedding-3-small");

    const response = await POST(formRequest(form));

    expect(response.status).toBe(200);
    expect(mocks.stageAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        responseProvider: "anthropic",
        responseModel: "claude-sonnet-4-5",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
      }),
    );
  });

  it("accepts Azure OpenAI response generation and embeddings", async () => {
    const form = validForm();
    form.set("responseProvider", "azure");
    form.set("responseModel", "gpt-5-deployment");
    form.set("embeddingProvider", "azure");
    form.set("embeddingModel", "embedding-deployment");

    const response = await POST(formRequest(form));

    expect(response.status).toBe(200);
    expect(mocks.stageAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        responseProvider: "azure",
        responseModel: "gpt-5-deployment",
        embeddingProvider: "azure",
        embeddingModel: "embedding-deployment",
      }),
    );
  });

  it("rejects invalid retrieval thresholds before staging", async () => {
    const form = validForm();
    form.set("retrievalThreshold", "1.5");

    const response = await POST(formRequest(form));

    expect(response.status).toBe(400);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "agent_config.invalid_retrieval_threshold",
      expect.objectContaining({ clientId: "client-1" }),
    );
    expect(mocks.stageAgentConfig).not.toHaveBeenCalled();
  });

  it("rejects escalation rules that are not a JSON object", async () => {
    const form = validForm();
    form.set("escalationRules", "[]");

    const response = await POST(formRequest(form));

    expect(response.status).toBe(400);
    expect(mocks.stageAgentConfig).not.toHaveBeenCalled();
  });
  it("accepts only the exact Groq/local-text pair in the verified Instagram workspace", async () => {
    const form = validForm();
    form.set("responseProvider", "groq"); form.set("responseModel", "openai/gpt-oss-20b");
    form.set("embeddingProvider", "none"); form.set("embeddingModel", "none");
    expect((await POST(formRequest(form))).status).toBe(400);
    mocks.usesInstagramTestTextKnowledge.mockResolvedValue(true);
    expect((await POST(formRequest(form))).status).toBe(200);
    mocks.stageAgentConfig.mockClear(); form.set("responseModel", "different-model");
    expect((await POST(formRequest(form))).status).toBe(400);
    expect(mocks.stageAgentConfig).not.toHaveBeenCalled();
  });
});

function validForm(): FormData {
  const form = new FormData();
  form.set("clientId", "client-1");
  form.set("responseProvider", "mock");
  form.set("responseModel", "mock");
  form.set("embeddingProvider", "mock");
  form.set("embeddingModel", "mock");
  form.set("retrievalThreshold", "0.63");
  form.set("promptPreamble", "Answer from verified source material.");
  form.set("escalationRules", JSON.stringify({ sentimentTriggers: ["annoyed"] }));
  form.set("changeReason", "Pilot tuning");
  return form;
}

function formRequest(form: FormData): Request {
  return new Request("http://localhost/api/operator/agent-config", {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
    },
    body: form,
  });
}
