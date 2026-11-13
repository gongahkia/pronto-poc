import OpenAI from "openai";
import { z } from "zod";
import { aiExecutionProfile } from "@/lib/llm/execution-mode";
import { envApiKeyForProvider } from "@/lib/llm/credentials";
import { LlmConfigurationError, normalizeProviderError, ProviderRequestError } from "@/lib/llm/errors";
import { buildGroundedAnswerInstructions, buildGroundedAnswerUserInput } from "@/lib/llm/prompt";
import { demoModelChoices, GEMINI_EMBEDDING_MODEL } from "@/lib/llm/demo-models";
import { logInfo } from "@/lib/logger";
import { parseReservationExtraction, reservationExtractionJsonSchema } from "@/lib/llm/reservation-extraction";
import type { GenerateAnswerInput, GroundedAnswerDecision, LlmCallContext, LlmProvider } from "@/lib/llm/types";

const decisionSchema = z.object({ action: z.enum(["answer", "escalate"]), answer: z.string().nullable(),
  confidence: z.number().min(0).max(1), reasonCode: z.string().min(1), reasonDetail: z.string().min(1),
  citedChunkIds: z.array(z.string()) }).strict();
const jsonSchema = { type: "object", additionalProperties: false,
  properties: { action: { type: "string", enum: ["answer", "escalate"] }, answer: { type: ["string", "null"] },
    confidence: { type: "number" }, reasonCode: { type: "string" }, reasonDetail: { type: "string" },
    citedChunkIds: { type: "array", items: { type: "string" } } },
  required: ["action", "answer", "confidence", "reasonCode", "reasonDetail", "citedChunkIds"] };

export function freeProviderRequirements(provider: "gemini" | "groq"): string[] {
  const key = provider === "gemini" ? "GEMINI_API_KEY" : "GROQ_API_KEY";
  const tier = provider === "gemini" ? "PRONTO_GEMINI_FREE_TIER_CONFIRMED" : "PRONTO_GROQ_FREE_TIER_CONFIRMED";
  return [...(!envApiKeyForProvider(provider) ? [key] : []),
    ...(process.env.PRONTO_DEMO_REAL_AI_APPROVED !== "1" ? ["PRONTO_DEMO_REAL_AI_APPROVED=1"] : []),
    ...(process.env[tier] !== "1" ? [`${tier}=1 after checking the account's free tier`] : [])];
}
export function freeProviderApiKey(provider: "gemini" | "groq", clientId?: string): string {
  const missing = freeProviderRequirements(provider);
  if (missing.length) throw new LlmConfigurationError(provider, missing.join(", "));
  if (!aiExecutionProfile()?.syntheticDemo || clientId !== "00000000-0000-4000-8000-00000000a101")
    throw new LlmConfigurationError(provider, "Free-tier POC inference is restricted to synthetic PS.Cafe demo content.");
  return envApiKeyForProvider(provider)!;
}

export class FreeTierProvider implements LlmProvider {
  constructor(private readonly provider: "gemini" | "groq") {}
  async generateGroundedAnswer(input: GenerateAnswerInput): Promise<GroundedAnswerDecision> {
    if (!demoModelChoices.some(choice => choice.provider === this.provider && choice.model === input.responseModel))
      throw new LlmConfigurationError(this.provider, "The requested model is not in the verified POC allowlist.");
    const apiKey = freeProviderApiKey(this.provider, input.clientId);
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: input.timeoutMs ?? 25_000,
      baseURL: this.provider === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai/" : "https://api.groq.com/openai/v1/" });
    try {
      const limit = Math.min(4000, Math.max(64, input.maxOutputTokens ?? 800));
      const response = await client.chat.completions.create({
        model: input.responseModel,
        messages: [{ role: "system", content: buildGroundedAnswerInstructions(input) },
          { role: "user", content: buildGroundedAnswerUserInput(input) }],
        ...(this.provider === "gemini" ? { max_tokens: limit } : { max_completion_tokens: limit }),
        reasoning_effort: "low",
        response_format: { type: "json_schema", json_schema: { name: input.reservationExtraction ? "pronto_reservation_query" : "pronto_agent_decision", strict: true,
          schema: input.reservationExtraction ? reservationExtractionJsonSchema : input.handoffReason
            ? { ...jsonSchema, properties: { ...jsonSchema.properties, action: { type: "string", enum: ["escalate"] } } } : jsonSchema } },
      }, { signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? 25_000)]) : AbortSignal.timeout(input.timeoutMs ?? 25_000) });
      if (typeof response.model !== "string" || response.model.replace(/^models\//, "") !== input.responseModel)
        throw new ProviderRequestError(this.provider, "invalid_response");
      const choice = response.choices[0];
      if(choice?.finish_reason==='length')throw new ProviderRequestError(this.provider,'output_truncated');
      if(!choice||choice.finish_reason!=='stop'||choice.message.refusal)throw new ProviderRequestError(this.provider,'invalid_response');
      if (!choice.message.content) throw new ProviderRequestError(this.provider, "malformed_response");
      let decision: z.infer<typeof decisionSchema>;
      try { decision = input.reservationExtraction ? decisionSchema.parse(parseReservationExtraction(choice.message.content)) : decisionSchema.parse(JSON.parse(choice.message.content)); }
      catch { throw new ProviderRequestError(this.provider, "malformed_response"); }
      if (decision.action === "answer" && (!decision.answer || (!decision.citedChunkIds.length && !input.conversationalTurn)))
        decision = { ...decision, action: "escalate", answer: null, reasonCode: "ungrounded_answer",
          reasonDetail: "Provider returned an answer without source citations.", confidence: Math.min(decision.confidence, 0.4) };
      logInfo("llm.generation_completed", { clientId: input.clientId, conversationId: input.conversationId,
        requestId: input.requestId, provider: this.provider, model: input.responseModel, action: decision.action,
        providerRequestId: response.id });
      return { ...decision, providerResponseId: response.id, actualModel: response.model.replace(/^models\//, ""),
        ...(response.usage ? { usage: { inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        ...(response.usage.completion_tokens_details?.reasoning_tokens !== undefined ? { reasoningTokens: response.usage.completion_tokens_details.reasoning_tokens } : {}) } } : {}) };
    } catch (error) { throw normalizeProviderError(this.provider, error); }
  }

  async embed(texts: string[], model: string, context: LlmCallContext = {}): Promise<number[][]> {
    if (this.provider !== "gemini" || model !== GEMINI_EMBEDDING_MODEL)
      throw new LlmConfigurationError(this.provider, "Use Gemini gemini-embedding-2 for this POC's embeddings.");
    const key = freeProviderApiKey("gemini", context.clientId);
    if (!texts.length || texts.length > 32 || texts.some(text => !text.trim() || text.length > 16000))
      throw new LlmConfigurationError("gemini", "Embedding input exceeds the bounded synthetic batch.");
    const vectors: number[][] = [];
    // Embedding 2 aggregates multiple parts: send one document per request. No paid Batch API.
    for (const text of texts) {
      try {
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent", {
          method: "POST", redirect: "error", signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(context.timeoutMs ?? 25000)]) : AbortSignal.timeout(context.timeoutMs ?? 25000),
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ content: { parts: [{ text: context.embeddingTask === "query"
            ? `task: question answering | query: ${text}` : `title: none | text: ${text}` }] }, output_dimensionality: 1536 }),
        });
        if (!response.ok) throw normalizeProviderError("gemini", { status: response.status, headers: response.headers });
        const data = await response.json() as { embedding?: { values?: unknown } };
        const vector = data.embedding?.values;
        if (!Array.isArray(vector) || vector.length !== 1536 || vector.some(n => typeof n !== "number" || !Number.isFinite(n)) ||
            !vector.some(n => n !== 0)) throw new ProviderRequestError("gemini", "invalid_response");
        vectors.push(vector);
      } catch (error) { throw normalizeProviderError("gemini", error); }
    }
    logInfo("llm.embedding.completed", { provider: "gemini", model, inputCount: texts.length,
      embeddingCount: vectors.length, clientId: context.clientId, conversationId: context.conversationId });
    return vectors;
  }
}
