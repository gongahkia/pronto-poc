import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  query: vi.fn(),
  transaction: vi.fn(),
  enqueueOutboundMessage: vi.fn(),
  flushOutboundMessage: vi.fn(),
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireUser: mocks.requireUser,
}));

vi.mock("@/lib/db", () => ({
  query: mocks.query,
  transaction: mocks.transaction,
}));

vi.mock("@/lib/channels/outbox", () => ({
  enqueueOutboundMessage: mocks.enqueueOutboundMessage,
  flushOutboundMessage: mocks.flushOutboundMessage,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

import { POST } from "@/app/api/escalations/route";

describe("escalation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({
      userId: "operator-1",
      role: "operator",
      clientId: null,
    });
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: "escalation-1",
          client_id: "client-1",
          conversation_id: "conversation-1",
          status: "claimed",
          channel_id: "channel-1",
          channel_kind: "whatsapp",
          external_thread_id: "6590000000",
        },
      ],
    });
    mocks.transaction.mockImplementation(async (callback) => {
      const client = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "escalation-1" }] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
      };
      return callback(client);
    });
    mocks.enqueueOutboundMessage.mockResolvedValue({ id: "outbound-1" });
    mocks.flushOutboundMessage.mockResolvedValue({
      status: "sent",
      outboundMessageId: "outbound-1",
    });
  });

  it('rejects a customer reply from an inactive saved business before creating messages or outbox work',async()=>{
    vi.stubEnv('PRONTO_DEPLOYMENT_PROFILE','protected-demo');
    try{
      const form=new FormData();form.set('action','resolve');form.set('escalationId','escalation-1');form.set('reply','Hello');
      const response=await POST(new Request('http://localhost/api/escalations',{method:'POST',headers:{Host:'localhost',Origin:'http://localhost'},body:form}));
      expect(response.status).toBe(409);expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
    }finally{vi.unstubAllEnvs();}
  });

  it("enqueues and flushes owner replies after resolving an escalation", async () => {
    const form = new FormData();
    form.set("action", "resolve");
    form.set("escalationId", "escalation-1");
    form.set("reply", "We can help with this now.");
    form.set("returnTo", "/operator/clients/client-1/conversations/conversation-1");

    const response = await POST(
      new Request("http://localhost/api/escalations", {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "http://localhost",
        },
        body: form,
      }),
    );

    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        clientId: "client-1",
        conversationId: "conversation-1",
        escalationId: "escalation-1",
        channelId: "channel-1",
        externalThreadId: "6590000000",
        body: "We can help with this now.",
        idempotencyKey: "escalation-resolution:escalation-1",
      }),
    );
    expect(mocks.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "escalation.resolved",
        metadata: expect.objectContaining({ outboundQueued: true }),
      }),
      expect.any(Object),
    );
    expect(mocks.flushOutboundMessage).toHaveBeenCalledWith("outbound-1", {
      clientId: "client-1",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("retries failed owner reply outbound messages", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: "outbound-1",
          client_id: "client-1",
          escalation_id: "escalation-1",
          status: "failed",
        },
      ],
    });
    mocks.flushOutboundMessage.mockResolvedValueOnce({
      status: "sent",
      outboundMessageId: "outbound-1",
    });

    const form = new FormData();
    form.set("action", "retry_outbound");
    form.set("escalationId", "escalation-1");
    form.set("outboundMessageId", "outbound-1");
    form.set("returnTo", "/operator/clients/client-1/conversations/conversation-1");

    const response = await POST(
      new Request("http://localhost/api/escalations", {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "http://localhost",
        },
        body: form,
      }),
    );

    expect(mocks.flushOutboundMessage).toHaveBeenCalledWith("outbound-1", {
      clientId: "client-1",
    });
    expect(mocks.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "escalation.outbound_retry",
        targetType: "outbound_message",
        targetId: "outbound-1",
        metadata: expect.objectContaining({
          escalationId: "escalation-1",
          previousStatus: "failed",
          result: "sent",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
