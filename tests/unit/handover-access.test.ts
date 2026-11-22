import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), permission: vi.fn(), summary: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.user }));
vi.mock("@/lib/staff-permissions", () => ({ canViewBusinessConversation: mocks.permission }));
vi.mock("@/lib/self-serve/handover-summary", () => ({ getHandoverSummary: mocks.summary }));
import { GET } from "@/app/api/client/handovers/route";
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("PRONTO_SELF_SERVE_ENABLED", "1");
  mocks.user.mockResolvedValue({ role: "client", clientId: "own-business", userId: "owner" });
  mocks.permission.mockResolvedValue(true); mocks.summary.mockResolvedValue({ items: [], hasMore: false });
});
afterEach(() => vi.unstubAllEnvs());
describe("handover list access", () => {
  it("requires the feature, authenticated membership and conversation access", async () => {
    vi.stubEnv("PRONTO_SELF_SERVE_ENABLED", "0"); expect((await GET()).status).toBe(404);
    vi.stubEnv("PRONTO_SELF_SERVE_ENABLED", "1");
    mocks.user.mockResolvedValue(null); expect((await GET()).status).toBe(401);
    mocks.user.mockResolvedValue({ role: "operator", clientId: null }); expect((await GET()).status).toBe(403);
    mocks.user.mockResolvedValue({ role: "client", clientId: "own-business" });
    mocks.permission.mockResolvedValue(false); expect((await GET()).status).toBe(403);
    expect(mocks.summary).not.toHaveBeenCalled();
  });
  it("uses the authenticated business and returns private uncached data", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.summary).toHaveBeenCalledExactlyOnceWith("own-business");
  });
});
