import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateHandoffIntake } from "@/lib/agent/handoff-intake";
import { withAiExecutionProfile } from "@/lib/llm/execution-mode";
import type { GenerateAnswerInput } from "@/lib/llm/types";
import type { Channel, Conversation, Escalation } from "@/lib/types";

const mocks = vi.hoisted(() => ({ query: vi.fn(), retrieve: vi.fn(), generate: vi.fn(), usage: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: mocks.query }));
vi.mock("@/lib/knowledge/retrieve", () => ({ retrieveKnowledgeText: mocks.retrieve, retrieveKnowledge: mocks.retrieve }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(),
  getGenerationProvider: () => ({ generateGroundedAnswer: mocks.generate }), getEmbeddingProvider: vi.fn() }));
vi.mock("@/lib/brand-voice", () => ({ getPromptBrandVoiceProfile: async () => ({ document: null, examples: [] }) }));
vi.mock("@/lib/costing", async original => ({ ...await original<typeof import("@/lib/costing")>(), recordAgentUsageEvent: mocks.usage }));

const input = { channel: { id: "channel", client_id: "tenant", kind: "whatsapp", settings: {} } as Channel,
  conversation: { id: "conversation" } as Conversation,
  escalation: { id: "escalation", status: "open", reason_code: "complaint_or_refund" } as Escalation,
  customerMessageId: "customer" };
const source = { id: "chunk", source_id: "source", client_id: "tenant", content: "For order enquiries, our team uses the receipt reference and missing item details to review the issue.",
  chunk_index: 0, token_estimate: 30, score: 0.9, metadata: {} };
const question = "Our team will review this. Could you share your receipt reference and which item was missing?";
const profile = { mode: "real" as const, provider: "groq", model: "openai/gpt-oss-20b", embeddingProvider: "none", embeddingModel: "none", retrievalMode: "local_text" as const };
const run = () => withAiExecutionProfile(profile, () => generateHandoffIntake(input));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("from clients")) return { rows: [{ name: "Test restaurant", brand_voice: "Courteous" }] };
    if (sql.includes("from agent_configs")) return { rows: [{ response_provider: "groq", prompt_preamble: "Use approved business knowledge.",
      retrieval_threshold: 0.05, escalation_rules: {} }] };
    return { rows: [{ id: "customer", sender_role: "customer", body: "My order has a missing item and I want a refund." }] };
  });
  mocks.retrieve.mockResolvedValue([source]);
  mocks.generate.mockResolvedValue({ action: "escalate", answer: question, confidence: 0.9,
    reasonCode: "complaint_or_refund", reasonDetail: "Staff review needed.", citedChunkIds: [source.id], providerResponseId: "response" });
  mocks.usage.mockResolvedValue(undefined);
});

describe("model-driven handoff intake", () => {
  it("returns the model's source-grounded question and genuine generation metadata", async () => {
    const reply = await run();
    expect(reply).toMatchObject({ body: question, metadata: { generationMode: "real", responseProvider: "groq",
      handoffIntake: true, citedChunkIds: [source.id], providerResponseId: "response" } });
    const generation = mocks.generate.mock.calls[0][0] as GenerateAnswerInput;
    expect(generation.handoffReason).toBe("complaint_or_refund");
    expect(generation.retrievedChunks).toEqual([source]);
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({ operation: "generation" }));
  });

  it("passes already-supplied details and the actual business policy to the model", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from clients")) return { rows: [{ name: "Test restaurant", brand_voice: "Courteous" }] };
      if (sql.includes("from agent_configs")) return { rows: [{ retrieval_threshold: 0.05, escalation_rules: {} }] };
      return { rows: [{ id: "customer", sender_role: "customer", body: "Receipt ABC123: one drink is missing." }] };
    });
    await run();
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
      customerMessage: "Receipt ABC123: one drink is missing.",
      recentMessages: [],
      retrievedChunks: [source],
    }));
  });

  it("returns no generated reply when no usable approved knowledge is retrieved", async () => {
    mocks.retrieve.mockResolvedValue([]);
    expect(await run()).toBeNull();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("allows an optional question grounded in the customer's issue without inventing policy citations", async () => {
    mocks.generate.mockResolvedValue({ action: "escalate", answer: "Our team will help. Could you share your order reference and which item was missing?",
      confidence: 0.9, reasonCode: "intake", reasonDetail: "Optional context for staff.", citedChunkIds: [] });
    expect(await run()).toMatchObject({ body: "Our team will help. Could you share your order reference and which item was missing?",
      metadata: { citedChunkIds: [], intakeContextChunkIds: [source.id] } });
  });

  it.each([
    { answer: "Your refund has been processed.", citedChunkIds: [source.id] },
    { answer: question, citedChunkIds: ["invented-source"] },
    { answer: null, citedChunkIds: [] },
    { answer: "What is the weather forecast?", citedChunkIds: [] },
  ])("rejects an unsupported intake response: %j", async decision => {
    mocks.generate.mockResolvedValue({ action: "escalate", confidence: 0.9, ...decision });
    expect(await run()).toBeNull();
  });

  it("does not collect details when a critical issue also appears in a complaint", async () => {
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: string) => sql.includes("from messages")
      ? { rows: [{ id: "customer", sender_role: "customer", body: "I want a refund after a severe allergy reaction." }] }
      : original(sql));
    expect(await run()).toBeNull();
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({handoffAskForDetails:false}));
  });

  it.each(["We'll refund your order. Could you share the order details?",
    "We will issue a refund. Could you share the order details?",
    "Your refund will be approved. Could you share the order details?"])("rejects a promised staff action in a handoff acknowledgement: %s",async answer=>{
    mocks.generate.mockResolvedValue({action:"escalate",answer,confidence:0.9,citedChunkIds:[]});
    expect(await run()).toBeNull();
  });

  it("allows an acknowledgement when the model needs no more details", async () => {
    mocks.generate.mockResolvedValue({ action: "escalate", answer: "Our team will review this enquiry.",
      confidence: 0.9, citedChunkIds: [], providerResponseId: "acknowledgement" });
    expect(await run()).toMatchObject({ body: "Our team will review this enquiry.", metadata: { generationMode: "real" } });
  });
  it.each(['Could our team help you with halal options?','Would you like me to pass this to our team?','Could you share your order reference?'])(
    'repairs a permission offer or missing staff commitment: %s',async answer=>{
      mocks.generate.mockResolvedValueOnce({action:'escalate',answer,confidence:0.9,citedChunkIds:[]})
        .mockResolvedValueOnce({action:'escalate',answer:'Our team will help with this enquiry.',confidence:0.9,citedChunkIds:[]});
      expect(await run()).toMatchObject({body:'Our team will help with this enquiry.'});
      expect(mocks.generate).toHaveBeenCalledTimes(2);
    });

  it("returns no generated reply without retrying a failed model", async () => {
    mocks.generate.mockRejectedValue(new Error("Provider unavailable"));
    expect(await run()).toBeNull();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("repairs a rejected draft once with a real acknowledgement and meters both calls", async () => {
    mocks.generate.mockResolvedValueOnce({ action: "escalate", answer: "What is the weather forecast?", confidence: 0.9, citedChunkIds: [] })
      .mockResolvedValueOnce({ action: "escalate", answer: "Our team will review this enquiry.", confidence: 0.9,
        citedChunkIds: [], providerResponseId: "repaired-ack" });
    expect(await run()).toMatchObject({ body: "Our team will review this enquiry.",
      metadata: { generationMode: "real", providerResponseId: "repaired-ack" } });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.generate.mock.calls[1][0]).toMatchObject({ handoffAskForDetails: false });
    expect(mocks.usage).toHaveBeenCalledTimes(2);
  });

  it("uses a real model acknowledgement without collecting details for critical handoffs", async () => {
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: string) => sql.includes("from messages")
      ? { rows: [{ id: "customer", sender_role: "customer", body: "I had a severe allergy reaction." }] }
      : original(sql));
    mocks.generate.mockResolvedValue({ action: "escalate", answer: "Our team will review this enquiry.",
      confidence: 0.9, reasonCode: "critical", reasonDetail: "Team review.", citedChunkIds: [], providerResponseId: "real-ack" });
    expect(await run()).toMatchObject({ body: "Our team will review this enquiry.",
      metadata: { generationMode: "real", providerResponseId: "real-ack" } });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ handoffAskForDetails: false }));
  });

  it("does not call a real model for deterministic sessions or claimed handoffs", async () => {
    expect(await withAiExecutionProfile({ mode: "mock" }, () => generateHandoffIntake(input))).toBeNull();
    expect(await withAiExecutionProfile(profile, () => generateHandoffIntake({ ...input,
      escalation: { ...input.escalation, status: "claimed" } }))).toBeNull();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
