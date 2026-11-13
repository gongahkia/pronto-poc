import { randomUUID } from "node:crypto";
import type { SessionUser } from "@/lib/auth";
import { query, transaction, type Queryable } from "@/lib/db";
import { recordAuditLog } from "@/lib/audit";
import { ingestInboundMessage } from "@/lib/channels/inbox";
import { assertCustomerDemoEnabled, DEMO_CHANNEL_ID, DEMO_CLIENT_ID, DEMO_SLUG, DemoError } from "@/lib/customer-demo-boundary";
import { requireRealDemoConfiguration, profileForDemoChoice, storedDemoProfile, demoModelAvailability } from "@/lib/customer-demo-ai";
import { DEFAULT_DEMO_MODEL, demoModelChoice, type DemoAiProfile } from "@/lib/llm/demo-models";
import { guestAccessEnabled, isGuestEmail } from "@/lib/guest-policy";
import { protectedDemoConfiguration, protectedDemoDeployment, requestDrivenDemoProcessing } from "@/lib/deployment-profile";
import type { AiExecutionMode } from "@/lib/llm/execution-mode";

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function assertDemoActor(actor: SessionUser, db: Queryable = { query }) {
  await assertCustomerDemoEnabled(db);
  // Guest reviewers are created by the explicitly enabled guest flow, so they are not on the named-user list.
  const guest = guestAccessEnabled() && isGuestEmail(actor.email);
  if (protectedDemoDeployment() && !guest && !protectedDemoConfiguration().allowedUserIds.includes(actor.userId))
    throw new DemoError("This account is not invited to the protected demo.", 403);
  if (actor.role !== "operator" && actor.clientId !== DEMO_CLIENT_ID) throw new DemoError("Forbidden.", 403);
  const identity = await db.query<{ id: string }>(`select c.id from clients c join users u on u.id=$2
    where c.id=$1 and c.slug=$3 and c.business_profile->>'demoSeed'='ps-cafe-raffles-city-v1'
      and (u.role='operator' or (u.role='client' and u.client_id=c.id))`, [DEMO_CLIENT_ID, actor.userId, DEMO_SLUG]);
  if (!identity.rows[0]) throw new DemoError("Demo identity not authorized.", 403);
}

export async function createDemoSession(actor: SessionUser, mode: AiExecutionMode, selection?: unknown) {
  await assertDemoActor(actor);
  if (process.env.NODE_ENV !== "test" && (mode !== "real" || selection === "mock" || selection === "configured"))
    throw new DemoError("Choose an available real AI model. Simulated replies are disabled.");
  const choice = selection ?? (mode === "mock" ? "mock" : DEFAULT_DEMO_MODEL);
  if (!demoModelChoice(choice) || (mode === "mock") !== (choice === "mock")) throw new DemoError("Choose a supported demo model and matching mode.");
  const configuration = mode === "real" ? await requireRealDemoConfiguration(true, profileForDemoChoice(choice)) : undefined;
  const snapshot = configuration ? { provider: configuration.provider, model: configuration.model,
    embeddingProvider: configuration.embeddingProvider, embeddingModel: configuration.embeddingModel,
    ...(configuration.retrievalMode ? { retrievalMode: configuration.retrievalMode } : {}) } : null;
  return transaction(async db => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`customer-demo:${actor.userId}`]);
    const count = await db.query<{ count: string }>(`select count(*) from customer_demo_sessions
      where client_id=$1 and user_id=$2 and created_at>now()-interval '1 hour'`, [DEMO_CLIENT_ID, actor.userId]);
    if (Number(count.rows[0]?.count ?? 0) >= 20) throw new DemoError("Demo conversation limit reached. Please try later.", 429);
    const channel = await db.query<{ id: string }>(`select id from channels where id=$1 and client_id=$2
      and kind='console' and status='active' and settings->>'transport'='customer_simulator' for share`,
      [DEMO_CHANNEL_ID, DEMO_CLIENT_ID]);
    if (!channel.rows[0]) throw new DemoError("Run the guarded demo:customer:setup command first.", 503);
    const id = randomUUID();
    const conversation = await db.query<{ id: string }>(`insert into conversations
      (client_id,channel_id,external_thread_id,customer_name,customer_handle)
      values ($1,$2,$3,'Customer',$4) returning id`, [DEMO_CLIENT_ID, DEMO_CHANNEL_ID, id, `demo:${actor.userId}`]);
    await db.query(`insert into customer_demo_sessions (id,client_id,user_id,conversation_id,ai_mode,ai_selection,ai_configuration)
      values ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [id, DEMO_CLIENT_ID, actor.userId, conversation.rows[0].id, mode, choice, snapshot ? JSON.stringify(snapshot) : null]);
    await recordAuditLog({ clientId: DEMO_CLIENT_ID, actorUserId: actor.userId,
      action: "demo.session_created", targetType: "conversation", targetId: conversation.rows[0].id,
      metadata: { mode, selection: choice, configuration: snapshot } }, db);
    return { id, conversationId: conversation.rows[0].id, mode };
  }, { isolationLevel: "serializable", retries: 2 });
}

async function ownedSession(actor: SessionUser, id: string, db: Queryable = { query }) {
  if (!uuidPattern.test(id)) throw new DemoError("Conversation not found.", 404);
  const result = await db.query<{ id: string; conversation_id: string; ai_mode: AiExecutionMode; status: string;
    ai_selection: string; ai_configuration: DemoAiProfile | null; staff_review_pending:boolean }>(
    `select s.id,s.conversation_id,s.ai_mode,s.ai_selection,s.ai_configuration,c.status,
     exists(select 1 from escalations e where e.client_id=c.client_id and e.conversation_id=c.id and e.status in ('open','claimed')) as staff_review_pending from customer_demo_sessions s
     join conversations c on c.id=s.conversation_id and c.client_id=s.client_id
     where s.id=$1 and s.client_id=$2 and s.user_id=$3 and c.channel_id=$4 and c.deleted_at is null`,
    [id, DEMO_CLIENT_ID, actor.userId, DEMO_CHANNEL_ID]);
  if (!result.rows[0]) throw new DemoError("Conversation not found.", 404);
  if (process.env.NODE_ENV !== "test" && result.rows[0].ai_mode !== "real")
    throw new DemoError("This older test conversation is unavailable. Start a new conversation with a real model.", 409);
  return result.rows[0];
}

export async function sendDemoMessage(actor: SessionUser, input: { sessionId: string; requestId: string; text: string }) {
  await assertDemoActor(actor);
  if (!uuidPattern.test(input.requestId) || !input.text.trim() || input.text.length > 4000)
    throw new DemoError("Enter a message of 1–4000 characters with a valid request ID.");
  const session = await ownedSession(actor, input.sessionId);
  if (session.status === "closed") throw new DemoError("The team resolved this conversation. Start a new conversation or await authorized release.", 409);
  if (session.ai_mode === "real" && session.status === "active") await requireRealDemoConfiguration(true, storedDemoProfile(session));
  return transaction(async db => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`customer-demo:${actor.userId}`]);
    const current = await ownedSession(actor, input.sessionId, db);
    if (current.status === "closed") throw new DemoError("The team resolved this conversation. Start a new conversation or await authorized release.", 409);
    const externalId = `sim:${session.id}:${input.requestId}`;
    const existing = await db.query<{ id: string; body: string }>(`select id,body from messages where client_id=$1
      and channel_id=$2 and external_message_id=$3`, [DEMO_CLIENT_ID, DEMO_CHANNEL_ID, externalId]);
    if (existing.rows[0] && existing.rows[0].body !== input.text.trim()) throw new DemoError("A retry cannot change the original message.", 409);
    if (!existing.rows[0]) {
      const count = await db.query<{ count: string }>(`select count(*) from messages m
        join customer_demo_sessions s on s.conversation_id=m.conversation_id and s.client_id=m.client_id
        where m.client_id=$1 and s.user_id=$2 and m.sender_role='customer' and m.created_at>now()-interval '1 minute'`,
        [DEMO_CLIENT_ID, actor.userId]);
      if (Number(count.rows[0]?.count ?? 0) >= 10) throw new DemoError("Please wait before sending more demo messages.", 429);
      const pending = await db.query<{ id: string; status:string }>(`select id,status from inbound_jobs where client_id=$1
        and conversation_id=$2 and status in ('pending','processing','failed','dead')`, [DEMO_CLIENT_ID, session.conversation_id]);
      if (pending.rows.some(row => row.status !== 'pending') || pending.rows.length >= 5)
        throw new DemoError("Please wait for the current messages to finish processing.", 409);
    }
    const ingested = await ingestInboundMessage({ channelId: DEMO_CHANNEL_ID, channelKind: "console",
      externalMessageId: externalId, externalThreadId: session.id, customerHandle: `demo:${actor.userId}`,
      customerName: "Customer", occurredAt: new Date().toISOString(), text: input.text.trim(),
      raw: { synthetic: true } }, db);
    // Retries must not extend the quiet window or revive failed/dead work.
    const requestedQuiet = Number(process.env.PRONTO_DEMO_REPLY_QUIET_MS ?? 3000);
    const quietMs = Number.isFinite(requestedQuiet) ? Math.min(10000, Math.max(0, requestedQuiet)) : 3000;
    if (!ingested.duplicate) await db.query(`update inbound_jobs set available_at=now()+make_interval(secs => $3::double precision/1000)
      where client_id=$1 and conversation_id=$2 and status='pending'`, [DEMO_CLIENT_ID, session.conversation_id, quietMs]);
    return ingested;
  }, { isolationLevel: "serializable", retries: 2 });
}

export async function retryDemoProcessing(actor: SessionUser, sessionId: string) {
  await assertDemoActor(actor);
  const session = await ownedSession(actor, sessionId);
  if (session.ai_mode === "real") await requireRealDemoConfiguration(true, storedDemoProfile(session));
  await transaction(async db => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`customer-demo:${actor.userId}`]);
    const count = await db.query<{ count: string }>(`select count(*) from audit_logs where client_id=$1
      and actor_user_id=$2 and action='demo.processing_retried' and created_at>now()-interval '1 hour'`, [DEMO_CLIENT_ID, actor.userId]);
    if (Number(count.rows[0]?.count ?? 0) >= 5) throw new DemoError("Demo retry limit reached. Ask the team to review the failure.", 429);
    const retried = await db.query(`update inbound_jobs set status='pending', attempt_count=0, available_at=now(),
      lease_expires_at=null, last_error=null, failure_code=null, failure_provider=null, updated_at=now() where client_id=$1 and conversation_id=$2 and status='dead'
      and id=(select id from inbound_jobs where client_id=$1 and conversation_id=$2 order by sequence desc limit 1)
      returning id`, [DEMO_CLIENT_ID, session.conversation_id]);
    let retriedDelivery=0;
    if(requestDrivenDemoProcessing()){
      const delivery=await db.query(`update outbound_messages set status='pending',attempt_count=0,last_error=null,updated_at=now()
        where client_id=$1 and conversation_id=$2 and channel_id=$3 and status='dead'
        and metadata->>'customerMessageId'=(select message_id::text from inbound_jobs where client_id=$1 and conversation_id=$2 order by sequence desc limit 1)
        returning id`,[DEMO_CLIENT_ID,session.conversation_id,DEMO_CHANNEL_ID]);
      retriedDelivery=delivery.rowCount??0;
    }
    if (!retried.rowCount&&!retriedDelivery) throw new DemoError("Only a stopped job can be retried. Processing jobs keep their existing lease.", 409);
    await recordAuditLog({ clientId: DEMO_CLIENT_ID, actorUserId: actor.userId, action: "demo.processing_retried",
      targetType: "conversation", targetId: session.conversation_id }, db);
  });
}

export async function getDemoState(actor: SessionUser, sessionId?: string) {
  await assertDemoActor(actor);
  const sessions = await query(`select s.id,s.conversation_id,s.ai_mode,s.ai_selection,s.ai_configuration,s.created_at from customer_demo_sessions s
    join conversations c on c.id=s.conversation_id and c.client_id=s.client_id and c.deleted_at is null
    where s.client_id=$1 and s.user_id=$2 order by s.created_at desc limit 20`, [DEMO_CLIENT_ID, actor.userId]);
  let realAi: { available: boolean; detail: string; provider?: string; model?: string };
  try {
    const config = await requireRealDemoConfiguration(true, profileForDemoChoice(DEFAULT_DEMO_MODEL));
    realAi = { available: true, detail: "Configured on the server.", provider: config.provider, model: config.model };
  } catch (error) { realAi = { available: false, detail: error instanceof DemoError ? error.message : "Real AI configuration could not be checked." }; }
  const modelChoices = await demoModelAvailability();
  if (!sessionId) return { now: new Date().toISOString(), sessions: sessions.rows, realAi, modelChoices, session: null, messages: [], job: null, providerError: false, providerFailureCode: null };
  const session = await ownedSession(actor, sessionId);
  const [messages, job, failedProvider] = await Promise.all([
    query(`select id,body,'customer' as sender,created_at,null::text as generation_mode,
      null::text as response_provider,null::text as response_model from messages
      where client_id=$1 and conversation_id=$2 and sender_role='customer'
      union all
      select o.id,o.body,case when o.metadata->>'purpose' in ('agent_answer','escalation_holding_reply') then 'business' else 'human' end,
        o.sent_at, m.metadata->>'generationMode',m.metadata->>'responseProvider',m.metadata->>'responseModel'
      from outbound_messages o left join messages m on m.id::text=o.metadata->>'agentMessageId' and m.client_id=o.client_id
      where o.client_id=$1 and o.conversation_id=$2 and o.status='sent' order by created_at,id`,
      [DEMO_CLIENT_ID, session.conversation_id]),
    query(`select j.status,j.attempt_count,j.created_at,j.failure_code,j.failure_provider,j.available_at,
      (select o.status from outbound_messages o where o.client_id=j.client_id
        and o.metadata->>'customerMessageId'=j.message_id::text order by o.created_at desc limit 1) as delivery_status
      from inbound_jobs j where j.client_id=$1
      and conversation_id=$2 order by sequence desc limit 1`, [DEMO_CLIENT_ID, session.conversation_id]),
    query<{ reason_detail: string }>(`select reason_detail from escalations where client_id=$1 and conversation_id=$2 and reason_code='provider_error'
      and status in ('open','claimed') limit 1`,
      [DEMO_CLIENT_ID, session.conversation_id]),
  ]);
  const operationalFailure = ["failed", "dead"].includes(job.rows[0]?.status) ? job.rows[0]?.failure_code : null;
  const providerFailureCode = operationalFailure ?? (failedProvider.rows[0]?.reason_detail?.includes("quota_exhausted") ? "quota_exhausted" : null);
  return { now: new Date().toISOString(), sessions: sessions.rows, realAi, modelChoices, session, messages: messages.rows, job: job.rows[0] ?? null,
    providerError: Boolean(operationalFailure) || failedProvider.rows.length > 0, providerFailureCode };
}
