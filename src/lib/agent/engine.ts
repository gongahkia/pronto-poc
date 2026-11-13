import { allowsSupportedFollowups } from './handoff-policy';
import { processingFailure } from "@/lib/agent/processing-error";
import { businessClock } from "@/lib/agent/business-clock";
import { requiresStaffFollowUp } from "@/lib/agent/decision-consistency";
import { normalizeProviderError } from "@/lib/llm/errors";
import { query, transaction } from "@/lib/db";
import { assistWithRestaurantBooking } from "@/lib/reservations/chope";
import { configuredChopeBrowserConnector } from "@/lib/reservations/chope-browser";
import { mayNeedReservationContext, prepareReservationContext, reservationReplyError, reservationClarificationContext, type ReservationModelContext } from "@/lib/reservations/model-context";
import { plainMessageText } from "@/lib/message-text";
import {
  evaluateAiDisclosure,
  evaluatePreGenerationGuardrails,
  evaluateRetrievalConfidence,
  evaluateSmallTalkGreeting,
} from "@/lib/agent/guardrails";
import { evaluatePostGenerationSelfCheck } from "@/lib/agent/self-check";
import { AgentTraceBuilder } from "@/lib/agent/trace";
import {
  integrationResultsToKnowledgeChunks,
  runIntegrationsForMessage,
} from "@/lib/agent/integration-tools";
import { getPromptBrandVoiceProfile } from "@/lib/brand-voice";
import {
  estimateEmbeddingCost,
  estimateGenerationCost,
  estimateGenerationCostFromTokens,
  recordAgentUsageEvent,
} from "@/lib/costing";
import {
  agentMaxConversationTokens,
  agentMaxOutputTokens,
  agentMaxPromptTokens,
  agentTimeoutMs,
} from "@/lib/agent/runtime-limits";
import { estimateTokens } from "@/lib/knowledge/chunk";
import { retrieveKnowledge, retrieveKnowledgeText } from "@/lib/knowledge/retrieve";
import { normalizeKnowledgeQuery, conversationKnowledgeQuery } from "@/lib/knowledge/query";
import { loadConversationContext } from "@/lib/agent/conversation-context";
import { withAgentTurn, assertTurnActive, turnBudgetSnapshot } from "@/lib/agent/turn-budget";
import { handoffQuestionsAllowed, handoffReplyFromDecision, type HandoffIntakeReply } from "@/lib/agent/handoff-intake";
import { appBaseUrl, shouldUseMockAi } from "@/lib/env";
import { getEmbeddingProvider, getGenerationProvider } from "@/lib/llm";
import { selectModel } from "@/lib/llm/catalog";
import { aiExecutionMode, aiExecutionProfile } from "@/lib/llm/execution-mode";
import {
  buildGroundedAnswerInstructions,
  buildGroundedAnswerUserInput,
} from "@/lib/llm/prompt";
import { logInfo, logWarn, redactErrorMessage } from "@/lib/logger";
import type { GroundedAnswerDecision } from "@/lib/llm/types";
import type { AgentConfig, ChannelKind, Client, KnowledgeChunk } from "@/lib/types";
import type { ReservationConnector } from "@/lib/reservations/types";

export type AgentRunResult = {
  action: "answered" | "escalated";
  responseText: string | null;
  reasonCode: string;
  reasonDetail: string;
  confidence: number;
  citedChunks: KnowledgeChunk[];
  agentMessageId?: string;
  escalationId?: string;
  csatUrl?: string;
};

export type AgentRunInput = {
  clientId: string;
  channelId: string;
  channelKind?: ChannelKind;
  conversationId: string;
  customerMessageId: string;
  customerMessage: string;
  requestId?: string;
  reservationConnector?: ReservationConnector;
};
export async function runAgentForMessage(input: AgentRunInput): Promise<AgentRunResult> {
  return withAgentTurn(() => runAgentTurn(input), { clientId: input.clientId });
}
async function runAgentTurn(input: AgentRunInput): Promise<AgentRunResult> {
  logInfo("agent.run_started", {
    requestId: input.requestId,
    clientId: input.clientId,
    channelId: input.channelId,
    conversationId: input.conversationId,
    customerMessageId: input.customerMessageId,
  });

  const trace = new AgentTraceBuilder({
    clientId: input.clientId,
    conversationId: input.conversationId,
    customerMessageId: input.customerMessageId,
    requestId: input.requestId,
  });
  trace.addStep("run_started");

  const [clientResult, configResult, recentMessagesResult, brandVoiceProfile] = await Promise.all([
    query<Client>("select * from clients where id = $1", [input.clientId]),
    query<AgentConfig>("select * from agent_configs where client_id = $1", [
      input.clientId,
    ]),
    loadConversationContext(input),
    getPromptBrandVoiceProfile(input.clientId),
  ]);

  const client = clientResult.rows[0];
  const config = configResult.rows[0];
  if (!client || !config) {
    throw new Error("Agent cannot run without client and config records.");
  }

  const recentMessages = [...recentMessagesResult].reverse().map(message => ({ senderRole: message.sender_role, body: message.body }));
  const normalizedKnowledgeQuery = conversationKnowledgeQuery(input.customerMessage, recentMessages);
  trace.addStep("conversation_context", { currentMessageId: input.customerMessageId,
    historyMessageIds: recentMessagesResult.map(message => message.id), usedForRetrieval: normalizedKnowledgeQuery.usedConversationContext });
  const requireModelReply = !shouldUseMockAi();
  // A tenant-declared policy conflict is a review signal, not customer-facing evidence.
  // Check before the restaurant booking path, which otherwise interprets a timing
  // policy question as an incomplete reservation request.
  if (normalizedKnowledgeQuery.categories.includes("reservations") &&
      /\b(cut.?off|last.*(?:reservation|booking)|(?:earliest|start).*reserv(?:ation|e)|weekend.*(?:reservation|booking))\b/i.test(input.customerMessage)) {
    const conflict = await query<{ id: string }>(
      `select id from knowledge_sources where client_id = $1
         and metadata->>'reviewStatus' ilike '%conflict%'
         and metadata->>'archived' is distinct from 'true'
         and jsonb_array_length(case when jsonb_typeof(metadata->'conflictingClaims') = 'array'
           then metadata->'conflictingClaims' else '[]'::jsonb end) > 1 limit 1`, [input.clientId]);
    if (conflict.rows[0]) {
      const escalation = await createEscalation({ ...input, reasonCode: "knowledge_conflict",
        reasonDetail: "Reviewed sources disagree about the reservation timing policy.", confidence: 1 });
      await trace.finalize({ status: "escalated", reasonCode: "knowledge_conflict",
        confidence: 1, escalationId: escalation.escalationId });
      return escalation;
    }
  }

  if (!requireModelReply && ["fnb", "restaurant", "food_and_beverage"].includes((client.vertical ?? "").toLowerCase())) {
    const booking = await assistWithRestaurantBooking({ clientId: input.clientId,
      message: input.customerMessage, businessProfile: client.business_profile ?? {},
      connector: input.reservationConnector ??
        configuredChopeBrowserConnector(input.clientId, client.business_profile ?? {}) ?? undefined });
    if (booking) {
      if (booking.action === "link" && booking.response) {
        const recorded = await recordDirectAgentAnswer(input, {
          answer: booking.response, confidence: 1, reasonCode: booking.reasonCode,
          metadata: { policy: "verified_booking_link", ...booking.metadata },
        });
        trace.addStep("booking_link_handoff");
        await trace.finalize({ status: "answered", reasonCode: booking.reasonCode,
          confidence: 1, agentMessageId: recorded.agentMessageId });
        return { action: "answered", responseText: booking.response,
          reasonCode: booking.reasonCode, reasonDetail: booking.reasonDetail ?? "Customer referred to an operator-verified Chope outlet link.",
          confidence: 1, citedChunks: [], agentMessageId: recorded.agentMessageId, csatUrl: recorded.csatUrl };
      }
      const escalation = await createEscalation({
        ...input, reasonCode: booking.reasonCode,
        reasonDetail: "Restaurant booking requires a verified booking link or human assistance.", confidence: 1,
      });
      trace.addStep("booking_handoff");
      await trace.finalize({ status: "escalated", reasonCode: booking.reasonCode,
        confidence: 1, escalationId: escalation.escalationId });
      return escalation;
    }
  }

  const smallTalkGreeting = evaluateSmallTalkGreeting(
    input.customerMessage,
    client.name,
  );
  if (!requireModelReply && smallTalkGreeting.shouldAnswer && smallTalkGreeting.answer) {
    logInfo("agent.small_talk_greeting_answered", {
      requestId: input.requestId,
      clientId: input.clientId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      customerMessageId: input.customerMessageId,
    });
    const recorded = await recordDirectAgentAnswer(input, {
      answer: smallTalkGreeting.answer,
      confidence: 1,
      reasonCode: "small_talk_greeting",
      metadata: {
        policy: "safe_small_talk",
      },
    });
    trace.addStep("small_talk_greeting_answered");
    await trace.finalize({
      status: "answered",
      reasonCode: "small_talk_greeting",
      confidence: 1,
      agentMessageId: recorded.agentMessageId,
    });

    return {
      action: "answered",
      responseText: smallTalkGreeting.answer,
      reasonCode: "small_talk_greeting",
      reasonDetail:
        "Customer sent a standalone greeting, so the agent answered without retrieval.",
      confidence: 1,
      citedChunks: [],
      agentMessageId: recorded.agentMessageId,
      csatUrl: recorded.csatUrl,
    };
  }

  const aiDisclosure = evaluateAiDisclosure(input.customerMessage, client.name);
  if (!requireModelReply && aiDisclosure.shouldDisclose && aiDisclosure.answer) {
    logInfo("agent.ai_disclosure_answered", {
      requestId: input.requestId,
      clientId: input.clientId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      customerMessageId: input.customerMessageId,
    });
    const recorded = await recordDirectAgentAnswer(input, {
      answer: aiDisclosure.answer,
      confidence: 1,
      reasonCode: "ai_disclosure",
      metadata: {
        policy: "direct_customer_disclosure",
      },
    });
    trace.addStep("ai_disclosure_answered");
    await trace.finalize({
      status: "answered",
      reasonCode: "ai_disclosure",
      confidence: 1,
      agentMessageId: recorded.agentMessageId,
    });

    return {
      action: "answered",
      responseText: aiDisclosure.answer,
      reasonCode: "ai_disclosure",
      reasonDetail: "Customer directly asked whether the agent is AI or human.",
      confidence: 1,
      citedChunks: [],
      agentMessageId: recorded.agentMessageId,
      csatUrl: recorded.csatUrl,
    };
  }

  const precheck = evaluatePreGenerationGuardrails(
    input.customerMessage,
    requireModelReply ? { ...config.escalation_rules, disabledReasonCodes: [
      ...(Array.isArray(config.escalation_rules.disabledReasonCodes) ? config.escalation_rules.disabledReasonCodes : []),
      "complaint_or_refund", "transactional_action", "urgent_or_negative_sentiment",
    ] } : config.escalation_rules,
    input.channelKind,
  );
  if (precheck.shouldEscalate) {
    logInfo("agent.pre_generation_escalated", {
      requestId: input.requestId,
      clientId: input.clientId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      customerMessageId: input.customerMessageId,
      reasonCode: precheck.reasonCode,
      confidence: precheck.confidence,
    });
    trace.addStep("pre_generation_escalated", {
      reasonCode: precheck.reasonCode,
      confidence: precheck.confidence,
    });
    const escalation = await createEscalation({
      ...input,
      reasonCode: precheck.reasonCode,
      reasonDetail: precheck.reasonDetail,
      confidence: precheck.confidence,
    });
    await trace.finalize({
      status: "escalated",
      reasonCode: precheck.reasonCode,
      confidence: precheck.confidence,
      escalationId: escalation.escalationId,
    });
    return escalation;
  }

  trace.addStep("pre_generation_passed", { businessTriage: requireModelReply ? "model" : "rules" });

  const localTextRetrieval = aiExecutionProfile()?.retrievalMode === "local_text";
  const responseProvider =
    aiExecutionMode() === "mock" ? "mock" : aiExecutionProfile()?.provider ?? process.env.PRONTO_LLM_PROVIDER ?? config.response_provider ?? "openai";
  const embeddingProvider =
    aiExecutionMode() === "mock" ? "mock" : aiExecutionProfile()?.embeddingProvider ?? process.env.PRONTO_EMBEDDING_PROVIDER ?? config.embedding_provider;
  const embeddingModel =
    aiExecutionProfile()?.embeddingModel ?? process.env.PRONTO_EMBEDDING_MODEL ?? config.embedding_model;
  const responseModel = selectModel({
    provider: responseProvider,
    configuredModel: aiExecutionProfile()?.model ?? config.response_model,
    ignoreEnvironment: Boolean(aiExecutionProfile()?.model),
    task: "agent_answer",
  });

  logInfo("agent.provider_selected", {
    requestId: input.requestId,
    clientId: input.clientId,
    channelId: input.channelId,
    conversationId: input.conversationId,
    responseProvider: responseModel.provider,
    responseModel: responseModel.model,
    embeddingProvider,
    embeddingModel,
    retrievalMode: localTextRetrieval ? "local_text" : "hybrid_vector",
  });
  trace.addStep("provider_selected", {
    responseProvider: responseModel.provider,
    responseModel: responseModel.model,
    embeddingProvider,
    embeddingModel,
    retrievalMode: localTextRetrieval ? "local_text" : "hybrid_vector",
  });

  let staticChunks: KnowledgeChunk[];
  if (localTextRetrieval) {
    staticChunks = await retrieveKnowledgeText(input.clientId, normalizedKnowledgeQuery.searchQuery, 5, {
      requestId: input.requestId, conversationId: input.conversationId,
    });
    trace.addStep("local_text_retrieval", { mode: "local_text", embeddingCalls: 0,
      sources: staticChunks.map(chunk => ({ chunkId: chunk.id, sourceId: chunk.source_id,
        version: chunk.metadata.sourceVersion ?? null, contentHash: chunk.metadata.sourceContentHash,
        approvalEvidence: chunk.metadata.approvalEvidence })) });
    if (requireModelReply && !staticChunks.length && (smallTalkGreeting.shouldAnswer || aiDisclosure.shouldDisclose)) {
      staticChunks = await retrieveKnowledgeText(input.clientId, normalizeKnowledgeQuery(client.name).searchQuery, 5,
        { requestId: input.requestId, conversationId: input.conversationId });
      staticChunks = staticChunks.map(chunk => ({ ...chunk, metadata: { ...chunk.metadata, retrievalPurpose: "identity_fallback" } }));
      trace.addStep("identity_fallback", { supportsBusinessAnswer: false, chunkIds: staticChunks.map(chunk => chunk.id) });
    }
  } else {
    let embedding: number[];
    try {
      [embedding] = await getEmbeddingProvider(embeddingProvider).embed(
        [normalizedKnowledgeQuery.embeddingText],
        embeddingModel,
        {
          requestId: input.requestId,
          clientId: input.clientId,
          conversationId: input.conversationId,
          operation: "embedding",
          embeddingTask: "query",
        },
      );
    } catch (error) {
      const errorMessage = providerErrorMessage(error);
      logWarn("agent.embedding_provider_failed", {
        requestId: input.requestId,
        clientId: input.clientId,
        channelId: input.channelId,
        conversationId: input.conversationId,
        embeddingProvider,
        embeddingModel,
        error: errorMessage,
      });
      trace.addStep("embedding_provider_failed", {
        embeddingProvider,
        embeddingModel,
        errorMessage,
      });
      const failure = processingFailure(error).code === "processing_error" ? normalizeProviderError(embeddingProvider,error) : error;
      await trace.finalize({ status: "failed", reasonCode: processingFailure(failure).code, confidence: 0,
        responseProvider: responseModel.provider, responseModel: responseModel.model,
        embeddingProvider, embeddingModel, errorMessage: providerErrorMessage(failure) });
      throw failure;
    }
    await safeRecordUsage({
      clientId: input.clientId,
      conversationId: input.conversationId,
      channelId: input.channelId,
      provider: embeddingProvider,
      model: embeddingModel,
      operation: "embedding",
      estimate: estimateEmbeddingCost(normalizedKnowledgeQuery.embeddingText),
      metadata: {
        requestId: input.requestId,
        customerMessageId: input.customerMessageId,
        normalizedKnowledgeCategories: normalizedKnowledgeQuery.categories,
      },
    });
    staticChunks = await retrieveKnowledge(input.clientId, embedding, 5, {
      requestId: input.requestId,
      conversationId: input.conversationId,
      queryText: normalizedKnowledgeQuery.searchQuery,
      embeddingModel,
      ...(aiExecutionMode() === "real" ? { embeddingProvider } : {}),
    });
  }
  const integrationResults = await runIntegrationsForMessage({
    clientId: input.clientId,
    message: input.customerMessage,
    requestId: input.requestId,
  });
  if (integrationResults.length) {
    trace.addStep("integration_tools_invoked", {
      providers: integrationResults.map((result) => result.provider),
    });
  }
  const integrationChunks = integrationResultsToKnowledgeChunks(
    input.clientId,
    integrationResults,
  );
  let reservationContext: ReservationModelContext | null = null;
  let reservationPlanningError: unknown;
  if (requireModelReply && ["fnb", "restaurant", "food_and_beverage"].includes((client.vertical ?? "").toLowerCase()) &&
      mayNeedReservationContext(input.customerMessage, recentMessages)) {
    try {
      reservationContext = await prepareReservationContext({
        generation: { ...input, clientName: client.name, brandVoice: client.brand_voice, promptPreamble: config.prompt_preamble,
          recentMessages, retrievedChunks: [], responseModel: responseModel.model, timeoutMs: agentTimeoutMs() },
        provider: getGenerationProvider(responseModel.provider), profile: client.business_profile ?? {},
        connector: input.reservationConnector ?? configuredChopeBrowserConnector(input.clientId, client.business_profile ?? {}),
        onExtraction: async decision => {
          trace.addStep("reservation_query_inferred", { provider: responseModel.provider, model: responseModel.model,
            providerResponseId: decision.providerResponseId ?? null, reasonDetail: decision.reasonDetail, extractedQuery: decision.answer });
          await safeRecordUsage({ clientId: input.clientId, conversationId: input.conversationId, channelId: input.channelId,
            provider: responseModel.provider, model: responseModel.model, operation: "generation",
            estimate: decision.usage ? estimateGenerationCostFromTokens({ ...decision.usage, costLabel: responseModel.costLabel })
              : estimateGenerationCost({ inputText: input.customerMessage, outputText: JSON.stringify(decision), costLabel: responseModel.costLabel }),
            metadata: { purpose: "reservation_query", customerMessageId: input.customerMessageId,
              providerResponseId: decision.providerResponseId ?? null, usageSource: decision.usage ? "provider" : "estimate" } });
        },
      });
      if (reservationContext) trace.addStep("chope_availability_checked", reservationContext.metadata);
    } catch (error) { reservationPlanningError = error; }
  }
  if (reservationPlanningError) {
    const failure = processingFailure(reservationPlanningError).code === "processing_error"
      ? normalizeProviderError(responseModel.provider,reservationPlanningError) : reservationPlanningError;
    await trace.finalize({status:"failed",reasonCode:processingFailure(failure).code,confidence:0,
      responseProvider:responseModel.provider,responseModel:responseModel.model,
      errorMessage:providerErrorMessage(failure)});
    throw failure;
  }
  const chunks = [...(reservationContext ? [reservationContext.chunk] : []), ...integrationChunks, ...staticChunks];
  trace.addStep("knowledge_context", { sources: chunks.map(chunk => ({ chunkId: chunk.id,
    sourceId: chunk.source_id, title: typeof chunk.metadata.sourceTitle === "string" ? chunk.metadata.sourceTitle : null,
    url: typeof chunk.metadata.sourceUrl === "string" ? chunk.metadata.sourceUrl : null,
    excerpt: chunk.content.slice(0, 500), version: chunk.metadata.sourceVersion ?? null, snapshot: true })) });
  const retrievalThreshold = Number(config.retrieval_threshold);
  const retrievalCheck = evaluateRetrievalConfidence(
    chunks[0]?.score,
    retrievalThreshold,
  );
  logInfo("agent.retrieval_evaluated", {
    requestId: input.requestId,
    clientId: input.clientId,
    channelId: input.channelId,
    conversationId: input.conversationId,
    customerMessageId: input.customerMessageId,
    topScore: chunks[0]?.score ?? null,
    threshold: retrievalThreshold,
    shouldEscalate: retrievalCheck.shouldEscalate,
    reasonCode: retrievalCheck.reasonCode,
    normalizedKnowledgeCategories: normalizedKnowledgeQuery.categories,
  });
  trace.addStep("retrieval_evaluated", {
    topScore: chunks[0]?.score ?? null,
    threshold: retrievalThreshold,
    chunkCount: chunks.length,
  });

  const conversationTokenEstimate = estimateTokens(
    [
      input.customerMessage,
      ...recentMessagesResult.map((message) => message.body),
      ...chunks.map((chunk) => chunk.content),
    ].join("\n"),
  );
  if (conversationTokenEstimate > agentMaxConversationTokens()) {
    trace.addStep("conversation_token_cap_escalated", {
      conversationTokenEstimate,
      maxConversationTokens: agentMaxConversationTokens(),
    });
    const escalation = await createEscalation({
      ...input,
      reasonCode: "context_budget_exceeded",
      reasonDetail: `Estimated context ${conversationTokenEstimate} tokens exceeds the configured agent cap.`,
      confidence: 1,
    });
    await trace.finalize({
      status: "escalated",
      reasonCode: "context_budget_exceeded",
      confidence: 1,
      responseProvider: responseModel.provider,
      responseModel: responseModel.model,
      embeddingProvider,
      embeddingModel,
      retrievalTopScore: chunks[0]?.score ?? null,
      retrievalThreshold,
      retrievalChunks: chunks,
      escalationId: escalation.escalationId,
    });
    return escalation;
  }

  if (retrievalCheck.shouldEscalate && !(smallTalkGreeting.shouldAnswer || aiDisclosure.shouldDisclose)) {
    const escalation = await createEscalation({
      ...input,
      reasonCode: retrievalCheck.reasonCode,
      reasonDetail: retrievalCheck.reasonDetail,
      confidence: retrievalCheck.confidence,
    });
    await trace.finalize({
      status: "escalated",
      reasonCode: retrievalCheck.reasonCode,
      confidence: retrievalCheck.confidence,
      responseProvider: responseModel.provider,
      responseModel: responseModel.model,
      embeddingProvider,
      embeddingModel,
      retrievalTopScore: chunks[0]?.score ?? null,
      retrievalThreshold,
      retrievalChunks: chunks,
      escalationId: escalation.escalationId,
    });
    return escalation;
  }

  const generationInput = {
    requestId: input.requestId,
    clientId: input.clientId,
    conversationId: input.conversationId,
    clientName: client.name,
    currentDateTime: businessClock(client.business_profile ?? {}),
    brandVoice: client.brand_voice,
    brandVoiceDocument: brandVoiceProfile.document?.content ?? null,
    fewShotExamples: brandVoiceProfile.examples.map((example) => ({
      customerMessage: example.customer_message,
      idealResponse: example.ideal_response,
      notes: example.notes,
    })),
    promptPreamble: config.prompt_preamble,
    customerMessage: input.customerMessage,
    recentMessages,
    retrievedChunks: chunks,
    responseModel: responseModel.model,
    maxOutputTokens: agentMaxOutputTokens(),
    timeoutMs: agentTimeoutMs(),
    maxPromptTokens: agentMaxPromptTokens(),
    conversationalTurn: requireModelReply && (smallTalkGreeting.shouldAnswer || aiDisclosure.shouldDisclose),
    escalationRules: config.escalation_rules,
    channelKind: input.channelKind,
    reservationContext: !!reservationContext,
  };

  let decision: GroundedAnswerDecision | undefined;
  const generationProvider = responseModel.provider;
  const generationModel = responseModel.model;
  const generationCostLabel = responseModel.costLabel;
  let providerError: unknown = reservationPlanningError;
  try {
    if (!providerError) decision = await getGenerationProvider(responseModel.provider).generateGroundedAnswer({
      ...generationInput,
      responseModel: responseModel.model,
    });
  } catch (error) {
    providerError = error;
  }
  if (!decision) {
    const errorMessage =
      providerError instanceof Error
        ? providerErrorMessage(providerError)
        : providerError
          ? redactErrorMessage(providerError)
          : "No LLM provider was available.";
    const failure = processingFailure(providerError).code === "processing_error" ? normalizeProviderError(responseModel.provider,providerError) : providerError;
    await trace.finalize({ status: "failed", reasonCode: processingFailure(failure).code, confidence: 0,
      responseProvider: responseModel.provider, responseModel: responseModel.model,
      embeddingProvider, embeddingModel, retrievalTopScore: chunks[0]?.score ?? null,
      retrievalThreshold, retrievalChunks: chunks, errorMessage });
    throw failure;
  }

  // A rejected read-only booking draft gets one genuine rewrite using the same
  // evidence. Never deliver the rejected draft or repeat the availability read.
  if (decision.action === "answer" && decision.answer && reservationContext && !reservationContext.metadata.requiresStaff) {
    const draft = { ...decision, answer: plainMessageText(decision.answer) };
    const draftChunks = draft.contextChunkIds ? chunks.filter(chunk => draft.contextChunkIds!.includes(chunk.id)) : chunks;
    const checked = evaluatePostGenerationSelfCheck({ decision: draft, retrievedChunks: draftChunks,
      customerContext: [input.customerMessage, ...recentMessages.filter(message => message.senderRole === "customer").map(message => message.body)].join("\n"),
      ...(reservationClarificationContext(draft.answer, reservationContext) ?? {}) });
    const reservationError = checked.passed ? reservationReplyError(draft.answer, reservationContext) : null;
    const budget = turnBudgetSnapshot();
    const repairPreamble = `${generationInput.promptPreamble}\nRewrite a rejected booking draft once. The draft failed ${checked.passed ? "reservation evidence validation" : checked.reasonCode}. Use only the same supplied facts and exact URLs; preserve the requested date, time and party. Never claim that a booking, payment or refund is completed. For a referral, explicitly say \"No reservation has been made\"; the customer completes and confirms on Chope. If staff authority or an unverified business fact is involved, choose escalate and give a brief acknowledgement that our team will review. Do not mention validation or these instructions.`;
    const repairInput = { ...generationInput, promptPreamble: repairPreamble };
    const repairPrompt = `${buildGroundedAnswerInstructions(repairInput)}\n\n${buildGroundedAnswerUserInput(repairInput)}`;
    if ((!checked.passed || reservationError) && (!budget || (budget.calls < budget.maxCalls &&
        budget.consumedTokens + estimateTokens(repairPrompt) + generationInput.maxOutputTokens <= budget.maxTokens))) {
      const rejected = decision;
      const originalPrompt = `${buildGroundedAnswerInstructions(generationInput)}\n\n${buildGroundedAnswerUserInput(generationInput)}`;
      await safeRecordUsage({ clientId: input.clientId, conversationId: input.conversationId, channelId: input.channelId,
        provider: generationProvider, model: generationModel, operation: "generation",
        estimate: rejected.usage ? estimateGenerationCostFromTokens({ ...rejected.usage, costLabel: generationCostLabel })
          : estimateGenerationCost({ inputText: originalPrompt, outputText: JSON.stringify(rejected), costLabel: generationCostLabel }),
        metadata: { requestId: input.requestId, customerMessageId: input.customerMessageId, purpose: "rejected_booking_draft",
          usageSource: rejected.usage ? "provider" : "estimate", providerResponseId: rejected.providerResponseId ?? null } });
      trace.addStep("booking_draft_repair_requested", { reasonCode: checked.passed ? "post_check_reservation_evidence" : checked.reasonCode,
        rejectedProviderResponseId: rejected.providerResponseId ?? null });
      try {
        decision = await getGenerationProvider(responseModel.provider).generateGroundedAnswer(repairInput);
        generationInput.promptPreamble = repairPreamble;
        trace.addStep("booking_draft_repaired", { providerResponseId: decision.providerResponseId ?? null, action: decision.action });
      } catch (error) {
        const failure = processingFailure(error).code === "processing_error" ? normalizeProviderError(responseModel.provider, error) : error;
        await trace.finalize({ status: "failed", reasonCode: processingFailure(failure).code, confidence: 0,
          responseProvider: responseModel.provider, responseModel: responseModel.model, embeddingProvider, embeddingModel,
          retrievalTopScore: chunks[0]?.score ?? null, retrievalThreshold, retrievalChunks: chunks,
          errorMessage: providerErrorMessage(error) });
        throw failure;
      }
    }
  }

  // Normalize formatting before validation, persistence and outbound delivery.
  const originalAnswer = decision.answer;
  if (decision.answer) decision = { ...decision, answer: plainMessageText(decision.answer) };
  let needsOwnershipAcknowledgement = false;
  if (requiresStaffFollowUp(decision, !!reservationContext, input.customerMessage)) {
    // An admission alone does not tell the customer that staff will follow up.
    // Let the existing bounded intake generate a real acknowledgement instead
    // of delivering that incomplete draft as the handoff reply.
    needsOwnershipAcknowledgement = !/\b(?:our|the)\s+team\b/i.test(decision.answer ?? "");
    trace.addStep("staff_followup_ownership_required", { originalAction: decision.action, originalReasonCode: decision.reasonCode });
    decision = { ...decision, action: "escalate", reasonCode: "staff_followup_required",
      reasonDetail: "The reply requires or promises team follow-up, so the conversation must be handed to staff." };
  }
  const effectiveChunks = decision.contextChunkIds ? chunks.filter(chunk => decision.contextChunkIds!.includes(chunk.id)) : chunks;
  const citedChunks = effectiveChunks.filter((chunk) =>
    decision.citedChunkIds.includes(chunk.id),
  );
  const promptText = `${buildGroundedAnswerInstructions(generationInput)}\n\n${buildGroundedAnswerUserInput(generationInput)}`;
  await safeRecordUsage({
    clientId: input.clientId,
    conversationId: input.conversationId,
    channelId: input.channelId,
    provider: generationProvider,
    model: generationModel,
    operation: "generation",
    estimate: decision.usage
      ? estimateGenerationCostFromTokens({
          inputTokens: decision.usage.inputTokens,
          outputTokens: decision.usage.outputTokens,
          reasoningTokens: decision.usage.reasoningTokens,
          costLabel: generationCostLabel,
        })
      : estimateGenerationCost({
          inputText: promptText,
          outputText: JSON.stringify(decision),
          costLabel: generationCostLabel,
        }),
    metadata: {
      requestId: input.requestId,
      customerMessageId: input.customerMessageId,
      reasonCode: decision.reasonCode,
      usageSource: decision.usage ? "provider" : "estimate",
      providerResponseId: decision.providerResponseId ?? null,
      modelIdentitySource: decision.actualModel ? "provider" : "configuration",
      retrievalMode: localTextRetrieval ? "local_text" : "hybrid_vector",
    },
  });

  trace.addStep("model_decision", { action: decision.action, reasonCode: decision.reasonCode,
    reasonDetail: decision.reasonDetail, confidence: decision.confidence, citedChunkCount: decision.citedChunkIds.length });
  const bookingClarification = reservationContext ? reservationClarificationContext(decision.answer ?? "", reservationContext) : null;
  let selfCheck = evaluatePostGenerationSelfCheck({
    decision,
    retrievedChunks: effectiveChunks,
    customerContext: [input.customerMessage, ...recentMessages.filter(message => message.senderRole === "customer").map(message => message.body)].join("\n"),
    ...(generationInput.conversationalTurn ? { operationalContext:
      `Business identity: ${client.name}. Role: AI assistant. Scope: greet, welcome and thank customers; acknowledge thanks and goodbyes; help with enquiries; direct customers to our team when needed.` } : {}),
    ...(bookingClarification ?? {}),
  });
  if (selfCheck.passed && decision.action === "answer" && decision.answer && reservationContext) {
    const error = reservationReplyError(decision.answer, reservationContext);
    if (error) selfCheck = { passed: false, reasonCode: "post_check_reservation_evidence", reasonDetail: error, confidence: 1 };
  }
  if (!selfCheck.passed) {
    logInfo("agent.self_check_escalated", {
      requestId: input.requestId,
      clientId: input.clientId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      customerMessageId: input.customerMessageId,
      reasonCode: selfCheck.reasonCode,
      confidence: selfCheck.confidence,
    });
    trace.addStep("self_check_escalated", {
      reasonCode: selfCheck.reasonCode,
      confidence: selfCheck.confidence,
    });
    const escalation = await createEscalation({
      ...input,
      reasonCode: selfCheck.reasonCode,
      reasonDetail: selfCheck.reasonDetail,
      confidence: selfCheck.confidence,
    });
    await trace.finalize({
      status: "escalated",
      reasonCode: selfCheck.reasonCode,
      confidence: selfCheck.confidence,
      responseProvider: responseModel.provider,
      responseModel: responseModel.model,
      embeddingProvider,
      embeddingModel,
      retrievalTopScore: chunks[0]?.score ?? null,
      retrievalThreshold,
      retrievalChunks: chunks,
      citedChunkIds: decision.citedChunkIds,
      promptText,
      promptHash: decision.promptHash, promptTokenEstimate: decision.promptTokenEstimate,
      escalationId: escalation.escalationId,
    });
    return escalation;
  }

  if (decision.action === "answer") trace.addStep("self_check_passed", { reasonCode: selfCheck.reasonCode, reasonDetail: selfCheck.reasonDetail });

  if (decision.action === "escalate" || !decision.answer || (!citedChunks.length && !generationInput.conversationalTurn)) {
    logInfo("agent.model_decision_escalated", {
      requestId: input.requestId,
      clientId: input.clientId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      customerMessageId: input.customerMessageId,
      reasonCode: decision.reasonCode,
      confidence: decision.confidence,
      citedChunkCount: citedChunks.length,
    });
    trace.addStep("model_decision_escalated", {
      reasonCode: decision.reasonCode,
      confidence: decision.confidence,
      citedChunkCount: citedChunks.length,
    });
    const escalation = await createEscalation({
      ...input,
      handoffReply: needsOwnershipAcknowledgement ? undefined : handoffReplyFromDecision({ decision, chunks: effectiveChunks, customerMessage: input.customerMessage,
        askForDetails: handoffQuestionsAllowed(input.customerMessage, config.escalation_rules, input.channelKind),
        provider: responseModel.provider, model: responseModel.model, generationMode: shouldUseMockAi() ? "mock" : "real",
        retrievalMode: localTextRetrieval ? "local_text" : "hybrid_vector" }) ?? undefined,
      reasonCode: decision.reasonCode,
      reasonDetail:
        decision.action === "answer" && !citedChunks.length
          ? "The answer had no valid source chunk citation."
          : decision.reasonDetail,
      confidence: decision.confidence,
    });
    await trace.finalize({
      status: "escalated",
      reasonCode: decision.reasonCode,
      confidence: decision.confidence,
      responseProvider: generationProvider,
      responseModel: generationModel,
      embeddingProvider,
      embeddingModel,
      retrievalTopScore: chunks[0]?.score ?? null,
      retrievalThreshold,
      retrievalChunks: chunks,
      citedChunkIds: decision.citedChunkIds,
      promptText,
      promptHash: decision.promptHash, promptTokenEstimate: decision.promptTokenEstimate,
      escalationId: escalation.escalationId,
    });
    return escalation;
  }

  const csatUrl = buildCsatUrl(input.conversationId);
  assertTurnActive();
  const agentMessage = await query<{ id: string }>(
    `
      insert into messages (conversation_id, client_id, channel_id, external_message_id, sender_role, body, metadata)
      values ($1, $2, $3, $4, 'agent', $5, $6)
      on conflict (channel_id, external_message_id) do update set external_message_id = excluded.external_message_id
      returning id
    `,
    [
      input.conversationId,
      input.clientId,
      input.channelId,
      `agent-${input.customerMessageId}`,
      decision.answer,
      {
        confidence: decision.confidence,
        reasonCode: decision.reasonCode,
        citedChunkIds: decision.citedChunkIds,
        generationMode: aiExecutionMode() ?? (process.env.PRONTO_USE_MOCK_AI === "1" ? "mock" : "real"),
        conversationalTurn: generationInput.conversationalTurn,
        responseProvider: responseModel.provider,
        responseModel: responseModel.model,
        providerResponseId: decision.providerResponseId ?? null,
        modelIdentitySource: decision.actualModel ? "provider" : "configuration",
        retrievalMode: localTextRetrieval ? "local_text" : "hybrid_vector",
        sourceProvenance: localTextRetrieval ? citedChunks.map(chunk => ({ chunkId: chunk.id, sourceId: chunk.source_id,
          version: chunk.metadata.sourceVersion ?? null, contentHash: chunk.metadata.sourceContentHash })) : undefined,
        postGenerationSelfCheck: {
          reasonCode: selfCheck.reasonCode,
          reasonDetail: selfCheck.reasonDetail,
        },
        csatUrl,
        customerMessageId: input.customerMessageId,
        ...(originalAnswer !== decision.answer ? { providerAnswerBeforeFormatting: originalAnswer } : {}),
        ...(reservationContext ? { reservation: reservationContext.metadata } : {}),
      },
    ],
  );

  await query(
    "update conversations set last_message_at = now() where id = $1 and client_id = $2 and status = 'active'",
    [input.conversationId, input.clientId],
  );
  await query(
    "insert into metric_events (client_id, event_type, value, metadata) values ($1, 'agent_answered', $2, $3)",
    [input.clientId, decision.confidence, { citedChunkIds: decision.citedChunkIds }],
  );

  logInfo("agent.run_answered", {
    requestId: input.requestId,
    clientId: input.clientId,
    channelId: input.channelId,
    conversationId: input.conversationId,
    customerMessageId: input.customerMessageId,
    agentMessageId: agentMessage.rows[0].id,
    reasonCode: decision.reasonCode,
    confidence: decision.confidence,
    citedChunkCount: citedChunks.length,
  });
  trace.addStep("run_answered", {
    agentMessageId: agentMessage.rows[0].id,
    reasonCode: decision.reasonCode,
  });
  await trace.finalize({
    status: "answered",
    reasonCode: decision.reasonCode,
    confidence: decision.confidence,
    responseProvider: generationProvider,
    responseModel: generationModel,
    embeddingProvider,
    embeddingModel,
    retrievalTopScore: chunks[0]?.score ?? null,
    retrievalThreshold,
    retrievalChunks: chunks,
    citedChunkIds: decision.citedChunkIds,
    promptText,
    promptHash: decision.promptHash, promptTokenEstimate: decision.promptTokenEstimate,
    agentMessageId: agentMessage.rows[0].id,
  });

  return {
    action: "answered",
    responseText: decision.answer,
    reasonCode: decision.reasonCode,
    reasonDetail: decision.reasonDetail,
    confidence: decision.confidence,
    citedChunks,
    agentMessageId: agentMessage.rows[0].id,
    csatUrl: `${csatUrl}?messageId=${agentMessage.rows[0].id}`,
  };
}

export async function createEscalation(input: {
  clientId: string;
  channelId: string;
  conversationId: string;
  customerMessageId: string;
  customerMessage: string;
  reasonCode: string;
  reasonDetail: string;
  confidence: number;
  requestId?: string;
  handoffReply?: HandoffIntakeReply;
}): Promise<AgentRunResult> {
  assertTurnActive();
  const followups = allowsSupportedFollowups(input.reasonCode, input.customerMessage);
  return transaction(async (client) => {
    const customerMessage = await client.query<{ id: string }>(
      "select id from messages where id = $1 and client_id = $2 and conversation_id = $3 for update",
      [input.customerMessageId, input.clientId, input.conversationId],
    );
    if (!customerMessage.rows[0]) throw new Error("Escalation customer message was not found.");
    assertTurnActive();
    await client.query(
      `update conversations set status = case when $4 and status='active' then 'active'::conversation_status else 'escalated'::conversation_status end,
       last_message_at = now(), ai_should_respond=($4 and status='active'),
       owner_action_required=true, urgency=coalesce(urgency,
         case when $3='urgent_or_negative_sentiment' then 'short_term' else 'long_term' end)
       where id = $1 and client_id = $2`,
      [input.conversationId, input.clientId, input.reasonCode, followups],
    );

    const existing = await client.query<{ id: string }>(
      `select id from escalations where client_id = $1 and conversation_id = $2 and message_id = $3
       order by created_at, id limit 1`,
      [input.clientId, input.conversationId, input.customerMessageId],
    );
    const escalation = existing.rows[0] ? existing : await client.query<{ id: string }>(
      `
        insert into escalations (client_id, conversation_id, message_id, reason_code, reason_detail, confidence, allow_ai_followups)
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id
      `,
      [
        input.clientId,
        input.conversationId,
        input.customerMessageId,
        input.reasonCode,
        input.reasonDetail,
        input.confidence,
        followups,
      ],
    );

    if (input.handoffReply) {
      assertTurnActive();
      await client.query(`insert into messages(conversation_id,client_id,channel_id,external_message_id,sender_role,body,metadata)
        values($1,$2,$3,$4,'agent',$5,$6::jsonb) on conflict(channel_id,external_message_id) do nothing`,
      [input.conversationId, input.clientId, input.channelId, `agent-handoff-${escalation.rows[0].id}`, input.handoffReply.body,
        JSON.stringify({ ...input.handoffReply.metadata, policy: "escalation_holding_reply", customerMessageId: input.customerMessageId,
          escalationId: escalation.rows[0].id, reusedPrimaryDecision: true })]);
    }
    if (!existing.rows[0]) {
      await client.query(
        "insert into metric_events (client_id, event_type, value, metadata) values ($1, 'agent_escalated', $2, $3)",
        [
          input.clientId,
          input.confidence,
          { reasonCode: input.reasonCode, conversationId: input.conversationId },
        ],
      );
    }

    logInfo("agent.escalation_created", {
      requestId: input.requestId,
      clientId: input.clientId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      customerMessageId: input.customerMessageId,
      escalationId: escalation.rows[0].id,
      reasonCode: input.reasonCode,
      confidence: input.confidence,
    });

    return {
      action: "escalated",
      responseText: null,
      reasonCode: input.reasonCode,
      reasonDetail: input.reasonDetail,
      confidence: input.confidence,
      citedChunks: [],
      escalationId: escalation.rows[0].id,
    };
  }, { isolationLevel: "serializable", retries: 2 });
}

async function recordDirectAgentAnswer(
  input: {
    clientId: string;
    channelId: string;
    conversationId: string;
    customerMessageId: string;
    requestId?: string;
  },
  output: {
    answer: string;
    confidence: number;
    reasonCode: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ agentMessageId: string; csatUrl: string }> {
  const csatUrl = buildCsatUrl(input.conversationId);
  assertTurnActive();
  const agentMessage = await query<{ id: string }>(
    `
      insert into messages (conversation_id, client_id, channel_id, external_message_id, sender_role, body, metadata)
      values ($1, $2, $3, $4, 'agent', $5, $6)
      on conflict (channel_id, external_message_id) do update set external_message_id = excluded.external_message_id
      returning id
    `,
    [
      input.conversationId,
      input.clientId,
      input.channelId,
      `agent-${input.customerMessageId}`,
      output.answer,
      {
        confidence: output.confidence,
        reasonCode: output.reasonCode,
        citedChunkIds: [],
        csatUrl,
        customerMessageId: input.customerMessageId,
        ...output.metadata,
      },
    ],
  );

  await query(
    "update conversations set last_message_at = now() where id = $1 and client_id = $2 and status = 'active'",
    [input.conversationId, input.clientId],
  );
  await query(
    "insert into metric_events (client_id, event_type, value, metadata) values ($1, 'agent_answered', $2, $3)",
    [
      input.clientId,
      output.confidence,
      {
        reasonCode: output.reasonCode,
        conversationId: input.conversationId,
      },
    ],
  );

  logInfo("agent.direct_answer_recorded", {
    requestId: input.requestId,
    clientId: input.clientId,
    channelId: input.channelId,
    conversationId: input.conversationId,
    customerMessageId: input.customerMessageId,
    agentMessageId: agentMessage.rows[0].id,
    reasonCode: output.reasonCode,
  });

  return {
    agentMessageId: agentMessage.rows[0].id,
    csatUrl: `${csatUrl}?messageId=${agentMessage.rows[0].id}`,
  };
}

async function safeRecordUsage(
  input: Parameters<typeof recordAgentUsageEvent>[0],
): Promise<void> {
  try {
    await recordAgentUsageEvent(input);
  } catch (error) {
    logWarn("agent_usage_record_failed", {
      clientId: input.clientId,
      conversationId: input.conversationId,
      operation: input.operation,
      requestId:
        typeof input.metadata?.requestId === "string"
          ? input.metadata.requestId
          : undefined,
      error,
    });
  }
}

function buildCsatUrl(conversationId: string): string {
  return `${appBaseUrl().replace(/\/$/, "")}/csat/${conversationId}`;
}

function providerErrorMessage(error: unknown): string {
  return redactErrorMessage(error);
}
