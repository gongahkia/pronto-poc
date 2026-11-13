import { query, transaction } from "@/lib/db";
import { createEscalation, runAgentForMessage } from "@/lib/agent/engine";
import { decryptChannelCredentials, usesLegacyPlaintextCredentials } from "@/lib/channels/credentials";
import { getEscalationHoldingReply } from "@/lib/channels/escalation-handoff";
import { claimInboundJob, failInboundJob, finishInboundJob, type InboundJob } from "@/lib/channels/inbox";
import { enqueueOutboundMessage } from "@/lib/channels/outbox";
import { enqueueStaffNotification, isWithinStaffedHours } from "@/lib/staff-notifications";
import { enqueueKnowledgeReviewItem } from "@/lib/knowledge/review-items";
import { logWarn } from "@/lib/logger";
import type { Channel, Conversation, Escalation, Message } from "@/lib/types";
import type { ReservationConnector } from "@/lib/reservations/types";
import { assertCustomerDemoEnabled, isCustomerDemoChannel } from "@/lib/customer-demo-boundary";
import { requireRealDemoConfiguration, storedDemoProfile } from "@/lib/customer-demo-ai";
import { withAiExecutionProfile, type AiExecutionMode, type AiExecutionProfile } from "@/lib/llm/execution-mode";
import type { DemoAiProfile } from "@/lib/llm/demo-models";
import { LlmConfigurationError } from "@/lib/llm/errors";
import { protectedDemoDeployment } from "@/lib/deployment-profile";
import { recordConversationOutcome } from "@/lib/conversation-actions";
import { generateHandoffIntake } from "@/lib/agent/handoff-intake";
import {handoffFollowupNotice} from '@/lib/agent/handoff-wording';
import { shouldUseMockAi } from "@/lib/env";
import { withAgentTurn, assertTurnActive } from "@/lib/agent/turn-budget";

export async function processInboundJob(input: { jobId?: string; requestId?: string; clientId?: string; channelId?: string;
  reservationConnector?: ReservationConnector } = {}): Promise<
  { jobId: string; outcome: "answered" | "escalated" | "skipped" } | null
> {
  const job = await claimInboundJob({ jobId: input.jobId, clientId: input.clientId, channelId: input.channelId });
  if (!job) return null;
  try {
    const outcome = await withAgentTurn(() => execute(job, input.requestId, input.reservationConnector), { clientId: job.client_id });
    await recordConversationOutcome(job.client_id, job.conversation_id, outcome);
    await finishInboundJob(job, outcome === "skipped" ? "skipped" : "completed");
    return { jobId: job.id, outcome };
  } catch (error) {
    await failInboundJob(job, error);
    logWarn("inbox.job_failed", { jobId: job.id, clientId: job.client_id,
      attemptCount: job.attempt_count, error });
    throw error;
  }
}

async function execute(job: InboundJob, requestId?: string,
  reservationConnector?: ReservationConnector): Promise<"answered" | "escalated" | "skipped"> {
  const [channelResult, messageResult, conversationResult] = await Promise.all([
    query<Channel>("select * from channels where id = $1 and client_id = $2", [job.channel_id, job.client_id]),
    query<Message>("select * from messages where id = $1 and client_id = $2", [job.message_id, job.client_id]),
    query<Conversation>("select * from conversations where id = $1 and client_id = $2", [job.conversation_id, job.client_id]),
  ]);
  const channelRow = channelResult.rows[0];
  const message = messageResult.rows[0];
  const conversation = conversationResult.rows[0];
  if (!channelRow || !message || !conversation || message.conversation_id !== conversation.id ||
      channelRow.id !== message.channel_id || conversation.channel_id !== channelRow.id) {
    throw new Error("Inbound job has inconsistent tenant or conversation references.");
  }
  if (channelRow.status !== "active") return "skipped";
  if (channelRow.kind === "instagram" && channelRow.settings.authMode === "instagram_login" &&
      process.env.PRONTO_INSTAGRAM_LOGIN_ENABLED !== "1") return "skipped";
  if (["whatsapp", "instagram", "messenger", "email"].includes(channelRow.kind) &&
      usesLegacyPlaintextCredentials(channelRow)) {
    throw new Error("Meta channel credentials must be encrypted before processing.");
  }
  const channel = decryptChannelCredentials(channelRow);
  if (protectedDemoDeployment() && !isCustomerDemoChannel(channel)) return "skipped";
  if (channel.kind === "email" && channel.credentials.provider === "local_smtp" &&
      (process.env.NODE_ENV === "production" || process.env.PRONTO_LOCAL_EMAIL_ENABLED !== "1")) return "skipped";

  // Recover a model decision already persisted before a worker crash.
  const answer = await query<Message>(
    `select * from messages where client_id = $1 and conversation_id = $2 and sender_role = 'agent'
       and metadata->>'customerMessageId' = $3 and metadata->>'policy' is distinct from 'escalation_holding_reply'
     order by created_at limit 1`,
    [job.client_id, conversation.id, message.id],
  );
  if (answer.rows[0]) {
    await queueAnswer(job, conversation, answer.rows[0]);
    return "answered";
  }
  const priorEscalation = await query<Escalation>(
    "select * from escalations where client_id = $1 and message_id = $2 limit 1",
    [job.client_id, message.id],
  );
  if (priorEscalation.rows[0]) {
    await queueHandoff(job, channel, conversation, priorEscalation.rows[0]);
    return "escalated";
  }

  // A later release applies to future enquiries, not a human-owned backlog.
  if (message.metadata.aiPausedAtIngestion === true) return "skipped";
  const active = await query<{ id: string }>(
    `select c.id from conversations c where c.id = $1 and c.client_id = $2 and c.status = 'active'
      and not exists (select 1 from escalations e where e.conversation_id = c.id and e.client_id = c.client_id
        and (e.status='claimed' or (e.status='open' and not e.allow_ai_followups)))`,
    [conversation.id, job.client_id],
  );
  if (!active.rows[0]) return "skipped";

  const unsupported = typeof message.metadata.unsupportedMediaType === "string"
    ? message.metadata.unsupportedMediaType : null;
  let demoMode: AiExecutionMode | undefined;
  let demoProfile: AiExecutionProfile | undefined;
  if (channel.kind === "console") {
    await assertCustomerDemoEnabled();
    if (!isCustomerDemoChannel(channel)) throw new Error("Unknown customer simulator channel.");
    const session = await query<{ ai_mode: AiExecutionMode; ai_selection: string; ai_configuration: DemoAiProfile | null }>(`select ai_mode,ai_selection,ai_configuration from customer_demo_sessions
      where conversation_id=$1 and client_id=$2`, [conversation.id, job.client_id]);
    if (!session.rows[0]) throw new Error("Customer simulator session is missing.");
    if (process.env.NODE_ENV !== "test" && session.rows[0].ai_mode !== "real")
      throw new Error("Simulated customer replies are disabled. Start a conversation with a real model.");
    demoMode = session.rows[0].ai_mode;
    const configuration = demoMode === "real" ? await requireRealDemoConfiguration(true, storedDemoProfile(session.rows[0]))
      .catch(() => { throw new LlmConfigurationError("demo", "Check the selected provider and published knowledge configuration."); }) : undefined;
    demoProfile = { mode: demoMode, syntheticDemo: true, ...(configuration ? { provider: configuration.provider,
      model: configuration.model, embeddingProvider: configuration.embeddingProvider, embeddingModel: configuration.embeddingModel,
      ...(configuration.retrievalMode ? { retrievalMode: configuration.retrievalMode } : {}) } : {}) };
  }
  const run = async () => unsupported
    ? await createEscalation({
        clientId: job.client_id, channelId: job.channel_id, conversationId: job.conversation_id,
        customerMessageId: message.id, customerMessage: message.body,
        reasonCode: "unsupported_media", reasonDetail: `Customer sent unsupported ${channel.kind} content.`,
        confidence: 1, requestId,
      })
    : await runAgentForMessage({
        clientId: job.client_id, channelId: job.channel_id, channelKind: channel.kind,
        conversationId: job.conversation_id, customerMessageId: message.id,
        customerMessage: message.body, requestId, reservationConnector,
      });

  const result = await (demoProfile ? withAiExecutionProfile(demoProfile, run) : run());
  if (result.action === "answered") {
    const recorded = await query<Message>(
      `select * from messages where client_id = $1 and conversation_id = $2 and sender_role = 'agent'
         and metadata->>'customerMessageId' = $3 order by created_at limit 1`,
      [job.client_id, conversation.id, message.id],
    );
    if (!recorded.rows[0]) throw new Error("Agent answer was not persisted.");
    await queueAnswer(job, conversation, recorded.rows[0]);
    return "answered";
  }
  if (!result.escalationId) throw new Error("Agent escalation was not persisted.");
  const escalation = await query<Escalation>(
    "select * from escalations where id = $1 and client_id = $2", [result.escalationId, job.client_id],
  );
  if (!escalation.rows[0]) throw new Error("Agent escalation record is missing.");
  await queueHandoff(job, channel, conversation, escalation.rows[0]);
  return "escalated";
}

async function queueAnswer(job: InboundJob, conversation: Conversation, answer: Message): Promise<void> {
  assertTurnActive();
  if (process.env.NODE_ENV !== "test" && !shouldUseMockAi() &&
      (answer.metadata.generationMode !== "real" || answer.metadata.responseProvider === "mock"))
    throw new Error("Only genuine model responses can be delivered.");
  await transaction(async (db) => {
    const owner = await db.query<Conversation>(
      "select * from conversations where id = $1 and client_id = $2 for update",
      [conversation.id, job.client_id],
    );
    if (owner.rows[0]?.status !== "active") return;
    const open = await db.query<{ id: string }>(
      "select id from escalations where client_id = $1 and conversation_id = $2 and (status='claimed' or (status='open' and not allow_ai_followups)) limit 1",
      [job.client_id, conversation.id],
    );
    if (open.rows[0]) return;
    assertTurnActive();
    const csatUrl = typeof answer.metadata.csatUrl === "string"
      ? `${answer.metadata.csatUrl}?messageId=${answer.id}` : null;
    await enqueueOutboundMessage(db, {
      clientId: job.client_id, channelId: job.channel_id, conversationId: conversation.id,
      externalThreadId: conversation.external_thread_id,
      body: csatUrl && process.env.PRONTO_DISABLE_CSAT_HOOK !== "1"
        ? `${answer.body}\n\nRate this reply: ${csatUrl}` : answer.body,
      idempotencyKey: `agent-answer:${job.message_id}`,
      metadata: { purpose: "agent_answer", customerMessageId: job.message_id,
        agentMessageId: answer.id, reasonCode: answer.metadata.reasonCode },
    });
  }, { isolationLevel: "serializable", retries: 2 });
}

async function queueHandoff(
  job: InboundJob, channel: Channel, conversation: Conversation, escalation: Escalation,
): Promise<void> {
  assertTurnActive();
  const policy = await query<{ policy: { timezone: string; staffedHours: Record<string, { start: string; end: string }>;
    outOfHoursAcknowledgement: string | null } }>(
    "select policy from escalation_policy_versions where client_id = $1 order by version desc limit 1", [job.client_id]);
  const configured = policy.rows[0]?.policy;
  const requireRealReply = !shouldUseMockAi() || (isCustomerDemoChannel(channel) && process.env.NODE_ENV !== "test");
  const outOfHours = configured?.outOfHoursAcknowledgement &&
    !isWithinStaffedHours(new Date(), configured.timezone, configured.staffedHours)
    ? configured.outOfHoursAcknowledgement : null;
  const existing = await query<Message>(`select * from messages where client_id=$1 and conversation_id=$2
    and channel_id=$3 and external_message_id=$4 limit 1`,
    [job.client_id, conversation.id, channel.id, `agent-handoff-${escalation.id}`]);
  if (requireRealReply && existing.rows[0] && (existing.rows[0].metadata.generationMode !== "real" ||
      existing.rows[0].metadata.responseProvider === "mock")) throw new Error("A legacy simulated response cannot be delivered.");
  const intake = existing.rows[0] || (!requireRealReply && outOfHours) ? null
    : await generateHandoffIntake({ channel, conversation, escalation, customerMessageId: job.message_id });
  const body = existing.rows[0]?.body ?? intake?.body ?? (requireRealReply ? null : outOfHours ?? getEscalationHoldingReply(channel.settings));
  await transaction(async (db) => {
    assertTurnActive();
    if (body) {
      // Serialize with takeover/claim and read the current review policy, not
      // the conversation snapshot taken before inference. This exact body is
      // saved and queued for every channel, including the customer simulator.
      const ownership=await db.query<{status:string;review_status:string;allow_ai_followups:boolean;blocked:boolean}>(
        `select c.status,e.status as review_status,e.allow_ai_followups,
          exists(select 1 from escalations blocked where blocked.client_id=c.client_id and blocked.conversation_id=c.id
            and (blocked.status='claimed' or (blocked.status='open' and not blocked.allow_ai_followups))) as blocked
         from conversations c join escalations e on e.client_id=c.client_id and e.conversation_id=c.id and e.id=$3
         where c.id=$1 and c.client_id=$2 for update of c`,[conversation.id,job.client_id,escalation.id]);
      const owner=ownership.rows[0];
      const previous=await db.query<{body:string}>(`select body from outbound_messages where client_id=$1 and idempotency_key=$2`,
        [job.client_id,`escalation-holding:${escalation.id}`]);
      const notice=!previous.rows[0]&&owner?.status==='active'&&owner.review_status==='open'&&owner.allow_ai_followups&&!owner.blocked
        ? handoffFollowupNotice(body):null;
      // A retry must not rewrite a reply that has already been queued/sent.
      const deliveredBody=previous.rows[0]?.body??(notice&&!body.trimEnd().endsWith(notice)?`${body}\n\n${notice}`:body);
      const recorded = await db.query<Message>(
        `insert into messages (conversation_id, client_id, channel_id, external_message_id, sender_role, body, metadata)
         values ($1, $2, $3, $4, 'agent', $5, $6)
         on conflict (channel_id, external_message_id) do update set body=excluded.body,metadata=messages.metadata||excluded.metadata
         returning *`,
        [conversation.id, job.client_id, channel.id, `agent-handoff-${escalation.id}`, deliveredBody,
          { ...intake?.metadata, escalationId: escalation.id, customerMessageId: job.message_id, policy: "escalation_holding_reply",
            ...(notice?{handoffFollowupNotice:notice,handoffFollowupNoticeSource:'delivery_policy'}:{}) }],
      );
      await enqueueOutboundMessage(db, {
        clientId: job.client_id, channelId: channel.id, conversationId: conversation.id,
        escalationId: escalation.id, externalThreadId: conversation.external_thread_id, body: recorded.rows[0].body,
        idempotencyKey: `escalation-holding:${escalation.id}`,
        metadata: { purpose: "escalation_holding_reply", customerMessageId: job.message_id, agentMessageId: recorded.rows[0].id },
      });
    }
    await enqueueStaffNotification(db, job.client_id, escalation.id);
    await enqueueKnowledgeReviewItem(db, { clientId: job.client_id, conversationId: conversation.id,
      messageId: job.message_id, escalationId: escalation.id, reasonCode: escalation.reason_code });
  }, { isolationLevel: "serializable", retries: 2 });
}
