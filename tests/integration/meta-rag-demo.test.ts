import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool, vectorLiteral } from "@/lib/db";
import { decryptChannelCredentials, encryptedChannelCredentialValues } from "@/lib/channels/credentials";
import { prepareInstagramSetup } from "@/lib/channels/instagram-setup";
import type { Channel } from "@/lib/types";
import { processInboundJob } from "@/lib/channels/inbox-worker";
import { flushRetryableOutboundMessages } from "@/lib/channels/outbox";
import { deterministicEmbedding } from "@/lib/llm/mock";
import { POST as whatsAppPost } from "@/app/api/webhooks/whatsapp/[channelId]/route";
import { GET as instagramGet, POST as instagramPost } from "@/app/api/webhooks/instagram/[channelId]/route";
import { POST as saveOperatorChannel } from "@/app/api/operator/channels/route";

const auth = vi.hoisted(() => ({ actor: { userId: "", email: "fixture@operator.invalid", name: "Fixture operator",
  role: "operator" as const, clientId: null } }));
vi.mock("@/lib/auth", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/auth")>(),
  requireUser: vi.fn(async () => auth.actor) }));

// these tests drive workers explicitly; Next.js owns post-response callbacks in production.
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: vi.fn() }));

const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;

dbDescribe("mock-verified Meta webhook to RAG to outbound queue demonstrations", () => {
  let clientId: string;
  let channelId: string;
  let kind: "whatsapp" | "instagram";
  let sourceId: string;
  const secret = "fixture-meta-app-secret";

  beforeEach(async () => {
    clientId = randomUUID(); channelId = randomUUID(); sourceId = randomUUID();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!String(url).startsWith("https://graph.facebook.com/")) throw new Error("Unexpected external URL");
      return new Response(JSON.stringify(kind === "whatsapp"
        ? { messages: [{ id: "wamid.fixture-outbound" }] }
        : { message_id: "mid.fixture-outbound" }), { status: 200,
          headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(async () => {
    await getPool().query("delete from clients where id = $1", [clientId]);
    vi.unstubAllGlobals();
  });
  afterAll(async () => { await getPool().end(); });

  async function setup(input: { channelKind: "whatsapp" | "instagram"; question: string; knowledge: string;
    authMode?: "facebook_login" | "unified_login" }) {
    kind = input.channelKind;
    const db = getPool();
    await db.query("insert into clients (id, name, slug, vertical, brand_voice) values ($1, 'Fixture Cafe', $2, 'fnb', 'Warm and brief')",
      [clientId, `s1-meta-${clientId}`]);
    const credentials = encryptedChannelCredentialValues({
      appSecret: secret, accessToken: "fixture-token",
      ...(input.authMode === "unified_login" ? {} : { pageAccessToken: "fixture-token" }),
      phoneNumberId: "phone-a", igUserId: "ig-business-a",
      __settingsSecrets: { verifyToken: "fixture-verify" },
    });
    await db.query(
      `insert into channels (id, client_id, kind, name, status, external_id, credentials,
       encrypted_credentials, credentials_encryption_nonce, credentials_encryption_tag, settings)
       values ($1, $2, $3, 'Fixture channel', 'active', $4, $5, $6, $7, $8, $9::jsonb)`,
      [channelId, clientId, kind, kind === "whatsapp" ? "phone-a" : "ig-business-a",
        credentials.credentials, credentials.encryptedCredentials, credentials.nonce, credentials.tag,
        JSON.stringify(input.authMode ? { authMode: input.authMode } : {})],
    );
    await db.query(
      `insert into agent_configs (client_id, prompt_preamble, retrieval_threshold)
       values ($1, 'Answer only from this tenant knowledge.', 0)`, [clientId],
    );
    await db.query(
      "insert into knowledge_sources (id, client_id, title, source_type, content) values ($1, $2, 'Fixture knowledge', 'manual', $3)",
      [sourceId, clientId, input.knowledge],
    );
    await db.query(
      `insert into knowledge_chunks (source_id, client_id, chunk_index, content, token_estimate,
       embedding, embedding_model, embedding_dimensions) values
       ($1, $2, 0, $3, 20, $4::vector, 'text-embedding-3-small', 1536)`,
      [sourceId, clientId, input.knowledge, vectorLiteral(deterministicEmbedding(input.question))],
    );
  }

  function request(payload: unknown) {
    const raw = JSON.stringify(payload);
    const signature = createHmac("sha256", secret).update(raw).digest("hex");
    return new Request(`http://localhost:3000/api/webhooks/${kind}/${channelId}`, {
      method: "POST", headers: { "x-hub-signature-256": `sha256=${signature}` }, body: raw,
    });
  }

  it("WhatsApp FAQ uses tenant hours and a fake Graph transport", async () => {
    const question = "What time do you close today?";
    await setup({ channelKind: "whatsapp", question,
      knowledge: "Fixture Cafe closes today at 9:00 PM Singapore time." });
    const payload = { object: "whatsapp_business_account", entry: [{ id: "waba-a", changes: [{
      field: "messages", value: { metadata: { phone_number_id: "phone-a" },
        messages: [{ id: "wamid.fixture-inbound", from: "6590000000", type: "text",
          timestamp: String(Math.floor(Date.now() / 1000)),
          text: { body: question } }] },
    }] }] };
    const response = await whatsAppPost(request(payload), { params: Promise.resolve({ channelId }) });
    expect(response.status).toBe(200);
    expect((await response.json()).accepted).toBe(1);
    expect((await getPool().query("select id from outbound_messages where client_id = $1", [clientId])).rows).toHaveLength(0);
    expect((await processInboundJob())?.outcome).toBe("answered");
    const queued = await getPool().query<{ body: string; status: string }>(
      "select body, status from outbound_messages where client_id = $1", [clientId]);
    expect(queued.rows[0]).toMatchObject({ status: "pending" });
    expect(queued.rows[0].body).toContain("9:00 PM");
    await flushRetryableOutboundMessages();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/phone-a/messages"),
      expect.objectContaining({ method: "POST" }));
  });

  it.each(["facebook_login", "unified_login"] as const)("Instagram %s enquiry uses tenant dietary knowledge and a fake Graph transport", async authMode => {
    const question = "Do you have vegetarian options?";
    await setup({ channelKind: "instagram", question,
      knowledge: "Fixture Cafe has vegetarian noodles and tofu rice bowls.", authMode });
    const payload = { object: "instagram", entry: [{ id: "ig-business-a", messaging: [{
      sender: { id: "ig-customer-a" }, recipient: { id: "ig-business-a" },
      timestamp: Date.now(),
      message: { mid: "mid.fixture-inbound", text: question },
    }] }] };
    const response = await instagramPost(request(payload), { params: Promise.resolve({ channelId }) });
    expect(response.status).toBe(200);
    expect((await response.json()).accepted).toBe(1);
    expect((await processInboundJob())?.outcome).toBe("answered");
    const queued = await getPool().query<{ body: string; status: string }>(
      "select body, status from outbound_messages where client_id = $1", [clientId]);
    expect(queued.rows[0].body).toContain("vegetarian noodles");
    await flushRetryableOutboundMessages();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/ig-business-a/messages"),
      expect.objectContaining({ method: "POST" }));
  });

  it("deduplicates Unified Login deliveries and skips AI work after human takeover", async () => {
    await setup({ channelKind: "instagram", question: "What time do you close?",
      knowledge: "Fixture Cafe closes at 9:00 PM daily.", authMode: "unified_login" });
    const payload = (id: string) => ({ object: "instagram", entry: [{ id: "ig-business-a", messaging: [{
      sender: { id: "ig-customer-a" }, recipient: { id: "ig-business-a" }, timestamp: Date.now(),
      message: { mid: id, text: "What time do you close?" },
    }] }] });
    const context = { params: Promise.resolve({ channelId }) };
    expect((await (await instagramPost(request(payload("mid.unified-once")), context)).json()).duplicates).toBe(0);
    expect((await (await instagramPost(request(payload("mid.unified-once")), context)).json()).duplicates).toBe(1);
    expect((await processInboundJob({ channelId, clientId }))?.outcome).toBe("answered");
    expect(await processInboundJob({ channelId, clientId })).toBeNull();
    await flushRetryableOutboundMessages({ clientId });
    expect(fetch).toHaveBeenCalledTimes(1);
    const conversation = await getPool().query<{ id: string }>("select id from conversations where client_id=$1 and channel_id=$2", [clientId, channelId]);
    await getPool().query("update conversations set status='escalated' where id=$1 and client_id=$2", [conversation.rows[0].id, clientId]);
    expect((await instagramPost(request(payload("mid.human-owned")), context)).status).toBe(200);
    expect((await processInboundJob({ channelId, clientId }))?.outcome).toBe("skipped");
    await flushRetryableOutboundMessages({ clientId });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await getPool().query("select id from outbound_messages where client_id=$1", [clientId])).rowCount).toBe(1);
  });

  it("saves generated private setup through the operator endpoint and verifies the inactive callback without queuing work", async () => {
    await setup({ channelKind: "instagram", question: "Hours?", knowledge: "Fixture Cafe closes at 9:00 PM.", authMode: "unified_login" });
    await getPool().query("update channels set status='draft' where id=$1 and client_id=$2", [channelId, clientId]);
    auth.actor.userId = randomUUID();
    await getPool().query(`insert into users (id,client_id,email,name,role,password_hash)
      values($1,$2,$3,'Fixture operator','operator','no-interactive-login')`, [auth.actor.userId, clientId, `${auth.actor.userId}@operator.invalid`]);
    const prepared = await prepareInstagramSetup({ PRONTO_INSTAGRAM_TEST_ACCOUNT_ID: "12345",
      PRONTO_INSTAGRAM_TEST_APP_ID: "67890", PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN: "private-env-token",
      PRONTO_INSTAGRAM_TEST_APP_SECRET: secret }, { clientId, channelId, callbackOrigin: "https://callback.example" });
    const body = new FormData();
    for (const [key, value] of Object.entries(prepared.form)) body.set(key, value);
    const response = await saveOperatorChannel(new Request("http://localhost:3000/api/operator/channels", {
      method: "POST", headers: { origin: "http://localhost:3000" }, body,
    }));
    expect(response.status).toBe(200);
    const stored = (await getPool().query<Channel>("select * from channels where id=$1 and client_id=$2", [channelId, clientId])).rows[0];
    expect(stored.status).toBe("draft"); expect(stored.credentials).toEqual({});
    expect(stored.settings).toEqual({ authMode: "unified_login" });
    expect(stored.encrypted_credentials).not.toContain("private-env-token");
    const decrypted = decryptChannelCredentials(stored);
    expect(decrypted.credentials.accessToken).toBe("private-env-token");
    expect(decrypted.settings.verifyToken).toBe(prepared.connection.verifyToken);
    const callback = new URL(prepared.connection.callbackUrl);
    callback.searchParams.set("hub.mode", "subscribe"); callback.searchParams.set("hub.challenge", "setup-challenge");
    callback.searchParams.set("hub.verify_token", prepared.connection.verifyToken);
    const context = { params: Promise.resolve({ channelId }) };
    const verified = await instagramGet(new Request(callback), context);
    expect(verified.status).toBe(200); expect(await verified.text()).toBe("setup-challenge");
    expect((await instagramPost(request({ object: "instagram", entry: [] }), context)).status).toBe(403);
    expect((await getPool().query("select id from inbound_jobs where client_id=$1", [clientId])).rowCount).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("booking intent uses only the verified Chope link and never claims a booking", async () => {
    const question = "Can I book a table for 2 on 2099-10-12 at 7pm?";
    await setup({ channelKind: "whatsapp", question, knowledge: "Reservations are handled on Chope." });
    await getPool().query(
      "update clients set business_profile = $2::jsonb where id = $1",
      [clientId, JSON.stringify({ chopeBooking: { outletId: "fixture-cafe",
        url: "https://www.chope.co/singapore-restaurants/fixture-cafe",
        verifiedAt: "2026-10-11T00:00:00Z" } })],
    );
    const payload = { object: "whatsapp_business_account", entry: [{ id: "waba-a", changes: [{
      field: "messages", value: { metadata: { phone_number_id: "phone-a" },
        messages: [{ id: "wamid.booking-inbound", from: "6590000000", type: "text",
          timestamp: String(Math.floor(Date.now() / 1000)),
          text: { body: question } }] },
    }] }] };
    expect((await whatsAppPost(request(payload), { params: Promise.resolve({ channelId }) })).status).toBe(200);
    expect((await processInboundJob())?.outcome).toBe("answered");
    const queued = await getPool().query<{ body: string }>(
      "select body from outbound_messages where client_id = $1", [clientId]);
    expect(queued.rows[0].body).toContain("https://www.chope.co/singapore-restaurants/fixture-cafe");
    expect(queued.rows[0].body).toContain("I cannot confirm a reservation here");
    expect((await getPool().query("select id from escalations where client_id = $1", [clientId])).rows).toHaveLength(0);
  });

  it("hands unsupported WhatsApp content to a human and suppresses later AI work", async () => {
    await setup({ channelKind: "whatsapp", question: "Can you help?",
      knowledge: "Fixture Cafe can help with menu enquiries." });
    const message = (id: string, content: Record<string, unknown>) => ({
      object: "whatsapp_business_account", entry: [{ id: "waba-a", changes: [{
        field: "messages", value: { metadata: { phone_number_id: "phone-a" },
          messages: [{ id, from: "6590000000", timestamp: String(Math.floor(Date.now() / 1000)),
            ...content }] },
      }] }],
    });
    const image = message("wamid.media", { type: "image", image: { id: "fixture-image" } });
    expect((await whatsAppPost(request(image), { params: Promise.resolve({ channelId }) })).status).toBe(200);
    expect((await processInboundJob())?.outcome).toBe("escalated");
    const escalation = await getPool().query<{ status: string }>(
      "select status from escalations where client_id = $1", [clientId]);
    expect(escalation.rows).toHaveLength(1);
    expect(escalation.rows[0].status).toBe("open");
    await flushRetryableOutboundMessages();
    expect(fetch).toHaveBeenCalledTimes(1);

    const followup = message("wamid.after-handoff", { type: "text", text: { body: "Are you there?" } });
    expect((await whatsAppPost(request(followup), { params: Promise.resolve({ channelId }) })).status).toBe(200);
    expect((await processInboundJob())?.outcome).toBe("skipped");
    expect((await getPool().query("select id from outbound_messages where client_id = $1", [clientId])).rows).toHaveLength(1);
  });
});
