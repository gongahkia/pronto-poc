import type { KnowledgeChunk } from "@/lib/types";

export type GroundedAnswerDecision = {
  action: "answer" | "escalate";
  answer: string | null;
  confidence: number;
  reasonCode: string;
  reasonDetail: string;
  citedChunkIds: string[];
  usage?: LlmTokenUsage;
  providerResponseId?: string;
  actualModel?: string;
  contextChunkIds?: string[];
  promptTokenEstimate?: number;
  promptHash?: string;
};

export type LlmTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
};

export type GenerateAnswerInput = {
  requestId?: string;
  clientId?: string;
  conversationId?: string;
  clientName: string;
  currentDateTime?: string;
  brandVoice: string;
  brandVoiceDocument?: string | null;
  fewShotExamples?: Array<{
    customerMessage: string;
    idealResponse: string;
    notes?: string | null;
  }>;
  promptPreamble: string;
  customerMessage: string;
  recentMessages: { senderRole: string; body: string }[];
  retrievedChunks: KnowledgeChunk[];
  responseModel: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxPromptTokens?: number;
  signal?: AbortSignal;
  handoffReason?: string;
  handoffAskForDetails?: boolean;
  conversationalTurn?: boolean;
  escalationRules?: Record<string, unknown>;
  channelKind?: string;
  reservationExtraction?: { now: string; calendar: string[]; validationError?: string };
  reservationContext?: boolean;
};

export type LlmCallContext = {
  signal?: AbortSignal;
  timeoutMs?: number;
  requestId?: string;
  clientId?: string;
  conversationId?: string;
  operation?: "embedding" | "generation" | "provider_test";
  embeddingTask?: "document" | "query";
};

export type LlmProvider = {
  generateGroundedAnswer(input: GenerateAnswerInput): Promise<GroundedAnswerDecision>;
  embed(
    texts: string[],
    model: string,
    context?: LlmCallContext,
  ): Promise<number[][]>;
};
