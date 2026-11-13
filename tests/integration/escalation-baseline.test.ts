import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPool, vectorLiteral } from "@/lib/db";
import { createEscalation, runAgentForMessage } from "@/lib/agent/engine";
import { deterministicEmbedding } from "@/lib/llm/mock";

const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;

dbDescribe("isolated PostgreSQL escalation baseline", () => {
  let clientId: string;
  let channelId: string;
  let conversationId: string;
  let messageId: string;

  beforeEach(async () => {
    clientId = randomUUID();
    channelId = randomUUID();
    conversationId = randomUUID();
    messageId = randomUUID();
    const db = getPool();
    await db.query(
      "insert into clients (id, name, slug, vertical, brand_voice) values ($1, 'Escalation fixture', $2, 'test', 'Calm')",
      [clientId, `test-escalation-${clientId}`],
    );
    await db.query(
      "insert into channels (id, client_id, kind, name, status) values ($1, $2, 'whatsapp', 'Fixture', 'active')",
      [channelId, clientId],
    );
    await db.query(
      "insert into conversations (id, client_id, channel_id, external_thread_id) values ($1, $2, $3, 'customer-1')",
      [conversationId, clientId, channelId],
    );
    await db.query(
      `insert into messages (id, conversation_id, client_id, channel_id, external_message_id, sender_role, body)
       values ($1, $2, $3, $4, 'inbound-1', 'customer', 'Please cancel my booking')`,
      [messageId, conversationId, clientId, channelId],
    );
  });

  afterEach(async () => {
    await getPool().query("delete from clients where id = $1", [clientId]);
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("creates a tenant-scoped review and keeps routine follow-ups available", async () => {
    const result = await createEscalation({
      clientId, channelId, conversationId, customerMessageId: messageId,
      customerMessage: "Please cancel my booking",
      reasonCode: "transactional_action", reasonDetail: "Human required.", confidence: 1,
    });
    expect(result.action).toBe("escalated");
    const db = getPool();
    const escalation = await db.query<{ client_id: string; status: string; message_id: string }>(
      "select client_id, status, message_id from escalations where id = $1",
      [result.escalationId],
    );
    expect(escalation.rows[0]).toMatchObject({
      client_id: clientId, status: "open", message_id: messageId,
    });
    const conversation = await db.query<{ status: string }>(
      "select status from conversations where id = $1", [conversationId],
    );
    expect(conversation.rows[0].status).toBe("active");
  });

  it("reuses an escalation for the same customer message without a unique index", async () => {
    const input = { clientId, channelId, conversationId, customerMessageId: messageId,
      customerMessage: "Please cancel my booking", reasonCode: "transactional_action",
      reasonDetail: "Human required.", confidence: 1 };
    const first = await createEscalation(input);
    const second = await createEscalation(input);
    expect(second.escalationId).toBe(first.escalationId);
    const result = await getPool().query<{ count: string }>(
      "select count(*) from escalations where client_id = $1 and message_id = $2",
      [clientId, messageId],
    );
    expect(Number(result.rows[0].count)).toBe(1);
  });

  it("runs a grounded answer through the real agent path with deterministic mock AI", async () => {
    const sourceId = randomUUID();
    const db = getPool();
    await db.query(
      `insert into agent_configs (client_id, prompt_preamble, retrieval_threshold)
       values ($1, 'Answer only from the retrieved source.', 0)`,
      [clientId],
    );
    await db.query(
      `insert into knowledge_sources (id, client_id, title, source_type, content)
       values ($1, $2, 'Opening hours', 'manual', 'Opening hours are 10:00 AM to 9:00 PM.')`,
      [sourceId, clientId],
    );
    await db.query(
      `insert into knowledge_chunks
       (source_id, client_id, chunk_index, content, token_estimate, embedding, embedding_model, embedding_dimensions)
       values ($1, $2, 0, 'Opening hours are 10:00 AM to 9:00 PM.', 12, $3::vector,
               'text-embedding-3-small', 1536)`,
      [sourceId, clientId, vectorLiteral(deterministicEmbedding("opening hours"))],
    );

    const result = await runAgentForMessage({
      clientId, channelId, channelKind: "whatsapp", conversationId,
      customerMessageId: messageId, customerMessage: "What are your opening hours?",
    });
    expect(result.action).toBe("answered");
    expect(result.citedChunks.some((chunk) => chunk.source_id === sourceId)).toBe(true);
    expect(result.agentMessageId).toBeTruthy();
    const answer = await db.query<{ body: string }>(
      "select body from messages where id = $1 and client_id = $2",
      [result.agentMessageId, clientId],
    );
    expect(answer.rows[0]?.body).toContain("10:00");
  });
});
