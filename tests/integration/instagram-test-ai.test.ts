// @vitest-environment node
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db";
import { encryptedChannelCredentialValues } from "@/lib/channels/credentials";
import { getAssistantDraft, publishAssistantDraft, stageAgentConfig } from "@/lib/assistant-drafts";
import { submitKnowledgeSource, reviewSourceSubmission, stageApprovedSourceSubmission } from "@/lib/knowledge/submissions";
import { approveConfiguration, channelEvidenceKinds, recordChannelActivationEvidence } from "@/lib/managed-approvals";
import { activateCustomerChannel } from "@/lib/channel-activation";
import { changeOnboardingStage } from "@/lib/onboarding";
import { POST } from "@/app/api/webhooks/instagram/[channelId]/route";
import { processInboundJob } from "@/lib/channels/inbox-worker";
import { flushOutboundMessage } from "@/lib/channels/outbox";
import { verifyTestDatabase } from "../../scripts/test-db-safety";
import type { SessionUser } from "@/lib/auth";

// these tests drive workers explicitly; Next.js owns post-response callbacks in production.
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: vi.fn() }));

const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;
dbDescribe("scoped Instagram AI using fake HTTP and real disposable PostgreSQL", () => {
  let clientId: string, channelId: string, operator: SessionUser, approver: SessionUser;
  let chunkId: string;
  const secret = "fixture-meta-secret", accountId = "10001", senderId = "20002";
  const content = "Fixture Cafe closes at 10:00pm daily.";
  beforeEach(async () => {
    await verifyTestDatabase();
    await getPool().query("comment on database pronto_test is 'pronto:instagram-hosted:v1:00000000-0000-4000-8000-000000000001'");
    clientId = randomUUID(); channelId = randomUUID();
    operator = { userId: randomUUID(), clientId: null, role: "operator", name: "Fixture operator", email: randomUUID() + "@fixture.invalid" };
    approver = { userId: randomUUID(), clientId, role: "client", name: "Fixture approver", email: randomUUID() + "@fixture.invalid" };
    for (const [key, value] of Object.entries({ PRONTO_HOSTED_INSTAGRAM_AI: "1", PRONTO_HOSTED_INSTAGRAM: "1",
      PRONTO_DEPLOYMENT_PROFILE: "standard", PRONTO_USE_MOCK_AI: "0", PRONTO_CUSTOMER_DEMO_ENABLED: "0", PRONTO_DEMO_ONLY_DELIVERY: "0",
      PRONTO_HOSTED_INSTAGRAM_CLIENT_ID: clientId, PRONTO_HOSTED_INSTAGRAM_CHANNEL_ID: channelId,
      PRONTO_HOSTED_INSTAGRAM_ACCOUNT_ID: accountId, PRONTO_HOSTED_INSTAGRAM_SENDER_IDS: senderId,
      PRONTO_HOSTED_INSTAGRAM_DATABASE_MARKER: "pronto:instagram-hosted:v1:00000000-0000-4000-8000-000000000001",
      GROQ_API_KEY: "fixture-not-live", PRONTO_GROQ_FREE_TIER_CONFIRMED: "1", PRONTO_DEMO_REAL_AI_APPROVED: "0",
      OPENAI_API_KEY: "", GEMINI_API_KEY: "", AZURE_OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" })) vi.stubEnv(key, value);
    await getPool().query("insert into clients(id,name,slug,vertical,brand_voice,business_profile) values($1,'Fixture Cafe',$2,'fnb','Clear','{\"timezone\":\"Asia/Singapore\"}')", [clientId, clientId]);
    for (const actor of [operator, approver]) await getPool().query(
      "insert into users(id,client_id,email,name,role,password_hash) values($1,$2,$3,$4,$5,'unused')",
      [actor.userId, actor.clientId, actor.email, actor.name, actor.role]);
    for (const permission of ["knowledge.approve", "channel.activate"])
      await getPool().query("insert into staff_permission_grants(client_id,user_id,permission) values($1,$2,$3)", [clientId, approver.userId, permission]);
    const encrypted = encryptedChannelCredentialValues({ accessToken: "fixture-token", appSecret: secret, igUserId: accountId });
    await getPool().query(`insert into channels(id,client_id,kind,name,status,external_id,settings,credentials,
      encrypted_credentials,credentials_encryption_nonce,credentials_encryption_tag,last_health_status,last_health_check_at)
      values($1,$2,'instagram','Fixture','draft',$3,'{"authMode":"unified_login"}','{}',$4,$5,$6,'healthy',now())`,
    [channelId, clientId, accountId, encrypted.encryptedCredentials, encrypted.nonce, encrypted.tag]);
    await getPool().query("insert into agent_configs(client_id,prompt_preamble) values($1,'Answer from approved knowledge')", [clientId]);
    await getPool().query("insert into instagram_test_knowledge_scopes(client_id,channel_id,database_marker) values($1,$2,$3)",
      [clientId, channelId, process.env.PRONTO_HOSTED_INSTAGRAM_DATABASE_MARKER]);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const target = url instanceof Request ? url.url : String(url);
      if (target.startsWith("https://api.groq.com/")) return new Response(JSON.stringify({ id: "fixture-inference", model: "openai/gpt-oss-20b",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ action: "answer", answer: content, confidence: 0.99,
          reasonCode: "grounded_answer", reasonDetail: "Explicit fixture inference, not real provider acceptance.", citedChunkIds: [chunkId] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 30 } }), { headers: { "Content-Type": "application/json" } });
      if (target === "https://graph.facebook.com/v25.0/" + accountId + "/messages")
        return new Response(JSON.stringify({ message_id: "fixture-delivery" }));
      throw new Error("Unexpected fixture network request");
    }));
  });
  afterEach(async () => {
    await getPool().query("comment on database pronto_test is 'pronto:isolated-test-database:v1'");
    await getPool().query("delete from clients where id=$1", [clientId]);
    await getPool().query("delete from users where id=$1", [operator.userId]);
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  afterAll(async () => { await getPool().end(); });
  async function prepare() {
    const source = await submitKnowledgeSource({ actor: operator, clientId, sourceType: "text", title: "Fixture closing hours", content });
    await expect(stageApprovedSourceSubmission({ actor: operator, clientId, submissionId: source.id, expectedRevision: 1 })).rejects.toThrow(/business approval/);
    await reviewSourceSubmission({ actor: approver, clientId, submissionId: source.id, expectedRevision: 1, decision: "approve", note: "Reviewed fixture fact." });
    await stageApprovedSourceSubmission({ actor: operator, clientId, submissionId: source.id, expectedRevision: 1 });
    await stageAgentConfig({ clientId, actorUserId: operator.userId, responseProvider: "groq", responseModel: "openai/gpt-oss-20b",
      embeddingProvider: "none", embeddingModel: "none", retrievalThreshold: 0, promptPreamble: "Answer only from approved fixture knowledge.",
      escalationRules: {}, changeReason: "Fixture test" });
    await expect(publishAssistantDraft(clientId, operator.userId)).rejects.toThrow(/business approval/);
    const revision = String((await getAssistantDraft(clientId))!.edit_version);
    await approveConfiguration({ actor: approver, clientId, kind: "assistant", targetId: clientId, revision, evidence: "Reviewed exact fixture assistant." });
    await publishAssistantDraft(clientId, operator.userId);
    chunkId = (await getPool().query("select id from knowledge_chunks where client_id=$1", [clientId])).rows[0].id;
    const stages = { profile: { details: { businessName: "Fixture Cafe", timezone: "Asia/Singapore", serviceScope: "Fixture facts" }, evidence: { sourceReview: "Fixture reviewed" } },
      communications: { details: { customerChannels: "Instagram fixture", staffPreference: "Inbox" }, evidence: { identityReview: "Fixture identity" } },
      knowledge: { details: { knowledgeScope: "Fixture hours", escalationRules: "Staff handles unsupported enquiries" }, evidence: { sourceReview: "Fixture reviewed" } },
      testing: { details: { testPlan: "Fixture tests only" }, evidence: { localTest: "Fake transport", handoffTest: "Fixture transport evidence only" } } };
    for (const stage of Object.keys(stages) as Array<keyof typeof stages>) {
      await getPool().query("insert into onboarding_stages(client_id,stage) values($1,$2)", [clientId, stage]);
      const submitted = await changeOnboardingStage({ actor: operator, clientId, stage, action: "submit", expectedRevision: 1, ...stages[stage] });
      await changeOnboardingStage({ actor: approver, clientId, stage, action: "approve", expectedRevision: submitted.revision });
    }
    const channelRevision = (await getPool().query("select updated_at from channels where id=$1 and client_id=$2", [channelId, clientId])).rows[0].updated_at.toISOString();
    for (const checkKind of channelEvidenceKinds) await recordChannelActivationEvidence({ actor: operator, clientId, channelId, revision: channelRevision,
      checkKind, details: "Explicit disposable fixture evidence; not real provider/delivery acceptance." });
    await approveConfiguration({ actor: approver, clientId, kind: "channel", targetId: channelId, revision: channelRevision, evidence: "Fixture channel reviewed" });
    await activateCustomerChannel({ actor: operator, clientId, channelId, revision: channelRevision });
  }
  function incoming(sender = senderId) {
    const raw = JSON.stringify({ object: "instagram", entry: [{ id: accountId, messaging: [{ sender: { id: sender }, recipient: { id: accountId },
      timestamp: Date.now(), message: { mid: "fixture-inbound", text: "What time do you close?" } }] }] });
    return POST(new Request("http://localhost/webhook", { method: "POST", body: raw,
      headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(raw).digest("hex") } }), { params: Promise.resolve({ channelId }) });
  }
  it("retains all approval gates and runs signed DM → approved text → Groq HTTP → Meta HTTP without embeddings", async () => {
    expect((await incoming()).status).toBe(403);
    await prepare();
    expect(fetch).not.toHaveBeenCalled();
    expect((await incoming()).status).toBe(200);
    const job = (await getPool().query("select id from inbound_jobs where client_id=$1", [clientId])).rows[0];
    expect(await processInboundJob({ jobId: job.id })).toMatchObject({ outcome: "answered" });
    const reply = (await getPool().query("select body,metadata from messages where client_id=$1 and sender_role='agent'", [clientId])).rows[0];
    expect(reply).toMatchObject({ body: content, metadata: { generationMode: "real", responseProvider: "groq", retrievalMode: "local_text" } });
    const outbox = (await getPool().query("select id from outbound_messages where client_id=$1", [clientId])).rows[0];
    expect((await flushOutboundMessage(outbox.id, { clientId })).status).toBe("sent");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await getPool().query("select operation from agent_usage_events where client_id=$1", [clientId])).rows).toEqual([{ operation: "generation" }]);
  });
  it("rejects another sender before ingestion and rechecks the allowlist at worker and delivery time", async () => {
    await prepare();
    expect((await incoming("99999")).status).toBe(403);
    expect((await getPool().query("select id from inbound_jobs where client_id=$1", [clientId])).rowCount).toBe(0);
    expect((await incoming()).status).toBe(200);
    const job = (await getPool().query("select id from inbound_jobs where client_id=$1", [clientId])).rows[0];
    vi.stubEnv("PRONTO_HOSTED_INSTAGRAM_SENDER_IDS", "99999");
    await expect(processInboundJob({ jobId: job.id })).rejects.toThrow(/allowlisted tester/);
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("PRONTO_HOSTED_INSTAGRAM_SENDER_IDS", senderId);
    await getPool().query("update inbound_jobs set status='pending',available_at=now() where id=$1 and client_id=$2", [job.id, clientId]);
    expect(await processInboundJob({ jobId: job.id })).toMatchObject({ outcome: "answered" });
    vi.stubEnv("PRONTO_HOSTED_INSTAGRAM_SENDER_IDS", "99999");
    const outbox = (await getPool().query("select id from outbound_messages where client_id=$1", [clientId])).rows[0];
    expect((await flushOutboundMessage(outbox.id, { clientId })).status).not.toBe("sent");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains database validation for malformed, unenrolled or wrong-database text chunks", async () => {
    await prepare();
    const sourceId = (await getPool().query("select source_id from knowledge_chunks where client_id=$1", [clientId])).rows[0].source_id;
    const metadata = { retrievalMode: "local_text", retrievalProfile: "postgres-fts-simple-v1", retrievalScope: "instagram_hosted_test" };
    const insert = (value: unknown, dimensions = 0) => getPool().query(`insert into knowledge_chunks
      (source_id,client_id,chunk_index,content,token_estimate,embedding,embedding_model,embedding_dimensions,metadata)
      values($1,$2,99,'Invalid fixture chunk',5,null,'none',$3,$4)`, [sourceId, clientId, dimensions, value]);
    await expect(insert({ ...metadata, retrievalScope: "wrong" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert(metadata, 1)).rejects.toMatchObject({ code: "23514" });
    await getPool().query("comment on database pronto_test is 'pronto:instagram-hosted:v1:00000000-0000-4000-8000-000000000002'");
    await expect(insert(metadata)).rejects.toMatchObject({ code: "23514" });
    await getPool().query("comment on database pronto_test is 'pronto:instagram-hosted:v1:00000000-0000-4000-8000-000000000001'");
    await getPool().query("delete from instagram_test_knowledge_scopes where client_id=$1", [clientId]);
    await expect(insert(metadata)).rejects.toMatchObject({ code: "23514" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
