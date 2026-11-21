import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db";
import { encryptedChannelCredentialValues } from "@/lib/channels/credentials";
import { processInboundJob } from "@/lib/channels/inbox-worker";
import { flushRetryableOutboundMessages } from "@/lib/channels/outbox";
import { retrieveKnowledge } from "@/lib/knowledge/retrieve";
import { deterministicEmbedding } from "@/lib/llm/mock";
import { FakeChopeConnector } from "../fixtures/fake-chope";
import { createChopeBrowserConnector } from "@/lib/reservations/chope-browser";
import { POST as whatsappPost } from "@/app/api/webhooks/whatsapp/[channelId]/route";
import { POST as instagramPost } from "@/app/api/webhooks/instagram/[channelId]/route";
import { POST as messengerPost } from "@/app/api/webhooks/messenger/[channelId]/route";
import { PS_CAFE_CHOPE_OUTLET_ID, PS_CAFE_CHOPE_URL, PS_CAFE_DEMO_CLIENT_ID,
  PS_CAFE_DEMO_WHATSAPP_ID, PS_CAFE_DEMO_INSTAGRAM_ID, PS_CAFE_DEMO_MESSENGER_ID, psCafeDemoSources,
  removePsCafeDemo, setupPsCafeDemo } from "../../scripts/demo/ps-cafe-raffles-city";

// these tests drive workers explicitly; Next.js owns post-response callbacks in production.
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: vi.fn() }));

const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;
const secret = "ps-cafe-demo-fixture-secret";

dbDescribe("PS.Cafe Raffles City isolated end-to-end demo", () => {
  beforeEach(async () => {
    await removePsCafeDemo();
    await setupPsCafeDemo();
    for (const [channelId, kind, externalId] of [
      [PS_CAFE_DEMO_WHATSAPP_ID, "whatsapp", "ps-cafe-demo-phone"],
      [PS_CAFE_DEMO_INSTAGRAM_ID, "instagram", "ps-cafe-demo-ig"],
    ]) {
      const credentials = encryptedChannelCredentialValues({
        appSecret: secret, accessToken: "fixture-token", pageAccessToken: "fixture-token",
        phoneNumberId: "ps-cafe-demo-phone", igUserId: "ps-cafe-demo-ig",
        __settingsSecrets: { verifyToken: "fixture-verify" },
      });
      await getPool().query(`update channels set status = 'active', external_id = $2,
        credentials = $3, encrypted_credentials = $4, credentials_encryption_nonce = $5,
        credentials_encryption_tag = $6 where id = $1 and client_id = $7`,
        [channelId, externalId, credentials.credentials, credentials.encryptedCredentials,
          credentials.nonce, credentials.tag, PS_CAFE_DEMO_CLIENT_ID]);
      expect(kind).toMatch(/whatsapp|instagram/);
    }
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!String(url).startsWith("https://graph.facebook.com/")) throw new Error("Unexpected URL");
      return new Response(JSON.stringify({ messages: [{ id: "wamid.fixture-sent" }],
        message_id: "mid.fixture-sent" }), { status: 200,
        headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(async () => { await removePsCafeDemo(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => { await getPool().end(); });

  function signedRequest(kind: "whatsapp" | "instagram", payload: unknown) {
    const channelId = kind === "whatsapp" ? PS_CAFE_DEMO_WHATSAPP_ID : PS_CAFE_DEMO_INSTAGRAM_ID;
    const raw = JSON.stringify(payload);
    return new Request(`http://localhost:3000/api/webhooks/${kind}/${channelId}`, {
      method: "POST", body: raw,
      headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` },
    });
  }

  async function send(kind: "whatsapp" | "instagram", body: string, id: string = randomUUID()) {
    const payload = kind === "whatsapp"
      ? { object: "whatsapp_business_account", entry: [{ id: "waba-demo", changes: [{
          field: "messages", value: { metadata: { phone_number_id: "ps-cafe-demo-phone" },
            messages: [{ id, from: "6590000123", type: "text",
              timestamp: String(Math.floor(Date.now() / 1000)), text: { body } }] },
        }] }] }
      : { object: "instagram", entry: [{ id: "ps-cafe-demo-ig", messaging: [{
          sender: { id: "ig-demo-customer" }, recipient: { id: "ps-cafe-demo-ig" },
          timestamp: Date.now(), message: { mid: id, text: body },
        }] }] };
    const response = kind === "whatsapp"
      ? await whatsappPost(signedRequest(kind, payload), { params: Promise.resolve({ channelId: PS_CAFE_DEMO_WHATSAPP_ID }) })
      : await instagramPost(signedRequest(kind, payload), { params: Promise.resolve({ channelId: PS_CAFE_DEMO_INSTAGRAM_ID }) });
    const result = await response.json() as { accepted?: number; duplicates?: number };
    const row = await getPool().query<{ id: string }>(
      `select id from inbound_jobs where client_id = $1 and message_id in
        (select id from messages where client_id = $1 and external_message_id = $2)`,
      [PS_CAFE_DEMO_CLIENT_ID, id]);
    return { status: response.status, accepted: result.accepted,
      duplicates: result.duplicates, jobId: row.rows[0]?.id };
  }

  async function answer() {
    const row = await getPool().query<{ body: string; status: string }>(
      "select body, status from outbound_messages where client_id = $1 order by created_at desc limit 1",
      [PS_CAFE_DEMO_CLIENT_ID]);
    return row.rows[0];
  }

  it("A: WhatsApp hours question uses tenant knowledge and fake Graph transport", async () => {
    const inbound = await send("whatsapp", "What time do you close today?");
    expect(inbound).toMatchObject({ status: 200, accepted: 1 });
    expect(await processInboundJob({ jobId: inbound.jobId })).toMatchObject({ outcome: "answered" });
    expect((await answer()).body).toContain("10:00pm");
    await flushRetryableOutboundMessages();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/ps-cafe-demo-phone/messages"),
      expect.objectContaining({ method: "POST" }));
  });

  it("B: Instagram dietary question uses curated knowledge and fake Graph transport", async () => {
    const inbound = await send("instagram", "Do you have vegetarian options?");
    expect(inbound).toMatchObject({ status: 200, accepted: 1 });
    expect(await processInboundJob({ jobId: inbound.jobId })).toMatchObject({ outcome: "answered" });
    expect((await answer()).body.toLowerCase()).toContain("vegetarian");
    await flushRetryableOutboundMessages();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/ps-cafe-demo-ig/messages"),
      expect.objectContaining({ method: "POST" }));
  });

  it("B2: direct Instagram Login uses the shared inbox and Instagram Graph send endpoint", async () => {
    vi.stubEnv("PRONTO_INSTAGRAM_LOGIN_ENABLED", "1");
    const credentials = encryptedChannelCredentialValues({
      instagramAccessToken: "direct-ig-fixture", igUserId: "ps-cafe-demo-ig", appSecret: secret,
      tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      __settingsSecrets: { verifyToken: "fixture-verify" },
    });
    await getPool().query(`update channels set settings = '{"authMode":"instagram_login"}'::jsonb,
      encrypted_credentials = $2, credentials_encryption_nonce = $3,
      credentials_encryption_tag = $4 where id = $1`,
      [PS_CAFE_DEMO_INSTAGRAM_ID, credentials.encryptedCredentials, credentials.nonce, credentials.tag]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!String(url).startsWith("https://graph.instagram.com/")) throw new Error("Unexpected direct Instagram URL");
      return new Response(JSON.stringify({ message_id: "mid.direct-fixture" }), { status: 200 });
    }));
    const inbound = await send("instagram", "Do you have vegetarian options?");
    expect(await processInboundJob({ jobId: inbound.jobId })).toMatchObject({ outcome: "answered" });
    await flushRetryableOutboundMessages();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("graph.instagram.com/v25.0/ps-cafe-demo-ig/messages"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer direct-ig-fixture" }) }));
  });

  it("B3: Messenger Page fixture reuses the same durable RAG and outbox path", async () => {
    const credentials = encryptedChannelCredentialValues({ pageAccessToken: "page-fixture", pageId: "ps-cafe-demo-page",
      appSecret: secret, __settingsSecrets: { verifyToken: "fixture-verify" } });
    await getPool().query(`update channels set status = 'active', encrypted_credentials = $2,
      credentials_encryption_nonce = $3, credentials_encryption_tag = $4 where id = $1`,
      [PS_CAFE_DEMO_MESSENGER_ID, credentials.encryptedCredentials, credentials.nonce, credentials.tag]);
    const payload = { object: "page", entry: [{ id: "ps-cafe-demo-page", messaging: [{
      sender: { id: "messenger-demo-customer" }, recipient: { id: "ps-cafe-demo-page" },
      timestamp: Date.now(), message: { mid: randomUUID(), text: "What time do you close today?" },
    }] }] };
    const raw = JSON.stringify(payload);
    const route = (body: string) => messengerPost(new Request(`http://localhost:3000/api/webhooks/messenger/${PS_CAFE_DEMO_MESSENGER_ID}`,
      { method: "POST", body, headers: { "x-hub-signature-256":
        `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` } }),
      { params: Promise.resolve({ channelId: PS_CAFE_DEMO_MESSENGER_ID }) });
    expect((await route(raw)).status).toBe(200);
    expect((await route(raw)).status).toBe(200);
    const jobs = await getPool().query<{ id: string }>(
      "select id from inbound_jobs where client_id = $1 and channel_id = $2", [PS_CAFE_DEMO_CLIENT_ID, PS_CAFE_DEMO_MESSENGER_ID]);
    expect(jobs.rows).toHaveLength(1);
    expect(await processInboundJob({ jobId: jobs.rows[0].id })).toMatchObject({ outcome: "answered" });
    expect((await answer()).body).toContain("10:00pm");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(String(url)).not.toContain("access_token=");
      return new Response(JSON.stringify({ message_id: "mid.messenger-sent" }), { status: 200 });
    }));
    await flushRetryableOutboundMessages();
    const sent = await getPool().query<{ metadata: Record<string, unknown> }>(
      "select metadata from outbound_messages where client_id = $1 and channel_id = $2", [PS_CAFE_DEMO_CLIENT_ID, PS_CAFE_DEMO_MESSENGER_ID]);
    expect(sent.rows[0].metadata.providerMessageId).toBe("mid.messenger-sent");
  });

  it("C: fake available slot is provisional and never creates a reservation", async () => {
    const fake = new FakeChopeConnector(PS_CAFE_DEMO_CLIENT_ID, PS_CAFE_CHOPE_OUTLET_ID);
    const inbound = await send("whatsapp", "Do you have a table for two on 2099-10-12 at 7pm?");
    expect(await processInboundJob({ jobId: inbound.jobId, reservationConnector: fake }))
      .toMatchObject({ outcome: "answered" });
    expect((await answer()).body).toContain("A table appears available");
    expect((await answer()).body).toContain("This is not a booking");
    expect(fake.reservations.size).toBe(0);
  });

  it("C2: browser connector contract reaches the WhatsApp worker through an injected read", async () => {
    const singaporeToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore",
      year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const tomorrow = new Date(Date.parse(`${singaporeToday}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const reader = vi.fn(async () => ({ outletId: PS_CAFE_CHOPE_OUTLET_ID,
      date: tomorrow, partySize: 2, availableSlots: ["19:00"],
      timezone: "Asia/Singapore" as const, provider: "chope",
      observedAt: new Date().toISOString(), status: "available" as const }));
    const connector = createChopeBrowserConnector({ clientId: PS_CAFE_DEMO_CLIENT_ID,
      outletId: PS_CAFE_CHOPE_OUTLET_ID, listingUrl: PS_CAFE_CHOPE_URL,
      authorizedAt: "2026-10-11T00:00:00Z", scope: "demo_availability" }, reader);
    const inbound = await send("whatsapp", "Hi, can I reserve a table for two tomorrow around 7pm?");
    expect(await processInboundJob({ jobId: inbound.jobId, reservationConnector: connector }))
      .toMatchObject({ outcome: "answered" });
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ clientId: PS_CAFE_DEMO_CLIENT_ID,
      outletId: PS_CAFE_CHOPE_OUTLET_ID, date: tomorrow, partySize: 2, time: "19:00" }), expect.anything());
    expect((await answer()).body).toContain("A table appears available");
    expect((await answer()).body).toContain("This is not a booking");
  });

  it("D: fake unavailable slot is reported without claiming live availability", async () => {
    const fake = new FakeChopeConnector(PS_CAFE_DEMO_CLIENT_ID, PS_CAFE_CHOPE_OUTLET_ID);
    fake.availability = "unavailable";
    const inbound = await send("instagram", "Can I book a table for 2 on 2099-10-12 at 7pm?");
    expect(await processInboundJob({ jobId: inbound.jobId, reservationConnector: fake }))
      .toMatchObject({ outcome: "answered" });
    expect((await answer()).body).toContain("could not find availability");
    expect(fake.reservations.size).toBe(0);
  });

  it("E: production Chope capability is disabled and gives only the outlet link", async () => {
    const inbound = await send("whatsapp", "Can I book a table for 2 on 2099-10-12 at 7pm?");
    expect(await processInboundJob({ jobId: inbound.jobId })).toMatchObject({ outcome: "answered" });
    expect((await answer()).body).toContain(PS_CAFE_CHOPE_URL);
    expect((await answer()).body).toContain("I cannot confirm a reservation here");
  });

  it("F: unsupported content escalates and later messages remain human-owned", async () => {
    const payload = { object: "whatsapp_business_account", entry: [{ id: "waba-demo", changes: [{
      field: "messages", value: { metadata: { phone_number_id: "ps-cafe-demo-phone" },
        messages: [{ id: "wamid.ps-demo-image", from: "6590000123", type: "image",
          timestamp: String(Math.floor(Date.now() / 1000)), image: { id: "fixture-image" } }] },
    }] }] };
    expect((await whatsappPost(signedRequest("whatsapp", payload),
      { params: Promise.resolve({ channelId: PS_CAFE_DEMO_WHATSAPP_ID }) })).status).toBe(200);
    const first = await getPool().query<{ id: string }>(
      "select id from inbound_jobs where client_id = $1", [PS_CAFE_DEMO_CLIENT_ID]);
    expect(await processInboundJob({ jobId: first.rows[0].id })).toMatchObject({ outcome: "escalated" });
    const countBefore = await getPool().query<{ count: string }>(
      "select count(*) from outbound_messages where client_id = $1", [PS_CAFE_DEMO_CLIENT_ID]);
    const followup = await send("whatsapp", "Are you there?");
    expect(await processInboundJob({ jobId: followup.jobId })).toMatchObject({ outcome: "skipped" });
    const countAfter = await getPool().query<{ count: string }>(
      "select count(*) from outbound_messages where client_id = $1", [PS_CAFE_DEMO_CLIENT_ID]);
    expect(countAfter.rows[0].count).toBe(countBefore.rows[0].count);
  });

  it("G: RAG cannot read this tenant's facts as another tenant", async () => {
    const other = await retrieveKnowledge(randomUUID(), deterministicEmbedding("PS.Cafe Raffles City closes"),
      5, { queryText: "PS.Cafe Raffles City closes" });
    expect(other).toEqual([]);
    const own = await retrieveKnowledge(PS_CAFE_DEMO_CLIENT_ID,
      deterministicEmbedding("PS.Cafe Raffles City closes"), 5,
      { queryText: "PS.Cafe Raffles City closes" });
    expect(own.some((chunk) => chunk.content.includes("10:00pm"))).toBe(true);
  });

  it("H: duplicate inbound provider ID creates one durable job", async () => {
    const id = `wamid.${randomUUID()}`;
    const first = await send("whatsapp", "What time do you close today?", id);
    const second = await send("whatsapp", "What time do you close today?", id);
    expect(first.accepted).toBe(1);
    expect(second).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(second.jobId).toBe(first.jobId);
    expect(await processInboundJob({ jobId: first.jobId })).toMatchObject({ outcome: "answered" });
    const count = await getPool().query<{ count: string }>(
      "select count(*) from inbound_jobs where client_id = $1", [PS_CAFE_DEMO_CLIENT_ID]);
    expect(count.rows[0].count).toBe("1");
  });

  it("I: fake availability timeout degrades to booking link", async () => {
    const fake = new FakeChopeConnector(PS_CAFE_DEMO_CLIENT_ID, PS_CAFE_CHOPE_OUTLET_ID);
    fake.failure = "provider_timeout";
    const inbound = await send("whatsapp", "Can I book a table for 2 on 2099-10-12 at 7pm?");
    expect(await processInboundJob({ jobId: inbound.jobId, reservationConnector: fake }))
      .toMatchObject({ outcome: "answered" });
    expect((await answer()).body).toContain(PS_CAFE_CHOPE_URL);
    expect((await answer()).body).not.toContain("A table appears available");
  });

  it("J: conflicting cutoff is recorded for review and withheld from RAG text", async () => {
    const conflict = psCafeDemoSources.find((source) => source.reviewStatus === "policy_conflict_withheld");
    expect(conflict?.content).not.toMatch(/5[.:]30|6[.:]00/);
    const row = await getPool().query<{ metadata: { reviewStatus: string;
      conflictingClaims: { cutoff: string }[] }; content: string }>(
      "select metadata, content from knowledge_sources where id = $1 and client_id = $2",
      [conflict?.id, PS_CAFE_DEMO_CLIENT_ID]);
    expect(row.rows[0].metadata.reviewStatus).toBe("policy_conflict_withheld");
    expect(row.rows[0].metadata.conflictingClaims.map((claim) => claim.cutoff)).toEqual(["17:30", "18:00"]);
    expect(row.rows[0].content).toContain("under restaurant review");
    const inbound = await send("instagram", "When can I reserve on weekends?");
    expect(await processInboundJob({ jobId: inbound.jobId })).toMatchObject({ outcome: "escalated" });
    const outbound = await answer();
    expect(outbound.body).not.toMatch(/5[.:]30|6[.:]00/);
  });

  it("setup is idempotent and remains scoped to its marked demo tenant", async () => {
    await setupPsCafeDemo();
    const rows = await getPool().query<{ count: string }>(
      "select count(*) from knowledge_sources where client_id = $1", [PS_CAFE_DEMO_CLIENT_ID]);
    expect(rows.rows[0].count).toBe("3");
    const channels = await getPool().query<{ count: string }>(
      "select count(*) from channels where client_id = $1", [PS_CAFE_DEMO_CLIENT_ID]);
    expect(channels.rows[0].count).toBe("4");
  });
});
