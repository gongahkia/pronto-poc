import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ establish: vi.fn(), create: vi.fn(), query: vi.fn(), enabled: vi.fn() }));
vi.mock("@/lib/auth", () => ({ establishSession: mocks.establish, getSessionUser: vi.fn() }));
vi.mock("@/lib/guest-access", async (original) => ({ ...(await original<typeof import("@/lib/guest-access")>()), createGuestReviewer: mocks.create }));
vi.mock("@/lib/db", () => ({ query: mocks.query, transaction: vi.fn() }));

import { guestAccessEnabled, isGuestEmail } from "@/lib/guest-policy";
import { cleanGuestName } from "@/lib/guest-access";
import { encodeSession } from "@/lib/session-token";
import { proxy } from "@/proxy";
import { POST } from "@/app/api/auth/guest/route";
import { DemoError } from "@/lib/customer-demo-boundary";

const secret = "test-auth-secret-with-more-than-32-characters-x";
const cookie = (email: string) => `pronto_session=${encodeSession({ userId: "u1", email, name: "Keith", role: "client", clientId: "c1", exp: Math.floor(Date.now() / 1000) + 3600, sv: 1 })}`;
const req = (path: string, method = "GET", email?: string) => new NextRequest(`http://localhost${path}`, { method, headers: email ? { cookie: cookie(email) } : {} });
const guestEnv = () => { vi.stubEnv("PRONTO_CUSTOMER_DEMO_ENABLED", "1"); vi.stubEnv("AUTH_SECRET", secret); };
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("guest access", () => {
  it("exists only on demo deployments, with no extra switch to set", () => {
    vi.stubEnv("PRONTO_CUSTOMER_DEMO_ENABLED", "");
    expect(guestAccessEnabled()).toBe(false);
    vi.stubEnv("PRONTO_CUSTOMER_DEMO_ENABLED", "1");
    expect(guestAccessEnabled()).toBe(true);
    vi.stubEnv("PRONTO_CUSTOMER_DEMO_ENABLED", "");
    vi.stubEnv("PRONTO_DEPLOYMENT_PROFILE", "protected-demo");
    expect(guestAccessEnabled()).toBe(true);
  });
  it("recognises only reserved guest addresses and cleans names", () => {
    expect(isGuestEmail("guest-1@guest.invalid")).toBe(true);
    expect(isGuestEmail("keith@guest.invalid.example.com")).toBe(false);
    expect(isGuestEmail("owner@example.com")).toBe(false);
    expect(cleanGuestName("  <b>Keith</b>\n  Tan ")).toBe("bKeith/b Tan");
    expect(cleanGuestName("   ")).toBeNull();
    expect(cleanGuestName(42)).toBeNull();
    expect(cleanGuestName("x".repeat(100))).toHaveLength(40);
  });
});

describe("request proxy", () => {
  it("sends visitors without a session to the chooser on a demo deployment, and to sign-in elsewhere", () => {
    guestEnv();
    expect(proxy(req("/client/inbox")).headers.get("location")).toContain("/demo?");
    vi.stubEnv("PRONTO_CUSTOMER_DEMO_ENABLED", "");
    expect(proxy(req("/client/inbox")).headers.get("location")).toContain("/login");
  });
  it('exposes only the exact demo chooser and retains protected screen/API boundaries',()=>{
    guestEnv();expect(proxy(req('/demo')).status).toBe(200);
    expect(proxy(req('/demo/customer')).headers.get('location')).toContain('/demo?');
    expect(proxy(req('/api/demo/customer')).status).toBe(401);
    expect(proxy(req('/api/client/settings')).status).toBe(401);
    vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','');
    expect(proxy(req('/demo')).headers.get('location')).toContain('/login');
  });
  it("treats a guest session like any other signed-in business user", () => {
    guestEnv();
    for (const path of ["/api/client/settings", "/api/client/knowledge", "/api/demo/customer", "/api/demo/feedback"])
      expect(proxy(req(path, "POST", "guest-1@guest.invalid")).status).toBe(200);
  });
});

describe("POST /api/auth/guest", () => {
  const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
  const post = (fields: Record<string, string>) => POST(new Request("http://localhost:3000/api/auth/guest", { method: "POST", headers: { origin: "http://localhost:3000" }, body: form(fields) }));
  it("does not exist outside a demo deployment", async () => { expect((await post({ name: "Keith" })).status).toBe(404); expect(mocks.create).not.toHaveBeenCalled(); });
  it("starts a session and returns to the requested demo page", async () => {
    guestEnv(); mocks.create.mockResolvedValue({ id: "u1" });
    const response = await post({ name: "Keith", next: "/client/knowledge" });
    expect(response.status).toBe(303); expect(response.headers.get("location")).toBe("http://localhost:3000/client/knowledge");
    expect(mocks.establish).toHaveBeenCalledWith({ id: "u1" });
  });
  it('starts either demo view without requiring a name or accepting a supplied account role',async()=>{
    guestEnv();mocks.create.mockResolvedValue({id:'u1',role:'client'});
    for(const next of ['/demo/customer','/client/inbox']){
      const response=await post({next,role:'operator'});
      expect(response.headers.get('location')).toBe('http://localhost:3000'+next);
      expect(mocks.create).toHaveBeenLastCalledWith('Demo reviewer',expect.any(String));
      expect(mocks.establish).toHaveBeenLastCalledWith({id:'u1',role:'client'});
    }
  });
  it("opens the view chooser after name entry with no requested destination",async()=>{
    guestEnv(); mocks.create.mockResolvedValue({id:"u1",role:"client"});
    expect((await post({name:"Keith",role:"operator"})).headers.get("location")).toBe("http://localhost:3000/demo");
    expect(mocks.establish).toHaveBeenCalledWith({id:"u1",role:"client"});
  });
  it("ignores an unsafe return address", async () => {
    guestEnv(); mocks.create.mockResolvedValue({ id: "u1" });
    expect((await post({ name: "Keith", next: "https://evil.example" })).headers.get("location")).toBe("http://localhost:3000/demo");
  });
  it("shows the reason on the chooser when a visitor is refused, and creates no session", async () => {
    guestEnv(); mocks.create.mockRejectedValue(new DemoError("Too many new visitors right now.", 429));
    const response = await post({ name: "Keith" });
    expect(response.status).toBe(303); expect(response.headers.get("location")).toContain("/demo?error=");
    expect(mocks.establish).not.toHaveBeenCalled();
  });
  it("rejects cross-site submissions", async () => {
    guestEnv();
    const response = await POST(new Request("http://localhost:3000/api/auth/guest", { method: "POST", headers: { origin: "https://evil.example" }, body: form({ name: "Keith" }) }));
    expect(response.status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
});
