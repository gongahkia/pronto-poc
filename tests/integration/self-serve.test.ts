import * as email from "@/lib/channels/email";
import * as dispatch from "@/lib/channels/dispatch";
import { selfServeAlert } from "@/lib/self-serve/alerts";
import { encryptedChannelCredentialValues } from "@/lib/channels/credentials";
// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { getPool, query } from "@/lib/db";
import { enterTenantContext } from "@/lib/tenant-context";
import {
  initializeSelfServe,
  snapshot,
  editRule,
  removeRule,
  removeSource,
  saveVoice,
} from "@/lib/self-serve/store";
import { addSource, updateSettings } from "@/lib/self-serve/settings";
import {
  processSelfServeJobs,
  claimJob,
  updateJob,
  validateExtractedRules,
} from "@/lib/self-serve/jobs";
import { runtimeConfig, selfServeKnowledge } from "@/lib/self-serve/runtime";
import {
  createVoiceSession,
  addVoiceReply,
  selectSpeaker,
  analyseUpload,
  voiceSession,
  discardVoice,
} from "@/lib/self-serve/voice";
import {
  recordNativeOwnerReply,
  instagramOwnerEchoes,
  whatsAppOwnerEchoes,
} from "@/lib/self-serve/owner-replies";
import { sealFile } from "@/lib/self-serve/files";
import {
  enqueueOutboundMessage,
  flushOutboundMessage,
} from "@/lib/channels/outbox";
import {
  POST as configurationPost,
  GET as configurationGet,
} from "@/app/api/self-serve/[[...path]]/route";
import { createEscalation } from "@/lib/agent/engine";
const auth = vi.hoisted(() => ({
  user: null as import("@/lib/auth").SessionUser | null,
}));
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<typeof import("@/lib/auth")>()),
  getSessionUser: async () => auth.user,
}));
const model = vi.hoisted(() => vi.fn());
vi.mock("@/lib/self-serve/model", async (original) => ({
  ...(await original<typeof import("@/lib/self-serve/model")>()),
  selfServeModel: model,
}));
const dbDescribe =
  process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;
dbDescribe("self-serve configuration on owned PostgreSQL", () => {
  let client: string, actor: string, channel: string;
  beforeEach(async () => {
    vi.stubEnv("PRONTO_SELF_SERVE_ENABLED", "1");
    enterTenantContext({ role: "operator", clientId: null });
    client = randomUUID();
    actor = randomUUID();
    channel = randomUUID();
    await getPool().query(
      "insert into clients(id,name,slug,vertical,brand_voice) values($1::uuid,'Self Serve Fixture',$1::text,'fnb','Helpful')",
      [client],
    );
    await getPool().query(
      "insert into users(id,client_id,email,name,role,password_hash) values($1::uuid,$2,$1::text||'@fixture.invalid','Owner','client','!')",
      [actor, client],
    );
    await getPool().query(
      "insert into staff_permission_grants(client_id,user_id,permission,granted_by) values($1,$2,'knowledge.approve',$2),($1,$2,'escalation.policy.manage',$2)",
      [client, actor],
    );
    await getPool().query(
      "insert into channels(id,client_id,kind,name,status) values($1,$2,'instagram','Fixture','active')",
      [channel, client],
    );
    await initializeSelfServe(client, actor);
    auth.user = {
      userId: actor,
      clientId: client,
      role: "client",
      name: "Fixture Owner",
      email: actor + "@fixture.invalid",
    };
    model.mockReset();
    model.mockImplementation(async (_client, purpose, _instructions, data) => {
      if (purpose === "rules")
        return {
          model: "canned-test",
          value: {
            rules: data.segments.flatMap((s: { ref: string; text: string }) => [
              {
                text: s.text,
                ref: s.ref,
                topic: "opening_hours",
                evidence: s.text,
              },
            ]),
          },
        };
      if (purpose === "faithfulness")
        return {
          model: "canned-test",
          value: {
            rules: data.rules.map((r: { id: string }) => ({
              id: r.id,
              supported: true,
              reason: "Explicit canned verification.",
            })),
          },
        };
      if (purpose === "conflicts")
        return {
          model: "canned-test",
          value: {
            pairs: data.pairs.map(
              (p: { a: string; b: string; ruleA: string; ruleB: string }) => ({
                a: p.a,
                b: p.b,
                classification:
                  p.ruleA.includes("Closed") !== p.ruleB.includes("Closed")
                    ? "contradicts"
                    : "consistent",
                explanation: "Explicit canned judgement; no external model.",
              }),
            ),
          },
        };
      if (purpose === "voice")
        return {
          model: "canned-test",
          value: {
            notes: [
              "Uses short replies.",
              "Uses lowercase greetings.",
              "Uses gentle, direct wording.",
            ],
          },
        };
      throw new Error("Unexpected fixture model call");
    });
  });
  afterEach(async () => {
    enterTenantContext({ role: "operator", clientId: null });
    await getPool().query("delete from clients where id=$1", [client]);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await getPool().end();
  });
  const current = () => snapshot(client);
  it("reports source stages without returning source text or private voice results", async () => {
    const id = randomUUID();
    await addSource(client, actor, { id, type: "text", label: "Policy source", text: "Private source evidence for extraction." });
    expect((await current()).sources[0].progress.stage).toBe("Queued to read source");
    await processSelfServeJobs(client);
    const state = await current();
    expect(state.sources[0].progress).toMatchObject({ stage: "Extracting business rules", completed: 0, total: 1 });
    expect(JSON.stringify(state)).not.toContain("Private source evidence");
    expect(state.sources[0]).not.toHaveProperty("processing_counts");
    await getPool().query("update selfserve_jobs set created_at=now()-interval '2 days' where client_id=$1", [client]);
    expect((await current()).sources[0].progress.jobStatus).toBe("pending");
    expect((await current()).jobs).toHaveLength(0);
  });
  it("queues preset previews for the real-model job path without activating the preset", async () => {
    const id = randomUUID(), before = (await current()).settings!.voice;
    const context = { params: Promise.resolve({ path: ["preview"] }) };
    const request = (data: unknown) => new Request("http://localhost:3000/api/self-serve/preview", {
      method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    expect((await configurationPost(request({ id, preset_id: "formal" }), context)).status).toBe(200);
    const job = (await getPool().query("select payload from selfserve_jobs where client_id=$1 and target_id=$2", [client, id])).rows[0];
    expect(job.payload.notes).toEqual([expect.stringContaining("polished")]);
    expect((await current()).settings!.voice).toEqual(before);
    expect((await configurationPost(request({ id: randomUUID(), preset_id: "unknown" }), context)).status).toBe(400);
    expect((await configurationPost(request({ id: randomUUID(), preset_id: "formal", notes: ["Other"] }), context)).status).toBe(400);
  });
  async function pump() {
    for (let i = 0; i < 40; i++) {
      const state = await current();
      if (!state.jobs.some((j) => ["pending", "processing"].includes(j.status)))
        return state;
      await processSelfServeJobs(client);
    }
    throw new Error("Fixture did not settle.");
  }
  async function source(text: string) {
    const id = randomUUID();
    await addSource(client, actor, { id, type: "text", label: text, text });
    await pump();
    return id;
  }
  it("shows only this business’s active Instagram inbox without exposing channel secrets", async () => {
    const draft = randomUUID(),
      disabled = randomUUID(),
      otherClient = randomUUID();
    await getPool().query(
      "insert into channels(id,client_id,kind,name,status,settings,credentials,external_id) values($1,$3,'instagram','Demo draft','draft','{}','{}','draft-account'),($2,$3,'instagram','Old account','disabled','{}','{}','disabled-account')",
      [draft, disabled, client],
    );
    await getPool().query(
      'update channels set settings=\'{"verifyToken":"private-verifier"}\',credentials=\'{"accessToken":"private-token"}\' where id=$1 and client_id=$2',
      [channel, client],
    );
    await getPool().query(
      "insert into clients(id,name,slug,vertical,brand_voice) values($1::uuid,'Other business',$1::text,'fnb','Helpful')",
      [otherClient],
    );
    try {
      await getPool().query(
        "insert into channels(client_id,kind,name,status) values($1,'instagram','Other inbox','active')",
        [otherClient],
      );
      const state = await current();
      expect(state.instagram).toEqual([
        { id: channel, name: "Fixture", status: "active" },
      ]);
      expect(JSON.stringify(state.instagram)).not.toMatch(
        /private-token|private-verifier|Other inbox|Demo draft/,
      );
    } finally {
      await getPool().query("delete from clients where id=$1", [otherClient]);
    }
  });
  it("requires authentication, CSRF and business permission without accepting a browser-selected tenant", async () => {
    const path = { params: Promise.resolve({ path: ["sources"] }) };
    const id = randomUUID();
    const request = (origin = "http://localhost:3000") =>
      new Request("http://localhost:3000/api/self-serve/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          id,
          clientId: randomUUID(),
          type: "text",
          label: "Scoped source",
          text: "Open daily.",
        }),
      });
    const owner = auth.user;
    auth.user = null;
    expect((await configurationPost(request(), path)).status).toBe(401);
    auth.user = owner;
    expect(
      (await configurationPost(request("https://other.invalid"), path)).status,
    ).toBe(403);
    expect((await configurationPost(request(), path)).status).toBe(200);
    expect(
      (
        await getPool().query(
          "select client_id from selfserve_sources where id=$1",
          [id],
        )
      ).rows[0].client_id,
    ).toBe(client);
    const session = randomUUID();
    await createVoiceSession(client, actor, session, "conversation");
    await addVoiceReply(client, actor, session, 1, "private fictional phrase");
    await expect(voiceSession(client, randomUUID(), session)).rejects.toThrow(
      /not found/,
    );
    expect(JSON.stringify(await current())).not.toContain(
      "private fictional phrase",
    );
    await getPool().query(
      "delete from staff_permission_grants where client_id=$1 and user_id=$2 and permission='knowledge.approve'",
      [client, actor],
    );
    expect(
      (
        await configurationGet(
          new Request("http://localhost:3000/api/self-serve"),
          { params: Promise.resolve({ path: [] }) },
        )
      ).status,
    ).toBe(403);
  });
  it("publishes only checked rules, withholds both conflicting alternatives and preserves other facts", async () => {
    const id = randomUUID();
    await addSource(client, actor, {
      id,
      type: "text",
      label: "Hours",
      text: "Open every day.",
    });
    expect((await current()).rules).toHaveLength(0);
    await pump();
    expect((await current()).rules).toEqual([
      expect.objectContaining({ live: true, text: "Open every day." }),
    ]);
    await source("Closed Saturdays.");
    const state = await current();
    expect(state.conflicts).toHaveLength(1);
    expect(state.rules.every((r) => !r.live)).toBe(true);
    expect((await runtimeConfig(client))!.rules).toHaveLength(0);
    await removeRule(
      client,
      actor,
      String(state.rules[0].id),
      state.settings!.version,
      true,
    );
    const after = await current();
    expect(after.conflicts).toHaveLength(0);
    expect(after.rules).toHaveLength(1);
    expect(after.rules[0].live).toBe(true);
  });
  it("withholds a source when independent verification rejects a lost negation", async () => {
    const original = model.getMockImplementation()!;
    model.mockImplementation(async (...args) => {
      if (args[1] === "rules")
        return {
          model: "canned-test",
          value: {
            rules: [
              {
                text: "Open Saturdays.",
                ref: "your text",
                topic: "opening_hours",
                evidence: "Not open Saturdays.",
              },
            ],
          },
        };
      if (args[1] === "faithfulness")
        return {
          model: "canned-test",
          value: {
            rules: args[3].rules.map((r: { id: string }) => ({
              id: r.id,
              supported: false,
              reason: "The rule reverses a negation.",
            })),
          },
        };
      return original(...args);
    });
    await source("Not open Saturdays.");
    const state = await current();
    expect(state.rules).toHaveLength(0);
    expect(state.sources[0].status).toBe("failed");
  });
  it("compares differently tagged rules without lexical pruning in a larger workspace", async () => {
    const old = randomUUID();
    await getPool().query(
      "insert into selfserve_sources(id,client_id,type,label,status) values($1,$2,'text','Existing policies','ready')",
      [old, client],
    );
    await getPool().query(
      "insert into selfserve_rules(client_id,source_id,text,ref,topic,position,checked) select $1,$2,'Other policy '||n,'your text','other_topic',n,true from generate_series(1,200) n",
      [client, old],
    );
    await getPool().query(
      "insert into selfserve_rules(client_id,source_id,text,ref,topic,position,checked) values($1,$2,'Closed Saturdays.','your text','operating_days',201,true)",
      [client, old],
    );
    await source("Open every day.");
    const state = await current();
    expect(state.conflicts).toHaveLength(1);
    expect(state.rules.find((r) => r.text === "Open every day.")!.live).toBe(
      false,
    );
    expect(
      model.mock.calls
        .filter((call) => call[1] === "conflicts")
        .flatMap((call) => call[3].pairs)
        .some((pair) => [pair.ruleA, pair.ruleB].includes("Closed Saturdays.")),
    ).toBe(true);
  });
  it("retains conflicts during edit and only resolves after rechecking", async () => {
    await source("Open every day.");
    await source("Closed Saturdays.");
    let state = await current();
    const rule = state.rules.find((r) => String(r.text).startsWith("Closed"))!;
    await editRule(
      client,
      actor,
      String(rule.id),
      "Open Saturdays.",
      state.settings!.version,
    );
    state = await current();
    expect(state.conflicts).toHaveLength(1);
    expect(state.rules.find((r) => r.id === rule.id)!.checked).toBe(false);
    await pump();
    state = await current();
    expect(state.conflicts).toHaveLength(0);
    expect(state.rules.every((r) => r.live)).toBe(true);
  });
  it("rejects stale settings, locked-trigger changes and unverified alert destinations", async () => {
    const initial = (await current()).settings!;
    await saveVoice(client, actor, {
      version: initial.version,
      mode: "preset",
      preset_id: "playful",
    });
    await expect(
      saveVoice(client, actor, {
        version: initial.version,
        mode: "preset",
        preset_id: "formal",
      }),
    ).rejects.toThrow(/changed/);
    const settings = (await current()).settings!;
    const handovers = structuredClone(settings.handovers);
    handovers.presets.not_covered.enabled = false;
    await expect(
      updateSettings(client, actor, { version: settings.version, handovers }),
    ).rejects.toThrow(/always/);
    await expect(
      updateSettings(client, actor, {
        version: settings.version,
        alerts: {
          whatsapp_enabled: true,
          whatsapp_number: "+6599999999",
          email_enabled: false,
          email_address: "",
        },
      }),
    ).rejects.toThrow(/verify/);
  });
  it("keeps custom notes while switching presets and validates the private voice session", async () => {
    let state = await current();
    await saveVoice(client, actor, {
      version: state.settings!.version,
      mode: "custom",
      custom_origin: "existing",
      custom_notes: ["Short and warm."],
    });
    state = await current();
    await saveVoice(client, actor, {
      version: state.settings!.version,
      mode: "preset",
      preset_id: "formal",
    });
    state = await current();
    expect(state.settings!.voice).toMatchObject({
      mode: "preset",
      preset_id: "formal",
      custom_notes: ["Short and warm."],
    });
    await expect(
      saveVoice(client, actor, {
        version: state.settings!.version,
        mode: "custom",
        custom_origin: "conversation",
        custom_notes: ["New note."],
        sessionId: randomUUID(),
      }),
    ).rejects.toThrow(/no longer ready/);
  });
  it("uses lease tokens to reject a late processing attempt and cancels deleted sources", async () => {
    const id = randomUUID();
    await addSource(client, actor, {
      id,
      type: "text",
      label: "Pending",
      text: "Open daily.",
    });
    const old = (await claimJob(client))!;
    await getPool().query(
      "update selfserve_jobs set lease_until=now()-interval '1 second' where id=$1",
      [old.id],
    );
    const next = (await claimJob(client))!;
    expect(next.lease_token).not.toBe(old.lease_token);
    await updateJob(old, { bad: true }, "ready");
    expect(
      (
        await getPool().query("select status from selfserve_jobs where id=$1", [
          old.id,
        ])
      ).rows[0].status,
    ).toBe("processing");
    const state = await current();
    await removeSource(client, actor, id, state.settings!.version);
    await updateJob(next, null, "pending");
    await pump();
    expect((await current()).rules).toHaveLength(0);
  });
  it("persists three ordered training rounds and rejects customer-side export analysis", async () => {
    const id = randomUUID();
    await createVoiceSession(client, actor, id, "conversation");
    await expect(addVoiceReply(client, actor, id, 2, "hello")).rejects.toThrow(
      /Reload/,
    );
    await addVoiceReply(client, actor, id, 1, "hey there");
    await addVoiceReply(client, actor, id, 1, "hey there");
    await addVoiceReply(client, actor, id, 2, "our team can check");
    await addVoiceReply(client, actor, id, 3, "sorry to hear this");
    await pump();
    expect(await voiceSession(client, actor, id)).toMatchObject({
      status: "ready",
      draft_notes: [
        "Uses short replies.",
        "Uses lowercase greetings.",
        "Uses gentle, direct wording.",
      ],
    });
    const upload = randomUUID();
    const raw =
      "[20/11/26, 10:00] Customer: Can I book?\n[20/11/26, 10:01] Business: hey! let me check for you +6591234567";
    await createVoiceSession(
      client,
      actor,
      upload,
      "upload",
      sealFile({
        name: "samples",
        type: "json",
        data: JSON.stringify([
          {
            name: "chat.txt",
            type: "text/plain",
            data: Buffer.from(raw).toString("base64"),
          },
        ]),
      }),
    );
    await pump();
    await expect(
      analyseUpload(client, actor, upload, "Business", raw),
    ).rejects.toThrow(/Select/);
    const selected = await selectSpeaker(client, actor, upload, "Business");
    expect(selected.review_text).not.toContain("Can I book");
    expect(selected.review_text).not.toContain("91234567");
    await analyseUpload(
      client,
      actor,
      upload,
      "Business",
      selected.review_text!,
    );
    await discardVoice(client, actor, upload);
    await pump();
    expect(await voiceSession(client, actor, upload)).toMatchObject({
      status: "discarded",
      review_text: null,
    });
  });
  it("enforces tenant scope for the new tables and never falls back to old knowledge", async () => {
    await source("Opening hours 10am to 10pm.");
    expect((await selfServeKnowledge(client, "Opening hours", 5))!.length).toBe(
      1,
    );
    enterTenantContext({ role: "client", clientId: randomUUID() });
    await expect(
      query("select * from selfserve_settings where client_id=$1", [client]),
    ).rejects.toThrow();
    await expect(
      query("select * from selfserve_rules where client_id=$1", [client]),
    ).rejects.toThrow();
  });
  it("purges an expired private session and suppresses replies from an older configuration", async () => {
    const id = randomUUID();
    await createVoiceSession(client, actor, id, "conversation");
    await addVoiceReply(client, actor, id, 1, "private fictional sample");
    await getPool().query(
      "update selfserve_voice_sessions set expires_at=now()-interval '1 second' where id=$1",
      [id],
    );
    expect(await voiceSession(client, actor, id)).toMatchObject({
      status: "discarded",
      replies: [],
      review_text: null,
      draft_notes: [],
    });
    const conv = randomUUID();
    await getPool().query(
      "insert into conversations(id,client_id,channel_id,external_thread_id) values($1,$2,$3,'customer')",
      [conv, client, channel],
    );
    const outbound = await enqueueOutboundMessage(
      { query },
      {
        clientId: client,
        channelId: channel,
        conversationId: conv,
        externalThreadId: "customer",
        body: "Old reply",
        idempotencyKey: "stale-" + conv,
        metadata: { purpose: "agent_answer", selfServeVersion: "0" },
      },
    );
    expect(
      await flushOutboundMessage(outbound.id, { clientId: client }),
    ).toMatchObject({ status: "skipped" });
    expect(
      (
        await getPool().query(
          "select status from outbound_messages where id=$1",
          [outbound.id],
        )
      ).rows[0].status,
    ).toBe("suppressed");
  });
  it("sends staff email directly and retries only the failed alert destination", async () => {
    const emailSend = vi
      .spyOn(email, "sendEmail")
      .mockResolvedValue({ messageId: "fixture-email-alert" });
    const whatsappSend = vi
      .spyOn(dispatch, "sendChannelText")
      .mockRejectedValueOnce(new Error("Fixture failure before acceptance"))
      .mockResolvedValue({ providerMessageId: "fixture-wa-alert" });
    const conv = randomUUID(),
      message = randomUUID();
    await getPool().query(
      "insert into conversations(id,client_id,channel_id,external_thread_id) values($1,$2,$3,'customer')",
      [conv, client, channel],
    );
    await getPool().query(
      "insert into messages(id,client_id,channel_id,conversation_id,external_message_id,sender_role,body) values($1,$2,$3,$4,'alert-incoming','customer','Need help')",
      [message, client, channel, conv],
    );
    await getPool().query(
      "insert into staff_permission_grants(client_id,user_id,permission,granted_by) values($1,$2,'conversation.respond',$2)",
      [client, actor],
    );
    for (const [kind, destination] of [
      ["email", "owner@fixture.invalid"],
      ["whatsapp", "+6599999999"],
    ]) {
      const e = encryptedChannelCredentialValues({
        provider: kind === "email" ? "postmark" : "cloud",
        apiKey: "fixture-not-live",
        fromAddress: "business@fixture.invalid",
      });
      await getPool().query(
        "insert into channels(id,client_id,kind,name,status,encrypted_credentials,credentials_encryption_nonce,credentials_encryption_tag) values($1,$2,$3,'Alert fixture','active',$4,$5,$6)",
        [randomUUID(), client, kind, e.encryptedCredentials, e.nonce, e.tag],
      );
      await getPool().query(
        "insert into staff_notification_destinations(client_id,kind,destination,recipient_user_id,verified_at,enabled) values($1,$2,$3,$4,now(),true)",
        [client, kind, destination, actor],
      );
    }
    const settings = (await current()).settings!;
    await updateSettings(client, actor, {
      version: settings.version,
      alerts: {
        email_enabled: true,
        email_address: "owner@fixture.invalid",
        whatsapp_enabled: true,
        whatsapp_number: "+6599999999",
      },
    });
    const escalation = await createEscalation({
      clientId: client,
      channelId: channel,
      conversationId: conv,
      customerMessageId: message,
      customerMessage: "Need help",
      reasonCode: "unknown",
      reasonDetail: "Fixture",
      confidence: 1,
    });
    expect(
      await selfServeAlert(escalation.escalationId!, client),
    ).toMatchObject({ status: "failed" });
    expect(
      await selfServeAlert(escalation.escalationId!, client),
    ).toMatchObject({ status: "sent" });
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@fixture.invalid",
        subject: "Pronto handover",
      }),
    );
    expect(whatsappSend).toHaveBeenCalledTimes(2);
    expect(
      await selfServeAlert(escalation.escalationId!, client, "reminder"),
    ).toMatchObject({ status: "skipped" });
    vi.stubEnv("PRONTO_DEPLOYMENT_PROFILE", "protected-demo");
    expect(
      await selfServeAlert(escalation.escalationId!, client),
    ).toMatchObject({ status: "skipped" });
    expect(emailSend).toHaveBeenCalledTimes(1);
  });
  it("creates silent paused handovers, resumes only a fresh native reply, and keeps old work skipped", async () => {
    const conv = randomUUID(),
      message = randomUUID();
    await getPool().query(
      "insert into conversations(id,client_id,channel_id,external_thread_id) values($1,$2,$3,'customer')",
      [conv, client, channel],
    );
    await getPool().query(
      "insert into messages(id,client_id,channel_id,conversation_id,external_message_id,sender_role,body) values($1,$2,$3,$4,'incoming','customer','I need help')",
      [message, client, channel, conv],
    );
    await createEscalation({
      clientId: client,
      channelId: channel,
      conversationId: conv,
      customerMessageId: message,
      customerMessage: "I need help",
      reasonCode: "unknown",
      reasonDetail: "Unknown rule",
      confidence: 1,
      handoffReply: { body: "Should not be sent", metadata: {} },
    });
    expect(
      (
        await getPool().query(
          "select status,ai_should_respond from conversations where id=$1",
          [conv],
        )
      ).rows[0],
    ).toMatchObject({ status: "escalated", ai_should_respond: false });
    expect(
      (
        await getPool().query(
          "select id from messages where conversation_id=$1 and sender_role='agent'",
          [conv],
        )
      ).rowCount,
    ).toBe(0);
    const queued = await enqueueOutboundMessage(
      { query },
      {
        clientId: client,
        channelId: channel,
        conversationId: conv,
        externalThreadId: "customer",
        body: "Older queued AI reply",
        idempotencyKey: "old-native-" + conv,
        metadata: {
          purpose: "agent_answer",
          customerMessageId: message,
          selfServeVersion: (await current()).settings!.version,
        },
      },
    );
    const echo = {
      messageId: "native-owner",
      threadId: "customer",
      body: "I can help.",
      occurredAt: new Date(Date.now() - 60000),
    };
    expect(
      await recordNativeOwnerReply({ id: channel, client_id: client }, echo),
    ).toBe(false);
    echo.occurredAt = new Date(Date.now() + 100);
    expect(
      await recordNativeOwnerReply({ id: channel, client_id: client }, echo),
    ).toBe(true);
    expect(
      await recordNativeOwnerReply({ id: channel, client_id: client }, echo),
    ).toBe(false);
    expect(
      (
        await getPool().query("select status from conversations where id=$1", [
          conv,
        ])
      ).rows[0].status,
    ).toBe("active");
    expect(
      await flushOutboundMessage(queued.id, { clientId: client }),
    ).toMatchObject({ status: "skipped" });
    expect(
      (
        await getPool().query(
          "select status from outbound_messages where id=$1",
          [queued.id],
        )
      ).rows[0].status,
    ).toBe("suppressed");
  });
});
describe("self-serve extraction and echo boundaries", () => {
  it("rejects invented numeric facts despite a valid evidence quote", () => {
    expect(() =>
      validateExtractedRules(
        [
          {
            text: "Corkage costs S$40.",
            evidence: "Corkage costs S$30.",
            ref: "p. 1",
            topic: "corkage",
          },
        ],
        [{ ref: "p. 1", text: "Corkage costs S$30." }],
      ),
    ).toThrow(/factual value/);
  });
  it("ignores automation, receipts, edits and mismatched account events", () => {
    const event = {
      sender: { id: "business" },
      recipient: { id: "customer" },
      timestamp: Date.now(),
      message: { is_echo: true, mid: "native", text: "hi" },
    };
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "business",
          messaging: [
            event,
            { ...event, message: { ...event.message, app_id: "our-app" } },
            { ...event, message: { ...event.message, is_echo: false } },
          ],
        },
      ],
    };
    expect(instagramOwnerEchoes(payload, "business", "our-app")).toHaveLength(
      1,
    );
    expect(instagramOwnerEchoes(payload, "other")).toEqual([]);
    expect(
      whatsAppOwnerEchoes(
        {
          object: "whatsapp_business_account",
          entry: [
            {
              changes: [
                {
                  field: "messages",
                  value: {
                    metadata: { phone_number_id: "phone" },
                    statuses: [{ status: "read" }],
                  },
                },
              ],
            },
          ],
        },
        "phone",
      ),
    ).toEqual([]);
  });
});
