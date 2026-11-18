import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db";
import { encryptedChannelCredentialValues } from "@/lib/channels/credentials";
import { claimInboundJob, finishInboundJob, ingestInboundMessage } from "@/lib/channels/inbox";
import { enqueueOutboundMessage, flushOutboundMessage, listRetryableOutboundMessages } from "@/lib/channels/outbox";
import { updateConversationAction } from "@/lib/conversation-actions";
import { POST } from "@/app/api/webhooks/instagram/[channelId]/route";

const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;
dbDescribe("Unified Login queue concurrency", () => {
  let clientId: string, channelId: string, responderId: string;
  const secret = "concurrency-fixture-secret";
  beforeEach(async () => {
    clientId = randomUUID(); channelId = randomUUID(); responderId = randomUUID();
    const db = getPool();
    await db.query("insert into clients(id,name,slug,vertical,brand_voice) values($1,'Fixture',$2,'fnb','Clear')", [clientId, clientId]);
    const encrypted = encryptedChannelCredentialValues({ accessToken: "fixture-token", appSecret: secret, igUserId: "ig-business" });
    await db.query(`insert into channels(id,client_id,kind,name,status,external_id,settings,credentials,
      encrypted_credentials,credentials_encryption_nonce,credentials_encryption_tag)
      values($1,$2,'instagram','Fixture','active','ig-business','{"authMode":"unified_login"}', '{}',$3,$4,$5)`,
    [channelId, clientId, encrypted.encryptedCredentials, encrypted.nonce, encrypted.tag]);
    await db.query(`insert into users(id,client_id,email,name,role,password_hash)
      values($1,$2,$3,'Fixture responder','client','no-interactive-login')`, [responderId, clientId, `${responderId}@fixture.invalid`]);
    await db.query("insert into staff_permission_grants(client_id,user_id,permission) values($1,$2,'conversation.respond')", [clientId, responderId]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message_id: "mid.fixture" }))));
  });
  afterEach(async () => {
    await getPool().query("delete from clients where id=$1", [clientId]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs(); vi.restoreAllMocks();
  });
  afterAll(async () => { await getPool().end(); });
  const incoming = (id: string, thread = "customer-a") => ({ channelId, channelKind: "instagram" as const,
    externalMessageId: id, externalThreadId: thread, customerHandle: thread, text: "Hello",
    occurredAt: new Date().toISOString(), raw: {} });
  async function queue(id: string, thread = "customer-a") {
    const inbound = await ingestInboundMessage(incoming(id, thread));
    return enqueueOutboundMessage(getPool(), { clientId, channelId, conversationId: inbound.conversationId,
      externalThreadId: thread, body: id, idempotencyKey: id, metadata: { purpose: "agent_answer" } });
  }

  it("acknowledges eight simultaneous copies of one signed webhook with one message and one job", async () => {
    const raw = JSON.stringify({ object: "instagram", entry: [{ id: "ig-business", messaging: [{
      sender: { id: "customer-a" }, recipient: { id: "ig-business" }, timestamp: Date.now(),
      message: { mid: "mid.burst", text: "Hello" },
    }] }] });
    const signature = createHmac("sha256", secret).update(raw).digest("hex");
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => POST(new Request("http://localhost/webhook", {
      method: "POST", headers: { "x-hub-signature-256": `sha256=${signature}` }, body: raw,
    }), { params: Promise.resolve({ channelId }) })));
    expect(results.filter(result => result.status === "rejected")).toHaveLength(0);
    const bodies = await Promise.all(results.map(async result => {
      if (result.status !== "fulfilled") return null;
      expect(result.value.status).toBe(200); return result.value.json();
    }));
    expect(bodies.filter(body => body?.duplicates === 0)).toHaveLength(1);
    expect((await getPool().query("select id from messages where client_id=$1", [clientId])).rowCount).toBe(1);
    expect((await getPool().query("select id from inbound_jobs where client_id=$1", [clientId])).rowCount).toBe(1);
  });

  it("claims different conversations in parallel while keeping the second turn of a busy conversation pending", async () => {
    const first = await ingestInboundMessage(incoming("mid.first"));
    const second = await ingestInboundMessage(incoming("mid.second"));
    const other = await ingestInboundMessage(incoming("mid.other", "customer-b"));
    const claims = await Promise.all(Array.from({ length: 4 }, () => claimInboundJob({ channelId, clientId })));
    expect(claims.filter(Boolean).map(row => row!.id).sort()).toEqual([first.jobId, other.jobId].sort());
    expect(await claimInboundJob({ jobId: second.jobId, channelId, clientId })).toBeNull();
    await finishInboundJob(claims.find(row => row?.id === first.jobId)!, "completed");
    expect((await claimInboundJob({ jobId: second.jobId, channelId, clientId }))?.id).toBe(second.jobId);
  });

  it("does not let an expired worker complete a newer attempt's lease", async () => {
    const inbound = await ingestInboundMessage(incoming("mid.lease"));
    const stale = (await claimInboundJob({ jobId: inbound.jobId }))!;
    await getPool().query("update inbound_jobs set lease_expires_at=now()-interval '1 second' where id=$1", [inbound.jobId]);
    const current = (await claimInboundJob({ jobId: inbound.jobId }))!;
    await finishInboundJob(stale, "completed");
    expect((await getPool().query("select status,attempt_count from inbound_jobs where id=$1", [inbound.jobId])).rows[0])
      .toMatchObject({ status: "processing", attempt_count: current.attempt_count });
    await finishInboundJob(current, "completed");
  });

  it("does not send the same outbox row twice or overtake an in-flight reply in the same chat", async () => {
    const first = await queue("first reply"), second = await queue("second reply");
    let release!: () => void, signal!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { signal = resolve; });
    vi.mocked(fetch).mockImplementationOnce(async () => { signal(); await blocked;
      return new Response(JSON.stringify({ message_id: "mid.first" })); });
    const sending = flushOutboundMessage(first.id, { clientId });
    try {
      await started;
      expect((await flushOutboundMessage(first.id, { clientId })).status).toBe("skipped");
      expect((await flushOutboundMessage(second.id, { clientId })).status).toBe("skipped");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { release(); await sending; }
    expect((await flushOutboundMessage(second.id, { clientId })).status).toBe("sent");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("lets a different chat send while another chat is in flight", async () => {
    const first = await queue("first reply"), other = await queue("other reply", "customer-b");
    let release!: () => void, signal!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { signal = resolve; });
    vi.mocked(fetch).mockImplementationOnce(async () => { signal(); await blocked;
      return new Response(JSON.stringify({ message_id: "mid.first" })); });
    const sending = flushOutboundMessage(first.id, { clientId });
    try { await started; expect((await flushOutboundMessage(other.id, { clientId })).status).toBe("sent"); }
    finally { release(); await sending; }
  });

  it("suppresses a queued AI reply after an authorized responder has taken over", async () => {
    const queued = await queue("pending reply");
    await updateConversationAction({ actor: { userId: responderId, email: `${responderId}@fixture.invalid`, name: "Responder",
      role: "client", clientId }, clientId, conversationId: queued.conversation_id!, action: "takeover" });
    expect((await flushOutboundMessage(queued.id, { clientId })).status).toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
    expect((await getPool().query("select status from outbound_messages where id=$1", [queued.id])).rows[0].status).toBe("suppressed");
  });

  it("does not resend an ambiguously accepted reply or let a later reply overtake it", async () => {
    const first = await queue("uncertain reply"), second = await queue("later reply");
    vi.mocked(fetch).mockRejectedValueOnce(new DOMException("injected timeout", "AbortError"));
    expect((await flushOutboundMessage(first.id, { clientId })).status).toBe("failed");
    expect((await getPool().query("select status from outbound_messages where id=$1", [first.id])).rows[0].status).toBe("uncertain");
    expect((await flushOutboundMessage(first.id, { clientId })).status).toBe("skipped");
    expect((await flushOutboundMessage(second.id, { clientId })).status).toBe("skipped");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not fill a small retry batch with a chat blocked by an uncertain reply", async () => {
    const first = await queue("uncertain head");
    await getPool().query("update outbound_messages set status='uncertain' where id=$1", [first.id]);
    await queue("blocked second"); await queue("blocked third");
    const other = await queue("other chat", "customer-b");
    expect((await listRetryableOutboundMessages({ clientId, limit: 1 })).map(row => row.id)).toEqual([other.id]);
  });

  it("logs a correlated local timeline for an in-flight takeover and an ambiguous send without exposing content", async () => {
    vi.stubEnv("PRONTO_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const first = await queue("private reply text"), requestId = randomUUID();
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(fetch).mockImplementationOnce(async () => { started(); await blocked;
      return new Response(JSON.stringify({ message_id: "private-provider-receipt" }), { headers: { "x-fb-trace-id": "private-provider-trace" } }); });
    const sending = flushOutboundMessage(first.id, { clientId, requestId });
    await entered;
    const takeover = updateConversationAction({ actor: { userId: responderId, email: `${responderId}@fixture.invalid`, name: "Responder",
      role: "client", clientId }, clientId, conversationId: first.conversation_id!, action: "takeover" });
    expect(log.mock.calls.some(call => JSON.parse(String(call[0])).event === "conversation.takeover_requested")).toBe(true);
    release(); await Promise.all([sending, takeover]);
    const other = await queue("private uncertain reply", "customer-b");
    vi.mocked(fetch).mockRejectedValueOnce(new DOMException("private transport detail", "AbortError"));
    await flushOutboundMessage(other.id, { clientId });
    const records = log.mock.calls.map(call => JSON.parse(String(call[0]))).filter(record => record.debugDelivery);
    const firstAttempt = records.filter(record => record.outboundMessageId === first.id);
    expect(new Set(firstAttempt.map(record => record.deliveryAttemptId)).size).toBe(1);
    expect(firstAttempt.map(record => record.event)).toEqual([
      "delivery.attempt_started", "delivery.ownership_checked", "delivery.dispatch_started", "instagram.send_started",
      "instagram.response_received", "instagram.provider_accepted", "delivery.dispatch_completed", "delivery.attempt_finished",
    ]);
    expect(firstAttempt.at(-1)).toMatchObject({ requestId, finalState: "sent", statePersisted: true, acceptanceState: "reported" });
    expect(firstAttempt.find(record => record.event === "instagram.provider_accepted").providerReceiptHash).toMatch(/^sha256:/);
    const acceptedIndex = records.findIndex(record => record.event === "instagram.provider_accepted");
    expect(records.findIndex(record => record.event === "conversation.takeover_committed")).toBeGreaterThan(acceptedIndex);
    expect(records.find(record => record.event === "delivery.attempt_finished" && record.outboundMessageId === other.id))
      .toMatchObject({ finalState: "uncertain", statePersisted: true, acceptanceState: "unknown" });
    const output = JSON.stringify(records);
    for (const privateValue of ["private reply text", "private uncertain reply", "fixture-token", secret,
      "customer-a", "customer-b", "private-provider-receipt", "private-provider-trace", "private transport detail"])
      expect(output).not.toContain(privateValue);
  });
});
