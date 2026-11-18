import { describe, expect, it, vi } from "vitest";
import {
  logWarn,
  redactErrorMessage,
  redactForLog,
  requestIdFromRequest,
  requestIdHeaders,
} from "@/lib/logger";

describe("logger", () => {
  it("redacts secrets, message bodies, bearer tokens, and phone-like values", () => {
    const redacted = redactForLog({
      phone: "+65 9123 4567",
      credentials: { accessToken: "token-123" },
      raw: { text: "customer private message" },
      error: new Error("Failed for +65 9123 4567 with Bearer token-123"),
    });

    expect(redacted).toEqual({
      phone: "[redacted-phone]",
      credentials: "[redacted]",
      raw: "[redacted-object]",
      error: {
        name: "Error",
        message: "Failed for [redacted-phone] with Bearer [redacted]",
      },
    });
  });

  it("uses valid request IDs and attaches response headers", () => {
    const request = new Request("http://localhost/api", {
      headers: { "x-request-id": "req_12345678" },
    });

    expect(requestIdFromRequest(request)).toBe("req_12345678");
    expect(requestIdHeaders("req_12345678").get("x-request-id")).toBe("req_12345678");
  });

  it("preserves only validated internal correlation UUIDs while keeping content and external IDs redacted", () => {
    const id = "12345678-1234-4123-8123-123456789012";
    expect(redactForLog({ outboundMessageId: id, conversationId: id, channelId: id, deliveryAttemptId: id,
      body: id, providerMessageId: "private-provider-id", customerMessageId: "private-customer-text",
      accessToken: id })).toEqual({ outboundMessageId: id, conversationId: id, channelId: id, deliveryAttemptId: id,
      body: "[redacted]", providerMessageId: "[redacted]", customerMessageId: "[redacted]", accessToken: "[redacted]" });
  });

  it.each(["input_token", "client_secret", "app_secret", "verify_token", "hub.verify_token", "appsecret_proof"])(
    "redacts %s from diagnostic error URLs", parameter => {
      expect(redactErrorMessage(`https://graph.test/path?${parameter}=private-value&ok=1`))
        .toBe(`https://graph.test/path?${parameter}=[redacted]&ok=1`);
    });

  it("emits structured warning logs after redaction", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    logWarn("test_event", {
      requestId: "req_12345678",
      body: "private customer text",
      phone: "6591234567",
    });

    const payload = JSON.parse(String(warn.mock.calls[0][0]));
    expect(payload).toMatchObject({
      level: "warn",
      event: "test_event",
      requestId: "req_12345678",
      body: "[redacted]",
      phone: "[redacted-phone]",
    });
    expect(redactErrorMessage(new Error("Bearer abc +6591234567"))).toBe(
      "Bearer [redacted] [redacted-phone]",
    );
    expect(redactErrorMessage("https://graph.test/me?access_token=abc123&ok=1")).toBe(
      "https://graph.test/me?access_token=[redacted]&ok=1",
    );

    warn.mockRestore();
  });
});
