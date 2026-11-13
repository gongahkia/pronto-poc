import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  query: mocks.query,
  transaction: mocks.transaction,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

import {
  bulkAssignEscalations,
  bulkClaimEscalations,
  bulkResolveEscalations,
} from "@/lib/escalations-bulk";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("bulk escalation actions", () => {
  it("claims open escalations for a client", async () => {
    const txClient = {
      query: vi.fn().mockResolvedValue({rows:[],rowCount:0}).mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({
        rows: [{ id: "esc-1" }, { id: "esc-2" }],
        rowCount: 2,
      }),
    };
    mocks.transaction.mockImplementation(async (cb) => cb(txClient));

    const result = await bulkClaimEscalations({
      escalationIds: ["esc-1", "esc-2", "esc-1"],
      clientId: "client-1",
      actorUserId: "user-1",
    });
    expect(result.attempted).toBe(2);
    expect(result.applied).toBe(2);
    expect(txClient.query).toHaveBeenCalledWith(
      expect.stringContaining("set status = 'claimed'"),
      expect.arrayContaining(["client-1", "user-1"]),
    );
    expect(mocks.recordAuditLog).toHaveBeenCalledTimes(2);
  });

  it("rejects assignments to a non-client user", async () => {
    const txClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    };
    mocks.transaction.mockImplementation(async (cb) => cb(txClient));

    const result = await bulkAssignEscalations({
      escalationIds: ["esc-1"],
      clientId: "client-1",
      assigneeUserId: "user-bad",
      actorUserId: "user-1",
    });
    expect(result.applied).toBe(0);
    expect(result.skipped).toEqual(["esc-1"]);
  });

  it("closes conversations when resolving", async () => {
    const txClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ id: "esc-1", conversation_id: "conv-1" }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    };
    mocks.transaction.mockImplementation(async (cb) => cb(txClient));

    const result = await bulkResolveEscalations({
      escalationIds: ["esc-1"],
      clientId: "client-1",
      actorUserId: "user-1",
    });
    expect(result.applied).toBe(1);
    expect(txClient.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("c.client_id=$2"),
      [["conv-1"], "client-1"],
    );
  });
});
