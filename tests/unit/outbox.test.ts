import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendChannelText: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  query: mocks.query,
}));

vi.mock("@/lib/channels/dispatch", () => ({
  sendChannelText: mocks.sendChannelText,
}));

vi.mock("@/lib/logger", () => ({
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
  logError: vi.fn(),
  redactErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  redactForLog: (value: unknown) => value,
}));

vi.mock("@/lib/error-tracking", () => ({
  recordErrorEvent: vi.fn().mockResolvedValue(null),
}));

import {
  enqueueOutboundMessage,
  flushOutboundMessage,
  flushRetryableOutboundMessages,
  listRetryableOutboundMessages,
  markStaleOutboundUncertain,
} from "@/lib/channels/outbox";
import type { OutboundMessage } from "@/lib/channels/outbox";
import { ProviderSendError } from "@/lib/channels/provider-error";

describe("outbound message outbox", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues outbound messages with an idempotency key", async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce({ rows: [outboundMessage()] }),
    };

    const result = await enqueueOutboundMessage(db, {
      clientId: "client-1",
      conversationId: "conversation-1",
      escalationId: "escalation-1",
      channelId: "channel-1",
      externalThreadId: "6590000000",
      body: "We will help.",
      idempotencyKey: "escalation-resolution:escalation-1",
      metadata: { purpose: "test" },
    });

    expect(result.id).toBe("outbound-1");
    expect(db.query.mock.calls[0][0]).toContain(
      "on conflict (client_id, idempotency_key)",
    );
    expect(db.query.mock.calls[0][0]).toContain("returning *");
    expect(db.query.mock.calls[0][1]).toEqual([
      "client-1",
      "conversation-1",
      "escalation-1",
      "channel-1",
      "6590000000",
      "We will help.",
      "escalation-resolution:escalation-1",
      { purpose: "test" },
    ]);
  });

  it("scopes duplicate idempotency keys to each client", async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          outboundMessage({
            client_id: "client-2",
            idempotency_key: "agent-answer:message-1",
          }),
        ],
      }),
    };

    const result = await enqueueOutboundMessage(db, {
      clientId: "client-2",
      conversationId: "conversation-2",
      escalationId: null,
      channelId: "channel-2",
      externalThreadId: "thread-2",
      body: "Reply",
      idempotencyKey: "agent-answer:message-1",
    });

    expect(result.client_id).toBe("client-2");
    expect(db.query.mock.calls[0][0]).toContain(
      "on conflict (client_id, idempotency_key)",
    );
  });

  it("marks a pending outbound message sent after channel delivery succeeds", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [outboundMessage()] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await flushOutboundMessage("outbound-1");

    expect(mocks.sendChannelText).toHaveBeenCalledWith({
      channelId: "channel-1",
      clientId: "client-1",
      externalThreadId: "6590000000",
      text: "We will help.",
    });
    expect(mocks.query.mock.calls[1][0]).toContain("status = 'sent'");
    expect(result).toEqual({ status: "sent", outboundMessageId: "outbound-1" });
  });

  it("marks a pending outbound message failed when channel delivery fails", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [outboundMessage()] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.sendChannelText.mockRejectedValueOnce(new Error("WhatsApp send failed"));

    const result = await flushOutboundMessage("outbound-1");

    expect(mocks.query.mock.calls[1][0]).toContain("status = $4");
    expect(mocks.query.mock.calls[1][1]).toEqual([
      "outbound-1",
      "WhatsApp send failed",
      "client-1",
      "failed",
    ]);
    expect(result).toEqual({
      status: "failed",
      outboundMessageId: "outbound-1",
      error: "WhatsApp send failed",
    });
    expect(mocks.query.mock.calls[0][0]).toContain("status in ('pending', 'failed')");
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "outbox.flush_failed",
      expect.objectContaining({
        outboundMessageId: "outbound-1",
        error: expect.any(Error),
      }),
    );
  });

  it("parks ambiguous provider HTTP failures for reconciliation", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [outboundMessage()] }).mockResolvedValueOnce({ rows: [] });
    mocks.sendChannelText.mockRejectedValueOnce(new ProviderSendError("WhatsApp", 500));
    await flushOutboundMessage("outbound-1");
    expect(mocks.query.mock.calls[1][1]).toEqual([
      "outbound-1", "WhatsApp send returned HTTP 500.", "client-1", "uncertain",
    ]);
  });

  it("does not resend after provider acceptance when the local sent write fails", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [outboundMessage()] })
      .mockRejectedValueOnce(new Error("injected sent status write failure"))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await flushOutboundMessage("outbound-1");
    expect(mocks.query.mock.calls[2][1]).toEqual([
      "outbound-1", "injected sent status write failure", "client-1", "uncertain",
    ]);
    await flushOutboundMessage("outbound-1");
    expect(mocks.sendChannelText).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])("logs provider acceptance separately from a failed sent write and reconciliation row count %s", async rowCount => {
    vi.stubEnv("PRONTO_DEBUG_DELIVERY", "1");
    mocks.query.mockResolvedValueOnce({ rows: [outboundMessage()] })
      .mockRejectedValueOnce(new Error("injected sent write failure"))
      .mockResolvedValueOnce({ rows: [], rowCount });
    mocks.sendChannelText.mockResolvedValueOnce({ providerMessageId: "private-provider-receipt" });
    await flushOutboundMessage("outbound-1");
    expect(mocks.logInfo).toHaveBeenCalledWith("delivery.attempt_finished", expect.objectContaining({
      finalState: "uncertain", statePersisted: rowCount === 1, acceptanceState: "reported",
      providerReceiptHash: expect.stringMatching(/^sha256:/),
    }));
    expect(mocks.sendChannelText).toHaveBeenCalledTimes(1);
  });

  it("emits the final unknown persistence state even if both outcome writes fail", async () => {
    vi.stubEnv("PRONTO_DEBUG_DELIVERY", "1");
    mocks.query.mockResolvedValueOnce({ rows: [outboundMessage()] })
      .mockRejectedValueOnce(new Error("sent write failed"))
      .mockRejectedValueOnce(new Error("uncertain write failed"));
    mocks.sendChannelText.mockResolvedValueOnce({ providerMessageId: "private-provider-receipt" });
    await expect(flushOutboundMessage("outbound-1")).rejects.toThrow("uncertain write failed");
    expect(mocks.logInfo).toHaveBeenCalledWith("delivery.attempt_finished", expect.objectContaining({
      finalState: "uncertain", statePersisted: false, acceptanceState: "reported",
    }));
    expect(mocks.sendChannelText).toHaveBeenCalledTimes(1);
  });

  it("lists pending and known retryable failures without replaying stale sends", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [outboundMessage()] });

    const result = await listRetryableOutboundMessages({
      limit: 10,
      staleSendingMinutes: 15,
      maxAttempts: 4,
    });

    expect(result).toHaveLength(1);
    expect(mocks.query.mock.calls[0][0]).toContain("status in ('pending', 'failed')");
    expect(mocks.query.mock.calls[0][0]).not.toContain("status = 'sending'");
    expect(mocks.query.mock.calls[0][1]).toEqual([4, 10, null]);
  });

  it("moves expired in-flight sends to manual reconciliation", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 2 });
    expect(await markStaleOutboundUncertain(15)).toBe(2);
    expect(mocks.query.mock.calls[0][0]).toContain("status = 'uncertain'");
    expect(mocks.query.mock.calls[0][1]).toEqual([15]);
  });

  it("flushes retryable outbound messages and returns a batch summary", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          outboundMessage({ id: "outbound-1" }),
          outboundMessage({ id: "outbound-2" }),
        ],
      })
      .mockResolvedValueOnce({ rows: [outboundMessage({ id: "outbound-1" })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await flushRetryableOutboundMessages({
      requestId: "req_12345678",
    });

    expect(result).toMatchObject({
      attempted: 2,
      sent: 1,
      failed: 0,
      skipped: 1,
    });
    expect(result.results).toEqual([
      { status: "sent", outboundMessageId: "outbound-1" },
      {
        status: "skipped",
        outboundMessageId: "outbound-2",
        reason: "Outbound message is not retryable.",
      },
    ]);
  });
});

function outboundMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: "outbound-1",
    client_id: "client-1",
    conversation_id: "conversation-1",
    escalation_id: "escalation-1",
    channel_id: "channel-1",
    external_thread_id: "6590000000",
    body: "We will help.",
    status: "pending",
    attempt_count: 0,
    last_error: null,
    idempotency_key: "escalation-resolution:escalation-1",
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    sent_at: null,
    ...overrides,
  };
}
