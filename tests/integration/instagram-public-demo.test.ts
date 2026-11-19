// @vitest-environment node
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db";
import * as deployment from "@/lib/deployment-profile";
import { DEMO_CLIENT_ID } from "@/lib/customer-demo-boundary";
import { encryptedChannelCredentialValues } from "@/lib/channels/credentials";
import { POST } from "@/app/api/webhooks/instagram/[channelId]/route";
import { processDemoQueue } from "@/lib/demo-processing";
import { updateConversationAction } from "@/lib/conversation-actions";
import { getFilteredConversations } from "@/lib/reporting";
import { removePsCafeDemo, setupPsCafeDemo, PS_CAFE_DEMO_RESPONDER_ID } from "../../scripts/demo/ps-cafe-raffles-city";
import { setupCustomerSimulator } from "@/lib/customer-demo-setup";
import type { SessionUser } from "@/lib/auth";
const callbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: (run: () => Promise<void>) => callbacks.push(run) }));
const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;
const actor: SessionUser = { userId: PS_CAFE_DEMO_RESPONDER_ID, role: "client", clientId: DEMO_CLIENT_ID, name: "Fixture responder", email: "responder@ps-cafe-demo.test" };
dbDescribe("public demo Instagram transport with real isolated PostgreSQL and fake HTTP", () => {
  let channelId: string, handoff: boolean;
  const accountId = "10001", senderId = "20002", secret = "fixture-meta-secret";
  beforeEach(async () => {
    vi.stubEnv("PRONTO_CUSTOMER_DEMO_ENABLED", "1");vi.stubEnv("PRONTO_DEPLOYMENT_PROFILE", "");
    await removePsCafeDemo(); await setupPsCafeDemo(); await setupCustomerSimulator();
    channelId = randomUUID();handoff = false;callbacks.length = 0;
    for (const [key, value] of Object.entries({ PRONTO_DEPLOYMENT_PROFILE: "protected-demo", PRONTO_DEMO_PROCESSING_MODE: "request",
      PRONTO_DEMO_ONLY_DELIVERY: "1", PRONTO_DEMO_INSTAGRAM_ENABLED: "1", PRONTO_DEMO_INSTAGRAM_CHANNEL_ID: channelId,
      PRONTO_DEMO_INSTAGRAM_ACCOUNT_ID: accountId, PRONTO_DEMO_INSTAGRAM_SENDER_IDS: senderId,
      PRONTO_USE_MOCK_AI: "0", GROQ_API_KEY: "fixture-not-live", PRONTO_DEMO_REAL_AI_APPROVED: "1", PRONTO_GROQ_FREE_TIER_CONFIRMED: "1" })) vi.stubEnv(key, value);
    // Only the profile parser is substituted: database identity, tenant binding,
    // worker/model checks and real persistence still run on the marked fixture.
    vi.spyOn(deployment, "protectedDemoConfiguration").mockReturnValue({ databaseId: randomUUID(), marker: "pronto:isolated-test-database:v1",
      allowedUserIds: [actor.userId], database: new URL(process.env.DATABASE_URL!), origin: new URL("https://demo.invalid") });
    const e = encryptedChannelCredentialValues({ accessToken: "fixture-token", appSecret: secret, igUserId: accountId });
    await getPool().query(`insert into channels(id,client_id,kind,name,status,external_id,settings,credentials,
      encrypted_credentials,credentials_encryption_nonce,credentials_encryption_tag)
      values($1,$2,'instagram','Instagram test','active',$3,'{"authMode":"unified_login"}','{}',$4,$5,$6)`,
    [channelId, DEMO_CLIENT_ID, accountId, e.encryptedCredentials, e.nonce, e.tag]);
    vi.stubGlobal("fetch", vi.fn(async (resource: string | URL | Request, options?: RequestInit) => {
      const target = resource instanceof Request ? resource.url : String(resource);
      if (target.startsWith("https://api.groq.com/")) {
        const body = resource instanceof Request ? await resource.json() : JSON.parse(String(options?.body));
        const chunkId = JSON.stringify(body.messages).match(/chunk_id=\\?"([^"\\]+)/)?.[1];
        return new Response(JSON.stringify({ id: "fixture-groq", model: "openai/gpt-oss-20b", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
          action: handoff ? "escalate" : "answer", answer: handoff ? "Our team will review your refund enquiry." : "PS.Cafe Raffles City closes at 10:00pm daily.",
          confidence: 0.99, reasonCode: handoff ? "complaint_or_refund" : "grounded_answer", reasonDetail: "Explicit fake provider fixture.", citedChunkIds: handoff ? [] : [chunkId],
        }) } }], usage: { prompt_tokens: 100, completion_tokens: 30 } }), { headers: { "Content-Type": "application/json" } });
      }
      if (target.startsWith("https://graph.facebook.com/") && target.endsWith("/messages"))
        return new Response(JSON.stringify({ message_id: "fixture-outgoing" }));
      throw new Error("Unexpected fixture network request");
    }));
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();callbacks.length = 0;await removePsCafeDemo(); });
  afterAll(async () => { await getPool().end(); });
  const request = (id = "fixture-incoming", sender = senderId, text = "What time do you close today?") => {
    const raw = JSON.stringify({ object: "instagram", entry: [{ id: accountId, messaging: [{ sender: { id: sender }, recipient: { id: accountId },
      timestamp: Date.now(), message: { mid: id, text } }] }] });
    return new Request("http://localhost/webhook", { method: "POST", body: raw,
      headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(raw).digest("hex") } });
  };
  const context = () => ({ params: Promise.resolve({ channelId }) });
  it("acks duplicates before inference, then delivers one grounded reply in the existing public inbox", async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => POST(request(), context())));
    expect(responses.every(r => r.status === 200)).toBe(true);expect(fetch).not.toHaveBeenCalled();
    await Promise.all(callbacks.splice(0).map(run => run()));
    const rows = (await getPool().query("select body,metadata from messages where client_id=$1 and channel_id=$2 and sender_role='agent'", [DEMO_CLIENT_ID, channelId])).rows;
    expect(rows).toHaveLength(1);expect(rows[0].metadata).toMatchObject({ generationMode: "real", responseProvider: "groq", retrievalMode: "local_text" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await getPool().query("select status from outbound_messages where client_id=$1 and channel_id=$2", [DEMO_CLIENT_ID, channelId])).rows).toEqual([{ status: "sent" }]);
    expect((await getFilteredConversations({ clientId: DEMO_CLIENT_ID })).some(c => c.channel_kind === "instagram")).toBe(true);
  });
  it("resumes saved Instagram jobs through the same browser processing request", async () => {
    expect((await POST(request(), context())).status).toBe(200);callbacks.length = 0;
    expect(await processDemoQueue(actor)).toMatchObject({ processed: 1, delivered: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await POST(request("other", "99999"), context())).status).toBe(403);
    expect((await getPool().query("select id from inbound_jobs where client_id=$1 and channel_id=$2", [DEMO_CLIENT_ID, channelId])).rowCount).toBe(1);
  });
  it("routes a complaint for staff review and preserves takeover when the tester sends another question", async () => {
    handoff = true;expect((await POST(request("refund", senderId, "I want a refund for my order."), context())).status).toBe(200);
    await Promise.all(callbacks.splice(0).map(run => run()));
    const escalation = (await getPool().query(`select e.id,e.conversation_id from escalations e
      join conversations c on c.id=e.conversation_id and c.client_id=e.client_id where e.client_id=$1 and c.channel_id=$2`, [DEMO_CLIENT_ID, channelId])).rows[0];
    expect(escalation).toBeDefined();
    const reply = (await getPool().query("select body from outbound_messages where client_id=$1 and channel_id=$2", [DEMO_CLIENT_ID, channelId])).rows[0];
    expect(reply.body).toContain("Our team will review");
    await updateConversationAction({ actor, clientId: DEMO_CLIENT_ID, conversationId: escalation.conversation_id, action: "takeover" });
    const calls = vi.mocked(fetch).mock.calls.length;
    expect((await POST(request("after-takeover"), context())).status).toBe(200);
    await Promise.all(callbacks.splice(0).map(run => run()));
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
});
