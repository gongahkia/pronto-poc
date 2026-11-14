import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  query: vi.fn(),
  verifyPassword: vi.fn(),
  recordAuditLog: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@/lib/db", () => ({
  query: mocks.query,
}));

vi.mock("@/lib/password", () => ({
  verifyPassword: mocks.verifyPassword,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

import { login,getSessionUserFromToken } from "@/lib/auth";
import {encodeSession} from "@/lib/session-token";

describe("auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue({
      set: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed when production uses the local default auth secret", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "local-dev-secret-change-me");
    mocks.query.mockResolvedValueOnce({ rows: [userRecord()] });
    mocks.verifyPassword.mockResolvedValueOnce(true);

    await expect(login("owner@example.com", "password")).rejects.toThrow(
      "AUTH_SECRET must be set",
    );
    expect(mocks.recordAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.login_succeeded" }),
    );
  });

  it("revalidates a captured session outside the Next request scope and derives identity from the current database row",async () => {
    mocks.cookies.mockRejectedValue(new Error('Outside request scope'));
    const token=encodeSession({userId:'user-1',email:'cached@example.test',name:'Cached name',role:'operator',clientId:null,sv:7,exp:Math.floor(Date.now()/1000)+60});
    mocks.query.mockResolvedValueOnce({rows:[userRecord()]}).mockResolvedValueOnce({rows:[]});
    expect(await getSessionUserFromToken(token)).toEqual({userId:'user-1',email:'owner@example.com',name:'Owner',role:'client',clientId:'client-1'});
    expect(mocks.query.mock.calls[0]).toEqual(['select * from users where id = $1 and session_version = $2',['user-1',7]]);
    expect(await getSessionUserFromToken(token)).toBeNull();expect(mocks.query).toHaveBeenCalledTimes(2);expect(mocks.cookies).not.toHaveBeenCalled();
  });
  it("rejects absent, expired and tampered captured cookies before querying the database",async () => {
    const expired=encodeSession({userId:'user-1',email:'owner@example.com',name:'Owner',role:'client',clientId:'client-1',sv:1,exp:1});
    expect(await getSessionUserFromToken(undefined)).toBeNull();expect(await getSessionUserFromToken(expired)).toBeNull();expect(await getSessionUserFromToken(expired+'invalid')).toBeNull();expect(mocks.query).not.toHaveBeenCalled();
  });
  it("audits login failures for unknown users", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const result = await login("missing@example.com", "password");

    expect(result).toBeNull();
    expect(mocks.recordAuditLog).toHaveBeenCalledWith({
      clientId: null,
      actorUserId: null,
      action: "auth.login_failed",
      targetType: "user",
      metadata: {
        email: "missing@example.com",
        reason: "user_not_found",
      },
    });
  });
});

function userRecord() {
  return {
    id: "user-1",
    client_id: "client-1",
    email: "owner@example.com",
    name: "Owner",
    role: "client",
    password_hash: "hash",
    session_version: 1,
    created_at: new Date(),
  };
}
