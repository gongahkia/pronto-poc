import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  query: mocks.query,
}));

import {
  getClientDashboardAnalytics,
  getFilteredConversations,
} from "@/lib/reporting";

describe("reporting helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes simulated transports even when a browser asks for them", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getFilteredConversations({clientId:"business",externalOnly:true,channelKind:"console"});
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("ch.kind <> 'console'");
    expect(params[0]).toBe("business");
  });
  it("builds filtered conversation queries with safe parameters", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await getFilteredConversations({
      clientId: "client-1",
      query: " Alicia ",
      channelKind: "whatsapp",
      status: "escalated",
      reasonCode: "low_retrieval_confidence",
      from: "2026-06-01",
      to: "2026-06-05",
      limit: 20,
    });

    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("c.customer_name ilike");
    expect(sql).toContain("ch.kind = $3::channel_kind");
    expect(sql).toContain("c.status = $4::conversation_status");
    expect(sql).toContain("ae.reason_code = $5");
    expect(params).toEqual([
      "client-1",
      "%Alicia%",
      "whatsapp",
      "escalated",
      "low_retrieval_confidence",
      "2026-06-01",
      "2026-06-05",
      20,
      0,
    ]);
  });

  it("accepts v2 channel kinds in conversation filters", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await getFilteredConversations({ channelKind: "messenger", limit: 10, offset: 20 });

    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("ch.kind = $1::channel_kind");
    expect(sql).toContain("offset $3");
    expect(params).toEqual(["messenger", 10, 20]);
  });

  it("summarizes client analytics from existing tables", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ conversations: "10", escalated: "3" }] })
      .mockResolvedValueOnce({ rows: [{ count: "2" }] })
      .mockResolvedValueOnce({ rows: [{ seconds: "120" }] })
      .mockResolvedValueOnce({ rows: [{ average: "4.5", count: "6" }] });

    const result = await getClientDashboardAnalytics("client-1");

    expect(result).toMatchObject({
      conversationCount: 10,
      escalatedConversationCount: 3,
      escalationRate: 0.3,
      actionableEscalations: 2,
      avgFirstResponseSeconds: 120,
      csatAverage: 4.5,
      csatResponses: 6,
    });
  });

});
