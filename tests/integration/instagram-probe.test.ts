import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db";
import { getInstagramChannel } from "@/lib/channels/instagram";
import { encryptedChannelCredentialValues } from "@/lib/channels/credentials";
import { recordInstagramProbe } from "@/lib/channels/instagram-probe";
import { POST } from "@/app/api/webhooks/instagram/[channelId]/route";

const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;
dbDescribe("draft Instagram transport probe", () => {
  let clientId: string, channelId: string;
  const secret = "probe-fixture-secret", phrase = "pronto-test " + "n".repeat(32);
  beforeEach(async () => {
    vi.stubEnv("PRONTO_HOSTED_INSTAGRAM", "1"); vi.stubEnv("PRONTO_DEPLOYMENT_PROFILE", "standard");
    vi.stubEnv("PRONTO_HOSTED_INSTAGRAM_WORKER", "0");
    clientId = randomUUID(); channelId = randomUUID();
    await getPool().query("insert into clients(id,name,slug,vertical,brand_voice) values($1,'Fixture',$2,'general','Clear')", [clientId, clientId]);
    const encrypted = encryptedChannelCredentialValues({ accessToken: "fixture-token", appSecret: secret, igUserId: "ig-business" });
    const probe = { id: randomUUID(), nonceHash: createHash("sha256").update(phrase).digest("hex"),
      startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    await getPool().query(`insert into channels(id,client_id,kind,name,status,external_id,settings,credentials,
      encrypted_credentials,credentials_encryption_nonce,credentials_encryption_tag)
      values($1,$2,'instagram','Probe','draft','ig-business',$3,'{}',$4,$5,$6)`,
    [channelId, clientId, { authMode: "unified_login", instagramProbe: probe }, encrypted.encryptedCredentials, encrypted.nonce, encrypted.tag]);
  });
  afterEach(async () => { await getPool().query("delete from clients where id=$1", [clientId]); vi.unstubAllEnvs(); });
  afterAll(async () => { await getPool().end(); });
  const payload = (text = phrase, sender = "probe-customer", account = "ig-business") => ({ object: "instagram", entry: [{ id: account,
    messaging: [{ sender: { id: sender }, recipient: { id: account }, timestamp: Date.now(), message: { mid: "probe-mid", text } }] }] });
  function request(value = payload(), signingSecret = secret) {
    const body = JSON.stringify(value);
    return new Request("http://localhost:3000/api/webhooks/instagram/" + channelId, { method: "POST", body,
      headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", signingSecret).update(body).digest("hex") } });
  }
  const context = () => ({ params: Promise.resolve({ channelId }) });
  async function evidenceCount() {
    return (await getPool().query("select metadata from audit_logs where client_id=$1 and action='instagram.probe_received'", [clientId])).rows;
  }
  it("records one probe under concurrent signed retries without creating conversations, messages or jobs", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => POST(request(), context())));
    expect(results.every(r => r.status === 200)).toBe(true);
    const evidence = await evidenceCount();expect(evidence).toHaveLength(1);
    expect(evidence[0].metadata).toMatchObject({ senderId: "probe-customer", signatureVerified: true, automatedReplyEnabled: false });
    expect(JSON.stringify(evidence)).not.toContain(phrase);
    for (const table of ["conversations", "messages", "inbound_jobs", "outbound_messages"])
      expect((await getPool().query(`select id from ${table} where client_id=$1`, [clientId])).rowCount).toBe(0);
    expect((await getInstagramChannel(channelId))?.status).toBe("draft");
  });
  it("rejects ordinary messages, invalid signatures, account mismatches and disabled channels", async () => {
    expect((await POST(request(payload("hello")), context())).status).toBe(403);
    expect((await POST(request(payload(), "wrong-secret"), context())).status).toBe(401);
    expect((await POST(request(payload(phrase, "probe-customer", "other-account")), context())).status).toBe(403);
    await getPool().query("update channels set status='disabled' where id=$1", [channelId]);
    expect((await POST(request(), context())).status).toBe(403);
    expect(await evidenceCount()).toHaveLength(0);
  });
  it("rejects a stale channel snapshot after probe settings change", async () => {
    const channel = await getInstagramChannel(channelId);if (!channel) throw new Error("Fixture missing.");
    await getPool().query("update channels set settings=settings-'instagramProbe' where id=$1", [channelId]);
    const value = payload(), rawBody = JSON.stringify(value);
    expect(await recordInstagramProbe({ channel, rawBody,
      signature: "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex") })).toBeNull();
    expect(await evidenceCount()).toHaveLength(0);
  });
});
