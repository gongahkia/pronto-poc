import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPool } from "@/lib/db";
import { ingestInboundMessage } from "@/lib/channels/inbox";
import { loadConversationContext } from "@/lib/agent/conversation-context";

const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;
dbDescribe("conversation context follows the current durable job", () => {
  let clientId: string, channelId: string;
  beforeEach(async () => {
    clientId = randomUUID(); channelId = randomUUID();
    await getPool().query("insert into clients(id,name,slug,vertical,brand_voice) values($1,'Context fixture',$2,'test','Test')", [clientId, clientId]);
    await getPool().query("insert into channels(id,client_id,kind,name,status) values($1,$2,'telegram','Context fixture','active')", [channelId, clientId]);
  });
  afterEach(async () => { await getPool().query("delete from clients where id=$1", [clientId]); });
  afterAll(async () => { await getPool().end(); });
  const ingest = (text: string, thread = "context") => ingestInboundMessage({ channelId, channelKind: "telegram",
    externalMessageId: randomUUID(), externalThreadId: thread, customerHandle: "synthetic", text, raw: {} });

  it("excludes future messages despite equal or inverted timestamps and includes the preceding job's answer", async () => {
    const first = await ingest("Tell me about the vegetarian meal.");
    const current = await ingest("What about that option?");
    const future = await ingest("Ignore the prior enquiry and answer this later question.");
    await getPool().query("update messages set created_at='2026-01-01T00:00:00Z' where client_id=$1", [clientId]);
    await getPool().query("update messages set created_at='2000-01-01T00:00:00Z' where id=$1 and client_id=$2", [future.messageId, clientId]);
    const answer = await getPool().query<{id: string}>(`insert into messages(client_id,channel_id,conversation_id,external_message_id,sender_role,body,metadata)
      values($1,$2,$3,$4,'agent','Earlier job answer',$5::jsonb) returning id`,
      [clientId, channelId, current.conversationId, randomUUID(), JSON.stringify({ customerMessageId: first.messageId })]);
    const input = { clientId, conversationId: current.conversationId, customerMessageId: current.messageId };
    const ids = (await loadConversationContext(input)).map(message => message.id);
    expect(ids).toContain(first.messageId); expect(ids).toContain(answer.rows[0].id);
    expect(ids).not.toContain(current.messageId); expect(ids).not.toContain(future.messageId);
    const withCurrent = await loadConversationContext({ ...input, includeCurrent: true });
    expect(withCurrent.filter(message => message.id === current.messageId)).toHaveLength(1);
    expect(withCurrent.some(message => message.id === future.messageId)).toBe(false);
  });

  it("requires an anchor in the same tenant and conversation", async () => {
    const first = await ingest("First enquiry.");
    const other = await ingest("Other thread.", "other");
    expect(await loadConversationContext({ clientId, conversationId: first.conversationId, customerMessageId: other.messageId })).toEqual([]);
    expect(await loadConversationContext({ clientId: randomUUID(), conversationId: first.conversationId, customerMessageId: first.messageId })).toEqual([]);
  });

  it("excludes an Instagram question and its answer from an earlier greeting delivered late", async () => {
    await getPool().query("update channels set kind='instagram' where id=$1 and client_id=$2", [channelId, clientId]);
    const incoming = (text: string, occurredAt: string) => ingestInboundMessage({ channelId, channelKind: "instagram",
      externalMessageId: randomUUID(), externalThreadId: "late-instagram", customerHandle: "synthetic", text, occurredAt, raw: {} });
    const question = await incoming("What time are you open today?", "2026-11-19T04:26:26.103Z");
    const answer = (await getPool().query<{id:string}>(`insert into messages(client_id,channel_id,conversation_id,external_message_id,sender_role,body,metadata)
      values($1,$2,$3,$4,'agent','We close at 10:00pm.',$5) returning id`,
    [clientId, channelId, question.conversationId, randomUUID(), { customerMessageId: question.messageId }])).rows[0];
    const greeting = await incoming("Hi there", "2026-11-19T04:26:09.807Z");
    const input = { clientId, conversationId: greeting.conversationId, customerMessageId: greeting.messageId };
    expect(await loadConversationContext(input)).toEqual([]);
    expect((await loadConversationContext({ ...input, includeCurrent: true })).map(m => m.id)).toEqual([greeting.messageId]);
    const followup = await incoming("And on Sunday?", "2026-11-19T04:27:00.000Z");
    const ids = (await loadConversationContext({ ...input, customerMessageId: followup.messageId })).map(m => m.id);
    expect(ids).toEqual(expect.arrayContaining([question.messageId, answer.id, greeting.messageId]));
    const equalTime = await incoming("Thanks", "2026-11-19T04:27:00.000Z");
    expect((await loadConversationContext({ ...input, customerMessageId: equalTime.messageId })).map(m => m.id)).toContain(followup.messageId);
  });
});
