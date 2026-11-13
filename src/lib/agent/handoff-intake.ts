import { query } from "@/lib/db";
import { businessClock } from "@/lib/agent/business-clock";
import { plainMessageText } from "@/lib/message-text";
import { shouldUseMockAi } from "@/lib/env";
import { getPromptBrandVoiceProfile } from "@/lib/brand-voice";
import { retrieveKnowledge, retrieveKnowledgeText } from "@/lib/knowledge/retrieve";
import { normalizeKnowledgeQuery, conversationKnowledgeQuery } from "@/lib/knowledge/query";
import { loadConversationContext } from "@/lib/agent/conversation-context";
import { estimateTokens } from "@/lib/knowledge/chunk";
import { getEmbeddingProvider, getGenerationProvider } from "@/lib/llm";
import { selectModel } from "@/lib/llm/catalog";
import { aiExecutionProfile, withAiExecutionProfile } from "@/lib/llm/execution-mode";
import { assertCustomerDemoEnabled, isCustomerDemoChannel } from "@/lib/customer-demo-boundary";
import { requireRealDemoConfiguration, storedDemoProfile } from "@/lib/customer-demo-ai";
import type { DemoAiProfile } from "@/lib/llm/demo-models";
import { evaluatePreGenerationGuardrails } from "@/lib/agent/guardrails";
import { evaluatePostGenerationSelfCheck } from "@/lib/agent/self-check";
import {hasCommittedHandoff} from '@/lib/agent/handoff-wording';
import { agentMaxConversationTokens, agentMaxOutputTokens, agentMaxPromptTokens, agentTimeoutMs } from "@/lib/agent/runtime-limits";
import { buildGroundedAnswerInstructions, buildGroundedAnswerUserInput } from "@/lib/llm/prompt";
import { estimateEmbeddingCost, estimateGenerationCost, estimateGenerationCostFromTokens, recordAgentUsageEvent } from "@/lib/costing";
import { logWarn, redactErrorMessage } from "@/lib/logger";
import type { AgentConfig, Channel, ChannelKind, Client, Conversation, Escalation, KnowledgeChunk, Message } from "@/lib/types";
import type { GroundedAnswerDecision } from "@/lib/llm/types";

const intakeReasons = ["complaint_or_refund", "transactional_action", "private_lookup_unverified"];

export type HandoffIntakeReply = { body: string; metadata: Message["metadata"] };

export function handoffQuestionsAllowed(message: string, rules: Record<string, unknown>, channelKind?: ChannelKind): boolean {
  return !evaluatePreGenerationGuardrails(message, { ...rules, disabledReasonCodes: intakeReasons }, channelKind).shouldEscalate;
}

export function handoffReplyFromDecision(input: {
  decision: GroundedAnswerDecision; chunks: KnowledgeChunk[]; customerMessage: string;
  askForDetails: boolean; provider: string; model: string; generationMode?: "real" | "mock"; retrievalMode: string;
}): HandoffIntakeReply | null {
  const decision = { ...input.decision, answer: input.decision.answer ? plainMessageText(input.decision.answer) : null };
  const check = evaluatePostGenerationSelfCheck({ decision: { ...decision, action: "answer" }, retrievedChunks: input.chunks,
    clarificationContext: `${input.customerMessage}\nOur team will help, assist with and review this enquiry.`, requireQuestion: false });
  if (decision.action !== "escalate" || !decision.answer?.trim() || !hasCommittedHandoff(decision.answer) || !check.passed || (!input.askForDetails && /[?？]/.test(decision.answer))) return null;
  // Acknowledgement reuse cannot promise a mutation or approval on staff's behalf.
  if (/\b(?:i|we)(?:['’]ll|\s+(?:will|shall|can))\s+(?:now\s+)?(?:refund|book|reserve|cancel|modify|approve|issue\s+(?:you\s+)?(?:a\s+)?refund|process\s+(?:(?:your|the|a)\s+)?(?:refund|payment|booking|reservation|order))\b/i.test(decision.answer) ||
      /\b(?:refund|payment|booking|reservation|order)\s+(?:will|shall)\s+be\s+(?:approved|processed|confirmed|cancelled|canceled|changed|modified)\b/i.test(decision.answer)) return null;
  const cited = input.chunks.filter(chunk => decision.citedChunkIds.includes(chunk.id));
  return { body: decision.answer.trim(), metadata: { generationMode: input.generationMode ?? "real", responseProvider: input.provider,
    responseModel: decision.actualModel ?? input.model, providerResponseId: decision.providerResponseId ?? null,
    citedChunkIds: decision.citedChunkIds, retrievalMode: input.retrievalMode, handoffIntake: true,
    intakeContextChunkIds: input.chunks.map(chunk => chunk.id),
    sourceProvenance: cited.map(chunk => ({ chunkId: chunk.id, sourceId: chunk.source_id,
      version: chunk.metadata.sourceVersion ?? null, contentHash: chunk.metadata.sourceContentHash ?? null })) } };
}

// Generate one committed acknowledgement and optional useful detail question.
// The persisted escalation policy determines whether other questions can continue.
export async function generateHandoffIntake(input: {
  channel: Channel; conversation: Conversation; escalation: Escalation; customerMessageId: string;
}): Promise<HandoffIntakeReply | null> {
  if (input.escalation.status !== "open" || input.escalation.reason_code === "provider_error") return null;
  try {
    if (isCustomerDemoChannel(input.channel)) {
      await assertCustomerDemoEnabled();
      const session = await query<{ ai_mode: "real" | "mock"; ai_selection: string; ai_configuration: DemoAiProfile | null }>(
        "select ai_mode,ai_selection,ai_configuration from customer_demo_sessions where client_id=$1 and conversation_id=$2",
        [input.channel.client_id, input.conversation.id]);
      if (session.rows[0]?.ai_mode !== "real") return null;
      const configuration = await requireRealDemoConfiguration(true, storedDemoProfile(session.rows[0]));
      return await withAiExecutionProfile({ mode: "real", syntheticDemo: true, provider: configuration.provider,
        model: configuration.model, embeddingProvider: configuration.embeddingProvider, embeddingModel: configuration.embeddingModel,
        ...(configuration.retrievalMode ? { retrievalMode: configuration.retrievalMode } : {}) }, () => generate(input));
    }
    if (shouldUseMockAi()) return null;
    return await generate(input);
  } catch (error) {
    // Intake failure must never block staff handoff or cause a provider fallback.
    logWarn("agent.handoff_intake_unavailable", { clientId: input.channel.client_id,
      conversationId: input.conversation.id, escalationId: input.escalation.id, error: redactErrorMessage(error) });
    return null;
  }
}

async function generate(input: Parameters<typeof generateHandoffIntake>[0]): Promise<HandoffIntakeReply | null> {
  const clientId = input.channel.client_id;
  const conversationId = input.conversation.id;
  const [clients, configs, recent, voice] = await Promise.all([
    query<Client>("select * from clients where id=$1", [clientId]),
    query<AgentConfig>("select * from agent_configs where client_id=$1", [clientId]),
    loadConversationContext({ clientId, conversationId, customerMessageId: input.customerMessageId, includeCurrent: true }),
    getPromptBrandVoiceProfile(clientId),
  ]);
  const client = clients.rows[0];
  const config = configs.rows[0];
  const customer = recent.find(message => message.id === input.customerMessageId && message.sender_role === "customer");
  if (!client || !config || !customer) return null;
  const validationHandoff = input.escalation.reason_code.startsWith('post_check_') || input.escalation.reason_code === 'staff_followup_required';
  const askForDetails = !validationHandoff && handoffQuestionsAllowed(customer.body, config.escalation_rules, input.channel.kind);

  const profile = aiExecutionProfile();
  const provider = profile?.provider ?? process.env.PRONTO_LLM_PROVIDER ?? config.response_provider;
  const selected = selectModel({ provider, configuredModel: profile?.model ?? config.response_model,
    ignoreEnvironment: Boolean(profile?.model), task: "agent_answer" });
  const localText = profile?.retrievalMode === "local_text";
  const normalized = conversationKnowledgeQuery(customer.body, [...recent].reverse().filter(message => message.id !== customer.id)
    .map(message => ({ senderRole: message.sender_role, body: message.body })));
  const embeddingProvider = profile?.embeddingProvider ?? process.env.PRONTO_EMBEDDING_PROVIDER ?? config.embedding_provider;
  const embeddingModel = profile?.embeddingModel ?? process.env.PRONTO_EMBEDDING_MODEL ?? config.embedding_model;
  let chunks = localText ? await retrieveKnowledgeText(clientId, normalized.searchQuery, 5, { conversationId })
    : await (async () => {
      const [vector] = await getEmbeddingProvider(embeddingProvider).embed([normalized.embeddingText], embeddingModel,
        { clientId, conversationId, operation: "embedding", embeddingTask: "query" });
      await recordUsage({ clientId, conversationId, channelId: input.channel.id, provider: embeddingProvider,
        model: embeddingModel, operation: "embedding", estimate: estimateEmbeddingCost(normalized.embeddingText) });
      return retrieveKnowledge(clientId, vector, 5, { conversationId, queryText: normalized.searchQuery,
        embeddingProvider, embeddingModel });
    })();
  if (!chunks.length && localText) chunks = (await retrieveKnowledgeText(clientId, normalizeKnowledgeQuery(client.name).searchQuery, 5, { conversationId }))
    .map(chunk => ({ ...chunk, metadata: { ...chunk.metadata, retrievalPurpose: "identity_fallback" } }));
  if (!chunks.length || (chunks[0].score ?? 0) < Number(config.retrieval_threshold)) return null;
  if (estimateTokens([customer.body, ...recent.map(message => message.body), ...chunks.map(chunk => chunk.content)].join("\n"))
      > agentMaxConversationTokens()) return null;

  const generationInput = {
    clientId, conversationId, clientName: client.name, brandVoice: client.brand_voice,
    currentDateTime: businessClock(client.business_profile ?? {}),
    brandVoiceDocument: voice.document?.content ?? null, promptPreamble: validationHandoff
      ? `${config.prompt_preamble}\nThe answer was rejected by validation. Give only a brief acknowledgement that our team will review this enquiry. Do not repeat dates, times or other business details, ask a question, or imply any booking or transaction has been completed.`
      : input.escalation.reason_code === 'out_of_scope'
        ? `${config.prompt_preamble}\nBriefly explain that you help with this business's customer-service enquiries. Do not offer to complete the unrelated request. Acknowledge that our team will review the enquiry.`
        : input.escalation.reason_code === 'private_lookup_unverified'
          ? `${config.prompt_preamble}\nThis is an unverified existing-record enquiry. Any optional question is for staff to verify the existing booking or order, not to start a new booking search. Do not confirm a customer-supplied booking ID or ask for another customer's private details.`
          : config.prompt_preamble,
    customerMessage: customer.body, recentMessages: [...recent].reverse().filter(message => message.id !== customer.id).map(message => ({ senderRole: message.sender_role, body: message.body })),
    retrievedChunks: chunks, responseModel: selected.model, maxOutputTokens: agentMaxOutputTokens(),
    maxPromptTokens: agentMaxPromptTokens(), timeoutMs: agentTimeoutMs(), handoffReason: input.escalation.reason_code,
    handoffAskForDetails: askForDetails,
    escalationRules: config.escalation_rules, channelKind: input.channel.kind,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const draftInput = attempt === 0 ? generationInput : { ...generationInput, handoffAskForDetails: false,
      promptPreamble: `${generationInput.promptPreamble}\nThe previous handoff draft failed validation. Write only a brief acknowledgement that our team will review this enquiry. Do not ask a question, introduce business facts, promise a transaction or repeat an unsupported claim.` };
    // Repair a rejected draft once, within the existing per-turn call/token
    // budget. Provider/network errors still leave immediately without retrying.
    const generated = await getGenerationProvider(selected.provider).generateGroundedAnswer(draftInput);
    const decision = { ...generated, answer: generated.answer ? plainMessageText(generated.answer) : null };
    const effectiveChunks = decision.contextChunkIds ? chunks.filter(chunk => decision.contextChunkIds!.includes(chunk.id)) : chunks;
    const prompt = `${buildGroundedAnswerInstructions(draftInput)}\n${buildGroundedAnswerUserInput(draftInput)}`;
    await recordUsage({ clientId, conversationId, channelId: input.channel.id, provider: selected.provider, model: selected.model,
      operation: "generation", estimate: decision.usage ? estimateGenerationCostFromTokens({ ...decision.usage, costLabel: selected.costLabel })
        : estimateGenerationCost({ inputText: prompt, outputText: JSON.stringify(decision), costLabel: selected.costLabel }),
      metadata: { purpose: "handoff_intake", repairAttempt: attempt, customerMessageId: customer.id, providerResponseId: decision.providerResponseId ?? null,
        usageSource: decision.usage ? "provider" : "estimate" } });
    const reply = handoffReplyFromDecision({ decision, chunks: effectiveChunks, customerMessage: customer.body,
      askForDetails: draftInput.handoffAskForDetails, provider: selected.provider, model: selected.model, retrievalMode: localText ? "local_text" : "hybrid_vector" });
    if (reply) return reply;
  }
  return null;
}

async function recordUsage(input: Parameters<typeof recordAgentUsageEvent>[0]) {
  try { await recordAgentUsageEvent(input); }
  catch { logWarn("agent.handoff_usage_not_recorded", { clientId: input.clientId, conversationId: input.conversationId }); }
}
