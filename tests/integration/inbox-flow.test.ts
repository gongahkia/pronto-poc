import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db";
import { ingestInboundMessage } from "@/lib/channels/inbox";
import { processInboundJob } from "@/lib/channels/inbox-worker";
import { flushRetryableOutboundMessages, markStaleOutboundUncertain } from "@/lib/channels/outbox";
import { getClientAttentionItems } from "@/lib/dashboard";

const fakes = vi.hoisted(() => ({
  runAgentForMessage: vi.fn(), createEscalation: vi.fn(),
  sendChannelText: vi.fn(async () => undefined), notifyOwnerOfEscalation: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent/engine", () => ({
  runAgentForMessage: fakes.runAgentForMessage, createEscalation: fakes.createEscalation,
}));
vi.mock("@/lib/channels/dispatch", () => ({ sendChannelText: fakes.sendChannelText }));
vi.mock("@/lib/escalations", () => ({ notifyOwnerOfEscalation: fakes.notifyOwnerOfEscalation }));

const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;

dbDescribe("durable inbound processing in isolated PostgreSQL", () => {
  let clientId: string;
  let otherClientId: string;
  let channelId: string;
  let otherChannelId: string;

  beforeEach(async () => {
    clientId = randomUUID(); otherClientId = randomUUID();
    channelId = randomUUID(); otherChannelId = randomUUID();
    vi.resetAllMocks();
    fakes.sendChannelText.mockResolvedValue(undefined);
    fakes.notifyOwnerOfEscalation.mockResolvedValue(undefined);
    const db = getPool();
    await db.query(
      `insert into clients (id, name, slug, vertical, brand_voice) values
       ($1, 'Pronto A', $2, 'fnb', 'Warm'), ($3, 'Pronto B', $4, 'fnb', 'Formal')`,
      [clientId, `s1-a-${clientId}`, otherClientId, `s1-b-${otherClientId}`],
    );
    await db.query(
      `insert into channels (id, client_id, kind, name, status, external_id) values
       ($1, $2, 'whatsapp', 'A WhatsApp', 'active', 'phone-a'),
       ($3, $4, 'whatsapp', 'B WhatsApp', 'active', 'phone-b')`,
      [channelId, clientId, otherChannelId, otherClientId],
    );
    fakes.runAgentForMessage.mockImplementation(async (input: {
      clientId: string; channelId: string; conversationId: string; customerMessageId: string;
    }) => {
      const text = "Pronto A closes at 9 pm.";
      const saved = await db.query<{ id: string }>(
        `insert into messages (conversation_id, client_id, channel_id, external_message_id, sender_role, body, metadata)
         values ($1, $2, $3, $4, 'agent', $5, $6)
         on conflict (channel_id, external_message_id) do update set external_message_id = excluded.external_message_id returning id`,
        [input.conversationId, input.clientId, input.channelId, `agent-${input.customerMessageId}`, text,
          { customerMessageId: input.customerMessageId, reasonCode: "grounded_answer" }],
      );
      return { action: "answered", responseText: text, reasonCode: "grounded_answer",
        agentMessageId: saved.rows[0].id };
    });
    fakes.createEscalation.mockImplementation(async (input: {
      clientId: string; conversationId: string; customerMessageId: string; reasonCode: string;
      reasonDetail: string; confidence: number;
    }) => {
      await db.query("update conversations set status = 'escalated' where id = $1 and client_id = $2",
        [input.conversationId, input.clientId]);
      const saved = await db.query<{ id: string }>(
        `insert into escalations (client_id, conversation_id, message_id, reason_code, reason_detail, confidence)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [input.clientId, input.conversationId, input.customerMessageId,
          input.reasonCode, input.reasonDetail, input.confidence],
      );
      return { action: "escalated", escalationId: saved.rows[0].id };
    });
  });

  afterEach(async () => {
    await getPool().query("delete from clients where id = any($1::uuid[])", [[clientId, otherClientId]]);
  });
  afterAll(async () => { await getPool().end(); });

  const inbound = (channel: string, id: string, text = "When do you close?") => ({
    channelId: channel, channelKind: "whatsapp" as const, externalMessageId: id,
    externalThreadId: "shared-customer", customerHandle: "shared-customer", text, raw: { fixture: true },
  });

  it("commits a message and one job, then queues one answer outside the webhook", async () => {
    const first = await ingestInboundMessage(inbound(channelId, "first"));
    const duplicate = await ingestInboundMessage(inbound(channelId, "first"));
    expect(duplicate).toMatchObject({ duplicate: true, jobId: first.jobId });
    expect(fakes.runAgentForMessage).not.toHaveBeenCalled();
    expect((await getPool().query("select id from outbound_messages where client_id = $1", [clientId])).rows).toEqual([]);
    expect(await processInboundJob()).toEqual({ jobId: first.jobId, outcome: "answered" });
    const outbox = await getPool().query<{ status: string }>(
      "select status from outbound_messages where client_id = $1", [clientId]);
    expect(outbox.rows).toEqual([{ status: "pending" }]);
    await flushRetryableOutboundMessages();
    expect(fakes.sendChannelText).toHaveBeenCalledTimes(1);
    expect(fakes.sendChannelText).toHaveBeenCalledWith(expect.objectContaining({
      clientId, channelId, externalThreadId: "shared-customer",
    }), expect.objectContaining({ query: expect.any(Function) }));
  });

  it("retries a persisted message after an agent failure and provider redelivery", async () => {
    fakes.runAgentForMessage.mockRejectedValueOnce(new Error("injected model failure"));
    const first = await ingestInboundMessage(inbound(channelId, "retry"));
    await expect(processInboundJob({ jobId: first.jobId })).rejects.toThrow("injected model failure");
    const duplicate = await ingestInboundMessage(inbound(channelId, "retry"));
    expect(duplicate.jobId).toBe(first.jobId);
    await getPool().query("update inbound_jobs set available_at = now() where id = $1", [first.jobId]);
    expect(await processInboundJob({ jobId: first.jobId })).toEqual({ jobId: first.jobId, outcome: "answered" });
    expect(fakes.runAgentForMessage).toHaveBeenCalledTimes(2);
    const jobs = await getPool().query<{ status: string; attempt_count: number }>(
      "select status, attempt_count from inbound_jobs where id = $1", [first.jobId]);
    expect(jobs.rows[0]).toEqual({ status: "completed", attempt_count: 2 });
  });

  it("recovers a lease after answer persistence without rerunning the agent or duplicating the outbox", async () => {
    const first = await ingestInboundMessage(inbound(channelId, "crash"));
    await processInboundJob({ jobId: first.jobId });
    await getPool().query(
      "update inbound_jobs set status = 'processing', lease_expires_at = now() - interval '1 second' where id = $1",
      [first.jobId],
    );
    await processInboundJob({ jobId: first.jobId });
    expect(fakes.runAgentForMessage).toHaveBeenCalledTimes(1);
    const outbox = await getPool().query("select id from outbound_messages where client_id = $1", [clientId]);
    expect(outbox.rows).toHaveLength(1);
  });

  it("claims at most one job per conversation and keeps tenant threads separate", async () => {
    const first = await ingestInboundMessage(inbound(channelId, "ordered-1"));
    const second = await ingestInboundMessage(inbound(channelId, "ordered-2"));
    const other = await ingestInboundMessage(inbound(otherChannelId, "other-1"));
    expect(other.conversationId).not.toBe(first.conversationId);
    const claims = await Promise.all([processInboundJob(), processInboundJob()]);
    expect(claims.filter(Boolean).map((row) => row?.jobId).sort()).toEqual([first.jobId, other.jobId].sort());
    expect(await processInboundJob()).toEqual({ jobId: second.jobId, outcome: "answered" });
    const rows = await getPool().query<{ client_id: string }>(
      "select client_id from messages where id = $1", [other.messageId]);
    expect(rows.rows[0].client_id).toBe(otherClientId);
  });

  it("keeps a second message pending while the first message is still executing", async () => {
    const first = await ingestInboundMessage(inbound(channelId, "slow-first"));
    const second = await ingestInboundMessage(inbound(channelId, "slow-second"));
    const original = fakes.runAgentForMessage.getMockImplementation();
    let signalStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    fakes.runAgentForMessage.mockImplementationOnce(async (input) => {
      signalStarted();
      await blocked;
      return original?.(input);
    });
    const processing = processInboundJob({ jobId: first.jobId });
    try {
      await started;
      expect(await processInboundJob({ jobId: second.jobId })).toBeNull();
      expect(fakes.runAgentForMessage).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst();
    }
    expect(await processing).toEqual({ jobId: first.jobId, outcome: "answered" });
    expect(await processInboundJob({ jobId: second.jobId })).toEqual({ jobId: second.jobId, outcome: "answered" });
  });

  it("does not run AI for human-owned or disabled conversations", async () => {
    const first = await ingestInboundMessage({ ...inbound(channelId, "media"),
      unsupportedMediaType: "image" });
    await processInboundJob({ jobId: first.jobId });
    const later = await ingestInboundMessage(inbound(channelId, "after-handoff"));
    expect(await processInboundJob({ jobId: later.jobId })).toEqual({ jobId: later.jobId, outcome: "skipped" });
    expect(fakes.runAgentForMessage).not.toHaveBeenCalled();
    await getPool().query("update channels set status = 'disabled' where id = $1", [channelId]);
    await expect(ingestInboundMessage(inbound(channelId, "disabled"))).rejects.toThrow(/disabled|inactive/);
  });

  it("suppresses a queued AI reply if a human takes ownership before delivery", async () => {
    const first = await ingestInboundMessage(inbound(channelId, "pending-answer"));
    await processInboundJob({ jobId: first.jobId });
    const escalation = await ingestInboundMessage({ ...inbound(channelId, "needs-human"),
      unsupportedMediaType: "image" });
    await processInboundJob({ jobId: escalation.jobId });
    await flushRetryableOutboundMessages();
    const rows = await getPool().query<{ status: string; metadata: Record<string, unknown> }>(
      "select status, metadata from outbound_messages where client_id = $1 order by created_at",
      [clientId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((row) => row.metadata.purpose === "agent_answer")?.status).toBe("suppressed");
    expect(fakes.sendChannelText).toHaveBeenCalledTimes(1);
    expect(fakes.sendChannelText).toHaveBeenCalledWith(expect.objectContaining({
      channelId, externalThreadId: "shared-customer",
    }));
  });

  it("does not automatically resend an outbound message with ambiguous provider acceptance", async () => {
    const first = await ingestInboundMessage(inbound(channelId, "outbound-ambiguous"));
    await processInboundJob({ jobId: first.jobId });
    await getPool().query(
      "update outbound_messages set status = 'sending', updated_at = now() - interval '20 minutes' where client_id = $1",
      [clientId],
    );
    expect(await markStaleOutboundUncertain(10)).toBe(1);
    await flushRetryableOutboundMessages();
    expect(fakes.sendChannelText).not.toHaveBeenCalled();
    const row = await getPool().query<{ status: string }>(
      "select status from outbound_messages where client_id = $1", [clientId],
    );
    expect(row.rows[0].status).toBe("uncertain");
  });

  it("marks an exhausted outbound send dead so the operator can see it", async () => {
    const first = await ingestInboundMessage(inbound(channelId, "outbound-exhausted"));
    await processInboundJob({ jobId: first.jobId });
    fakes.sendChannelText.mockRejectedValueOnce(new Error("injected transport rejection"));
    const result = await flushRetryableOutboundMessages({ maxAttempts: 1 });
    expect(result.failed).toBe(1);
    const row = await getPool().query<{ status: string; attempt_count: number }>(
      "select status, attempt_count from outbound_messages where client_id = $1", [clientId],
    );
    expect(row.rows[0]).toEqual({ status: "dead", attempt_count: 1 });
    expect(await getClientAttentionItems(clientId)).toEqual([
      expect.objectContaining({ kind: "outbound", status: "dead" }),
    ]);
    await flushRetryableOutboundMessages({ maxAttempts: 1 });
    expect(fakes.sendChannelText).toHaveBeenCalledTimes(1);
  });
});
