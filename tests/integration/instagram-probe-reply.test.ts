import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db";
import { recordAuditLog } from "@/lib/audit";
import * as audit from "@/lib/audit";
import { encryptedChannelCredentialValues } from "@/lib/channels/credentials";
import { instagramProbeReplyText, runInstagramProbeReply } from "@/lib/channels/instagram-probe-reply";
import { verifyTestDatabase } from "../../scripts/test-db-safety";

const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;
dbDescribe("operator-only Instagram probe reply", () => {
  const databaseMarker = "pronto:instagram-hosted:v1:00000000-0000-4000-8000-000000000001";
  const accountId = "10001", senderId = "20002";
  let plan: { clientId: string; channelId: string; probeId: string; receiptId: string;
    accountId: string; databaseMarker: string; expectedUsername: string };
  let postCount: number;
  beforeEach(async () => {
    await verifyTestDatabase();
    // Only the harness-created disposable database is temporarily marked as the
    // fixture's hosted target; restore its isolation marker after every test.
    await getPool().query("comment on database pronto_test is 'pronto:instagram-hosted:v1:00000000-0000-4000-8000-000000000001'");
    for (const [key, value] of Object.entries({ PRONTO_HOSTED_INSTAGRAM: "1", PRONTO_DEPLOYMENT_PROFILE: "standard",
      PRONTO_HOSTED_INSTAGRAM_WORKER: "0", PRONTO_META_PROBE_REPLY_APPROVED: "1" })) vi.stubEnv(key, value);
    plan = { clientId: randomUUID(), channelId: randomUUID(), probeId: randomUUID(), receiptId: randomUUID(),
      accountId, databaseMarker, expectedUsername: "fixture_customer" };
    await getPool().query("insert into clients(id,name,slug,vertical,brand_voice) values($1,'Fixture',$2,'general','Clear')", [plan.clientId, plan.clientId]);
    const credentials = encryptedChannelCredentialValues({ accessToken: "fixture-token", igUserId: accountId, appSecret: "fixture-secret" });
    const nonceHash = createHash("sha256").update("pronto-test " + "a".repeat(32)).digest("hex");
    await getPool().query(`insert into channels(id,client_id,kind,name,status,external_id,settings,credentials,
      encrypted_credentials,credentials_encryption_nonce,credentials_encryption_tag)
      values($1,$2,'instagram','Probe','draft',$3,$4,'{}',$5,$6,$7)`,
    [plan.channelId, plan.clientId, accountId, { authMode: "unified_login", instagramProbe: { id: plan.probeId, nonceHash,
      startedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() } },
    credentials.encryptedCredentials, credentials.nonce, credentials.tag]);
    await recordAuditLog({ clientId: plan.clientId, actorUserId: null, action: "instagram.probe_received", targetType: "channel",
      targetId: plan.channelId, metadata: { probeId: plan.probeId, senderId, signatureVerified: true, textHash: nonceHash,
        providerOccurredAt: new Date().toISOString() } });
    plan.receiptId = (await getPool().query("select id from audit_logs where client_id=$1 and action='instagram.probe_received'", [plan.clientId])).rows[0].id;
    postCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method !== "POST") return new Response(JSON.stringify({ id: senderId, username: plan.expectedUsername }));
      postCount++;
      expect(JSON.parse(String(options.body))).toEqual({ recipient: { id: senderId }, message: { text: instagramProbeReplyText } });
      return new Response(JSON.stringify({ message_id: "fixture-outgoing" }));
    }));
  });
  afterEach(async () => {
    await getPool().query("comment on database pronto_test is 'pronto:isolated-test-database:v1'");
    if (plan) await getPool().query("delete from clients where id=$1", [plan.clientId]);
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  afterAll(async () => { await getPool().end(); });
  async function actions() {
    return (await getPool().query("select action from audit_logs where client_id=$1 and action like 'instagram.probe_reply_%' order by created_at,id", [plan.clientId])).rows.map(row => row.action);
  }
  it("previews the fixed reply without claiming or sending", async () => {
    expect(await runInstagramProbeReply(plan)).toMatchObject({ status: "ready", text: instagramProbeReplyText, sendAttempted: false });
    expect(postCount).toBe(0); expect(await actions()).toEqual([]);
  });
  it("allows one send across concurrent callers and keeps the channel draft with no AI jobs", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => runInstagramProbeReply(plan, true)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "fulfilled")).toMatchObject({ value: { status: "accepted", deliveryObserved: false } });
    expect(postCount).toBe(1);
    expect(await actions()).toEqual(["instagram.probe_reply_started", "instagram.probe_reply_accepted"]);
    expect((await getPool().query("select status from channels where client_id=$1 and id=$2", [plan.clientId, plan.channelId])).rows[0].status).toBe("draft");
    for (const table of ["conversations", "messages", "inbound_jobs", "outbound_messages"])
      expect((await getPool().query(`select id from ${table} where client_id=$1`, [plan.clientId])).rowCount).toBe(0);
  });
  it.each(["timeout", "invalid-receipt", "server-error", "rejection"])("does not retry after %s", async failure => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method !== "POST") return new Response(JSON.stringify({ id: senderId, username: plan.expectedUsername }));
      postCount++;
      if (failure === "timeout") throw new Error("fixture transport error");
      return new Response("{}", { status: failure === "server-error" ? 503 : failure === "rejection" ? 400 : 200 });
    }));
    expect(await runInstagramProbeReply(plan, true)).toMatchObject({ status: failure === "rejection" ? "rejected" : "uncertain", retryAllowed: false });
    await expect(runInstagramProbeReply(plan, true)).rejects.toThrow(/already attempted/);
    expect(postCount).toBe(1); expect(await actions()).toHaveLength(2);
  });
  it("requires explicit send authorization and the exact marked target", async () => {
    vi.stubEnv("PRONTO_META_PROBE_REPLY_APPROVED", "0");
    await expect(runInstagramProbeReply(plan, true)).rejects.toThrow(/approval/);
    vi.stubEnv("PRONTO_META_PROBE_REPLY_APPROVED", "1");
    await expect(runInstagramProbeReply({ ...plan, databaseMarker: databaseMarker.replace(/001$/, "002") }, true)).rejects.toThrow(/marker/);
    expect(postCount).toBe(0); expect(await actions()).toEqual([]);
  });
  it("retains the committed claim if saving Meta's successful outcome fails", async () => {
    const original = audit.recordAuditLog;
    vi.spyOn(audit, "recordAuditLog").mockImplementation(async (input, db) => {
      if (input.action === "instagram.probe_reply_accepted") throw new Error("fixture audit failure");
      return original(input, db);
    });
    expect(await runInstagramProbeReply(plan, true)).toMatchObject({ status: "uncertain", retryAllowed: false });
    expect(await actions()).toEqual(["instagram.probe_reply_started"]);
    await expect(runInstagramProbeReply(plan, true)).rejects.toThrow(/already attempted/);
    expect(postCount).toBe(1);
  });
  it("rejects recipient mismatch, missing signed receipt, inactive probe and wrong tenant", async () => {
    await expect(runInstagramProbeReply({ ...plan, expectedUsername: "another_customer" }, true)).rejects.toThrow(/recipient/);
    await expect(runInstagramProbeReply({ ...plan, clientId: randomUUID() }, true)).rejects.toThrow(/channel/i);
    await getPool().query("update audit_logs set metadata=metadata || '{\"signatureVerified\":false}'::jsonb where id=$1 and client_id=$2", [plan.receiptId, plan.clientId]);
    await expect(runInstagramProbeReply(plan, true)).rejects.toThrow(/signed receipt/);
    await getPool().query("update channels set status='disabled' where id=$1 and client_id=$2", [plan.channelId, plan.clientId]);
    await expect(runInstagramProbeReply(plan, true)).rejects.toThrow(/probe\/account/);
    expect(postCount).toBe(0); expect(await actions()).toEqual([]);
  });
  it("rechecks configuration after Meta's recipient lookup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      await getPool().query("update channels set settings=settings-'instagramProbe' where id=$1 and client_id=$2", [plan.channelId, plan.clientId]);
      return new Response(JSON.stringify({ id: senderId, username: plan.expectedUsername }));
    }));
    await expect(runInstagramProbeReply(plan, true)).rejects.toThrow(/probe\/account/);
    expect(fetch).toHaveBeenCalledTimes(1); expect(await actions()).toEqual([]);
  });
});
