import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db";
import { createDemoSession, getDemoState, sendDemoMessage, retryDemoProcessing } from "@/lib/customer-demo";
import { setupCustomerSimulator } from "@/lib/customer-demo-setup";
import { DEMO_CLIENT_ID, DEMO_CHANNEL_ID } from "@/lib/customer-demo-boundary";
import { processInboundJob } from "@/lib/channels/inbox-worker";
import { flushRetryableOutboundMessages } from "@/lib/channels/outbox";
import { updateConversationAction } from "@/lib/conversation-actions";
import { getFilteredConversations } from "@/lib/reporting";
import { canViewBusinessConversation } from "@/lib/staff-permissions";
import { retrieveKnowledge } from "@/lib/knowledge/retrieve";
import { deterministicEmbedding } from "@/lib/llm/mock";
import { OpenAiProvider } from "@/lib/llm/openai";
import { shouldUseMockAi } from "@/lib/env";
import { sendChannelText } from "@/lib/channels/dispatch";
import type { SessionUser } from "@/lib/auth";
import { removePsCafeDemo, setupPsCafeDemo, PS_CAFE_DEMO_RESPONDER_ID, PS_CAFE_DEMO_ORDINARY_STAFF_ID } from "../../scripts/demo/ps-cafe-raffles-city";

const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;
const actor: SessionUser = { userId: PS_CAFE_DEMO_RESPONDER_ID, role: "client", clientId: DEMO_CLIENT_ID,
  name: "Synthetic responder", email: "responder@ps-cafe-demo.test" };
const ordinary = { ...actor, userId: PS_CAFE_DEMO_ORDINARY_STAFF_ID };

dbDescribe("authenticated simulator through the existing durable backend", () => {
  beforeEach(async () => {
    vi.stubEnv("PRONTO_CUSTOMER_DEMO_ENABLED", "1");
    vi.stubEnv("OPENAI_API_KEY", "");
    await removePsCafeDemo(); await setupPsCafeDemo(); await setupCustomerSimulator();
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await removePsCafeDemo(); });
  afterAll(async () => { await getPool().end(); });
  const send = (sessionId: string, text = "What time do you close today?", requestId = randomUUID()) =>
    sendDemoMessage(actor, { sessionId, text, requestId });

  it('keeps a routine issue flagged while answering a supported follow-up, until staff take over', async () => {
    const session = await createDemoSession(actor, 'mock');
    const refund = await send(session.id, 'My order has a missing item and I want a refund.');
    expect(await processInboundJob({jobId:refund.jobId})).toMatchObject({outcome:'escalated'});
    const review = await getPool().query('select status,owner_action_required from conversations where id=$1',[session.conversationId]);
    expect(review.rows[0]).toMatchObject({status:'active',owner_action_required:true});
    const hours = await send(session.id, 'What time do you close?');
    expect(await processInboundJob({jobId:hours.jobId})).toMatchObject({outcome:'answered'});
    await flushRetryableOutboundMessages();
    const inbox = await getFilteredConversations({clientId:DEMO_CLIENT_ID,status:'needs_reply'});
    expect(inbox.find(row=>row.id===session.conversationId)).toMatchObject({owner_action_required:true,is_resolved:false});
    expect((await getDemoState(actor,session.id)).messages.some(row=>String(row.body).includes('10:00pm'))).toBe(true);
    await updateConversationAction({actor,clientId:DEMO_CLIENT_ID,conversationId:session.conversationId,action:'takeover'});
    const next = await send(session.id, 'Where are you located?');
    expect(await processInboundJob({jobId:next.jobId})).toMatchObject({outcome:'skipped'});
  });

  it('waits for a short message burst, preserves ordering and does not extend the wait on replay', async () => {
    vi.stubEnv('PRONTO_DEMO_REPLY_QUIET_MS','3000');
    const session=await createDemoSession(actor,'mock');
    const requestId=randomUUID();
    const first=await send(session.id,'What time do you close?',requestId);
    await send(session.id,'Where are you located?');
    const before=await getPool().query('select id,available_at from inbound_jobs where conversation_id=$1 order by sequence',[session.conversationId]);
    expect(before.rows).toHaveLength(2);
    expect(before.rows[0].available_at.getTime()).toBe(before.rows[1].available_at.getTime());
    expect(await processInboundJob({jobId:first.jobId})).toBeNull();
    await send(session.id,'What time do you close?',requestId);
    const replay=await getPool().query('select available_at from inbound_jobs where id=$1',[first.jobId]);
    expect(replay.rows[0].available_at).toEqual(before.rows[0].available_at);
    await getPool().query("update inbound_jobs set available_at=now()-interval '1 second' where conversation_id=$1",[session.conversationId]);
    expect(await processInboundJob({jobId:first.jobId})).toMatchObject({outcome:'answered'});
  });

  it("persists one enquiry and job, retrieves tenant knowledge, delivers locally and appears in the business inbox", async () => {
    const session = await createDemoSession(actor, "mock");
    const requestId = randomUUID();
    const inbound = await send(session.id, undefined, requestId);
    expect(await send(session.id, undefined, requestId)).toMatchObject({ duplicate: true, jobId: inbound.jobId });
    expect((await getDemoState(actor, session.id)).messages).toHaveLength(1);
    expect(await processInboundJob({ jobId: inbound.jobId })).toMatchObject({ outcome: "answered" });
    // Persisted model output is not displayed to the customer before delivery.
    expect((await getDemoState(actor, session.id)).messages).toHaveLength(1);
    await flushRetryableOutboundMessages();
    const state = await getDemoState(actor, session.id);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({ generation_mode: "mock" });
    expect(String(state.messages[1].body)).toContain("10:00pm");
    expect(await canViewBusinessConversation(actor, DEMO_CLIENT_ID)).toBe(true);
    const inbox = await getFilteredConversations({ clientId: DEMO_CLIENT_ID, status: "ai_handled" });
    expect(inbox.find(row => row.id === session.conversationId)).toMatchObject({ ai_should_respond: true, owner_action_required: false, urgency: "long_term" });
    const delivery = await getPool().query("select status from outbound_messages where client_id=$1 and channel_id=$2", [DEMO_CLIENT_ID, DEMO_CHANNEL_ID]);
    expect(delivery.rows).toEqual([{ status: "sent" }]);
  });

  it("keeps owner review independent from AI ownership and enforces takeover authorization", async () => {
    const session = await createDemoSession(actor, "mock"); const inbound = await send(session.id);
    await processInboundJob({ jobId: inbound.jobId });
    await expect(updateConversationAction({ actor: ordinary, clientId: DEMO_CLIENT_ID, conversationId: session.conversationId, action: "takeover" })).rejects.toThrow(/Permission/);
    await updateConversationAction({ actor, clientId: DEMO_CLIENT_ID, conversationId: session.conversationId,
      action: "classify", ownerActionRequired: true, urgency: "short_term" });
    const row = await getPool().query("select status,ai_should_respond,owner_action_required,urgency from conversations where id=$1", [session.conversationId]);
    expect(row.rows[0]).toMatchObject({ status: "active", ai_should_respond: true, owner_action_required: true, urgency: "short_term" });
    await updateConversationAction({ actor, clientId: DEMO_CLIENT_ID, conversationId: session.conversationId, action: "takeover" });
    await expect(updateConversationAction({ actor, clientId: DEMO_CLIENT_ID, conversationId: session.conversationId,
      action: "classify", ownerActionRequired: false, urgency: "long_term" })).rejects.toThrow(/Resolve/);
    const second = await send(session.id, "What about tomorrow?");
    expect(await processInboundJob({ jobId: second.jobId })).toMatchObject({ outcome: "skipped" });
    await flushRetryableOutboundMessages();
    const state = await getDemoState(actor, session.id);
    expect(state.session?.status).toBe("escalated");
    // The queued AI answer from before takeover was ownership-suppressed too.
    expect(state.messages.every(message => message.sender === "customer")).toBe(true);
  });

  it("does not answer a human-owned backlog even if release happens before worker claim", async () => {
    const session = await createDemoSession(actor, "mock"); const first = await send(session.id);
    await processInboundJob({ jobId: first.jobId });
    await updateConversationAction({ actor, clientId: DEMO_CLIENT_ID, conversationId: session.conversationId, action: "takeover" });
    const backlog = await send(session.id, "Please let the staff reply.");
    // Fixture transition represents release; HTTP permissions are covered separately.
    await getPool().query("update escalations set status='resolved' where client_id=$1 and conversation_id=$2", [DEMO_CLIENT_ID, session.conversationId]);
    await getPool().query("update conversations set status='active' where client_id=$1 and id=$2", [DEMO_CLIENT_ID, session.conversationId]);
    expect(await processInboundJob({ jobId: backlog.jobId })).toMatchObject({ outcome: "skipped" });
    const future = await send(session.id); expect(await processInboundJob({ jobId: future.jobId })).toMatchObject({ outcome: "answered" });
  });

  it("rejects cross-tenant, cross-customer and revoked identities; keeps mock opt-in explicit", async () => {
    const session = await createDemoSession(actor, "mock");
    await expect(getDemoState(ordinary, session.id)).rejects.toThrow(/not found/);
    await expect(sendDemoMessage(ordinary, { sessionId: session.id, requestId: randomUUID(), text: "Steal" })).rejects.toThrow(/not found/);
    await expect(createDemoSession({ ...actor, clientId: randomUUID() }, "mock")).rejects.toThrow(/Forbidden/);
    await getPool().query("delete from users where id=$1", [PS_CAFE_DEMO_ORDINARY_STAFF_ID]);
    await expect(createDemoSession(ordinary, "mock")).rejects.toThrow(/not authorized/);
    await expect(createDemoSession(actor, "real", "configured")).rejects.toThrow(/OPENAI_API_KEY/);
    expect((await getDemoState(actor)).sessions).toHaveLength(1);
    vi.stubEnv("NODE_ENV", "production"); await expect(getDemoState(actor)).rejects.toThrow(/disabled/);
  });

  it("limits pending work, changed retries, message length and simulator send rate", async () => {
    const session = await createDemoSession(actor, "mock"); const id = randomUUID();
    const first = await send(session.id, "What time do you close today?", id);
    await expect(send(session.id, "Changed", id)).rejects.toThrow(/retry/);
    await expect(send(session.id, "x".repeat(4001))).rejects.toThrow(/4000/);
    await getPool().query("update inbound_jobs set status='processing', lease_expires_at=now()+interval '1 minute' where id=$1",[first.jobId]);
    await expect(send(session.id)).rejects.toThrow(/processing/);
    await getPool().query("update inbound_jobs set status='dead' where id=$1", [first.jobId]);
    await retryDemoProcessing(actor, session.id);
    expect(await processInboundJob({ jobId: first.jobId })).toMatchObject({ outcome: "answered" });
    await expect(retryDemoProcessing(actor, session.id)).rejects.toThrow(/Only a stopped/);
    for (let index=0;index<9;index++) {
      const next=await send(session.id); await processInboundJob({ jobId: next.jobId });
    }
    await expect(send(session.id)).rejects.toThrow(/wait before sending/);
  });

  it("never retrieves deterministic vectors as real-provider knowledge", async () => {
    const input = deterministicEmbedding("What time do you close today?");
    expect(await retrieveKnowledge(DEMO_CLIENT_ID, input, 5, { queryText: "close", embeddingProvider: "openai" })).toEqual([]);
    const other = await retrieveKnowledge(randomUUID(), input, 5, { queryText: "close" }); expect(other).toEqual([]);
  });

  it("exercises the real-mode branch with an explicitly stubbed provider, without silently inheriting global mock mode", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-only-no-live-call");
    await getPool().query(`update knowledge_chunks set metadata=metadata || '{"embeddingProvider":"openai"}'::jsonb where client_id=$1`, [DEMO_CLIENT_ID]);
    const embedding = vi.spyOn(OpenAiProvider.prototype, "embed").mockImplementation(async texts => {
      expect(shouldUseMockAi()).toBe(false); return texts.map(deterministicEmbedding);
    });
    const generation = vi.spyOn(OpenAiProvider.prototype, "generateGroundedAnswer").mockImplementation(async input => {
      expect(shouldUseMockAi()).toBe(false);
      expect(input.retrievedChunks.every(chunk => chunk.client_id === DEMO_CLIENT_ID)).toBe(true);
      return { action: "answer", answer: input.retrievedChunks[0].content, confidence: 0.95,
        reasonCode: "grounded_answer", reasonDetail: "Stubbed provider transport; not genuine inference.",
        citedChunkIds: [input.retrievedChunks[0].id] };
    });
    const session = await createDemoSession(actor, "real", "configured"); const inbound = await send(session.id);
    expect(await processInboundJob({ jobId: inbound.jobId })).toMatchObject({ outcome: "answered" });
    await flushRetryableOutboundMessages();
    expect((await getDemoState(actor, session.id)).messages[1]).toMatchObject({ generation_mode: "real" });
    expect(embedding).toHaveBeenCalledOnce(); expect(generation).toHaveBeenCalledOnce();
    expect(shouldUseMockAi()).toBe(true);
    generation.mockRejectedValueOnce(new Error("Synthetic provider timeout"));
    const failed = await createDemoSession(actor, "real", "configured"); const failedJob = await send(failed.id);
    await expect(processInboundJob({ jobId: failedJob.jobId })).rejects.toMatchObject({ code: "unavailable" });
    await flushRetryableOutboundMessages();
    const failureState = await getDemoState(actor, failed.id);
    expect(failureState).toMatchObject({ providerError: true, session: { status: "active" }, job: { status: "failed" } });
    expect(failureState.messages.every(message => message.generation_mode == null)).toBe(true);
  });

  it("blocks external provider delivery in the simulator sandbox even for active fixture channels", async () => {
    vi.stubEnv("PRONTO_DEMO_ONLY_DELIVERY", "1");
    const id=randomUUID();
    await getPool().query(`insert into channels(id,client_id,kind,name,status) values ($1,$2,'instagram','Synthetic active Meta fixture','active')`, [id,DEMO_CLIENT_ID]);
    await expect(sendChannelText({ channelId:id, clientId:DEMO_CLIENT_ID, externalThreadId:"fixture", text:"Never send externally" }))
      .rejects.toThrow(/External provider delivery is disabled/);
  });

  it("uses existing escalation and preserves the Chope outlet-link behavior without provider calls", async () => {
    const booking = await createDemoSession(actor, "mock");
    const bookingJob = await send(booking.id, "Hi, can I reserve a table for two tomorrow around 7pm?");
    await processInboundJob({ jobId: bookingJob.jobId }); await flushRetryableOutboundMessages();
    expect(String((await getDemoState(actor, booking.id)).messages[1].body)).toContain("I cannot confirm a reservation here");
    const refund = await createDemoSession(actor, "mock"); const refundJob = await send(refund.id, "My order has a missing item and I want a refund.");
    expect(await processInboundJob({ jobId: refundJob.jobId })).toMatchObject({ outcome: "escalated" });
    await flushRetryableOutboundMessages();
    expect((await getDemoState(actor, refund.id)).session?.status).toBe("active");
    expect((await getFilteredConversations({ clientId: DEMO_CLIENT_ID, status: "pending" })).some(row => row.id === refund.conversationId)).toBe(true);
  });
});
