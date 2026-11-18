import { afterEach, describe, expect, it, vi } from "vitest";
import { logDeliveryDebug, providerIdentifierHash, withDeliveryDebugContext } from "@/lib/channels/delivery-debug";

const context = { outboundMessageId: "12345678-1234-4123-8123-123456789012", clientId: "22345678-1234-4123-8123-123456789012",
  channelId: "32345678-1234-4123-8123-123456789012", conversationId: "42345678-1234-4123-8123-123456789012", attemptCount: 1 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("local delivery diagnostics", () => {
  it.each([undefined, "0"])("is silent without explicit local opt-in", async flag => {
    vi.stubEnv("PRONTO_DEBUG_DELIVERY", flag);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    await withDeliveryDebugContext(context, async () => logDeliveryDebug("delivery.fixture"));
    expect(log).not.toHaveBeenCalled();
  });

  it("stays disabled in production even when opted in", async () => {
    vi.stubEnv("PRONTO_DEBUG_DELIVERY", "1"); vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    await withDeliveryDebugContext(context, async () => logDeliveryDebug("delivery.fixture"));
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps concurrent attempt contexts separate across asynchronous calls", async () => {
    vi.stubEnv("PRONTO_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const other = { ...context, outboundMessageId: "52345678-1234-4123-8123-123456789012", attemptCount: 2 };
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const first = withDeliveryDebugContext(context, async () => {
      logDeliveryDebug("delivery.first_started"); started(); await blocked; logDeliveryDebug("delivery.first_finished");
    });
    await entered;
    await withDeliveryDebugContext(other, async () => { await Promise.resolve(); logDeliveryDebug("delivery.other"); });
    release(); await first;
    const records = log.mock.calls.map(call => JSON.parse(String(call[0])));
    expect(records.map(record => record.outboundMessageId)).toEqual([context.outboundMessageId, other.outboundMessageId, context.outboundMessageId]);
    expect(records[0].deliveryAttemptId).toBe(records[2].deliveryAttemptId);
    expect(records[0].deliveryAttemptId).not.toBe(records[1].deliveryAttemptId);
    expect(records[1]).toMatchObject({ debugDelivery: true, processId: process.pid, attemptCount: 2 });
  });

  it("hashes provider identifiers and retains redaction for incidental metadata", () => {
    vi.stubEnv("PRONTO_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const hash = providerIdentifierHash("private-provider-receipt");
    logDeliveryDebug("delivery.fixture", { providerReceiptHash: hash, providerTraceHash: hash,
      body: "private text", authorization: "Bearer private-token", raw: { private: true } });
    const record = JSON.parse(String(log.mock.calls[0][0]));
    expect(record).toMatchObject({ providerReceiptHash: hash, providerTraceHash: hash,
      body: "[redacted]", authorization: "[redacted]", raw: "[redacted-object]" });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain("private-provider-receipt");
    expect(providerIdentifierHash(null)).toBeUndefined();
  });

  it("does not turn a diagnostic sink failure into a failed send", async () => {
    vi.stubEnv("PRONTO_DEBUG_DELIVERY", "1");
    vi.spyOn(console, "info").mockImplementation(() => { throw new Error("sink failed"); });
    expect(await withDeliveryDebugContext(context, async () => { logDeliveryDebug("delivery.fixture"); return "sent"; })).toBe("sent");
  });
});
