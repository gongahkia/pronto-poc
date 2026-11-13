import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  logout: vi.fn(),
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
  logout: mocks.logout,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

import { POST } from "@/app/api/auth/logout/route";

describe("logout route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(()=>vi.unstubAllEnvs());

  it('returns a guest reviewer to the chooser on the enabled demo',async()=>{
    vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','1');
    mocks.getSessionUser.mockResolvedValueOnce({userId:'guest',clientId:'demo',role:'client',email:'guest@guest.invalid'});
    const response=await POST(new Request('http://localhost/api/auth/logout',{method:'POST',headers:{origin:'http://localhost',host:'localhost'}}));
    expect(response.headers.get('location')).toBe('http://localhost/demo');
  });

  it("audits logout when a session exists", async () => {
    mocks.getSessionUser.mockResolvedValueOnce({
      userId: "user-1",
      clientId: "client-1",
      role: "client",
      email: 'owner@example.test',
    });

    const response = await POST(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "http://localhost",
        },
      }),
    );

    expect(mocks.recordAuditLog).toHaveBeenCalledWith({
      clientId: "client-1",
      actorUserId: "user-1",
      action: "auth.logout",
      targetType: "user",
      targetId: "user-1",
      metadata: { role: "client" },
    });
    expect(mocks.logout).toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/login");
  });
});
