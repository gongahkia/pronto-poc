import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getSessionUser: vi.fn(), assertDemoActor: vi.fn(), createDemoSession: vi.fn(),
  getDemoState: vi.fn(), sendDemoMessage: vi.fn(), retryDemoProcessing: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/customer-demo", () => mocks);
import { GET, POST } from "@/app/api/demo/customer/route";
import { DemoError } from "@/lib/customer-demo-boundary";
const request = (body: unknown, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/demo/customer", {
  method: "POST", headers: { origin, host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.getSessionUser.mockResolvedValue({ userId: "actor" });
  mocks.sendDemoMessage.mockResolvedValue({ jobId: "job" }); });
afterEach(() => vi.unstubAllEnvs());
describe("authenticated customer demo API", () => {
  it("rejects reads and writes before authentication when the simulator is retired", async () => {
    vi.stubEnv("PRONTO_CUSTOMER_SIMULATOR_ENABLED", "0");
    expect((await GET(new Request("http://localhost:3000/api/demo/customer"))).status).toBe(404);
    expect((await POST(request({action:"create",mode:"real",choice:"groq-oss"}))).status).toBe(404);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.createDemoSession).not.toHaveBeenCalled();
  });
  it("rejects anonymous reads and writes", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost:3000/api/demo/customer"))).status).toBe(401);
    expect((await POST(request({ action: "create", mode: "mock" }))).status).toBe(401);
    expect(mocks.createDemoSession).not.toHaveBeenCalled();
  });
  it("rejects cross-origin mutations and unapproved tenant identities", async () => {
    expect((await POST(request({}, "https://untrusted.example"))).status).toBe(403);
    mocks.assertDemoActor.mockRejectedValue(new DemoError("Forbidden.", 403));
    expect((await POST(request({ action: "create", mode: "mock" }))).status).toBe(403);
  });
  it("surfaces real-AI configuration failure rather than creating a mock session", async () => {
    mocks.createDemoSession.mockRejectedValue(new DemoError("Configure GROQ_API_KEY securely on the server.", 503));
    const response = await POST(request({ action: "create", mode: "real" }));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "Configure GROQ_API_KEY securely on the server." });
    expect(mocks.createDemoSession).toHaveBeenCalledWith(expect.anything(), "real");
  });
  it.each([{ mode: "mock", choice: "mock" }, { mode: "real", choice: "mock" }, { mode: "real", choice: "configured" }])(
    "rejects simulated and generic configured conversations: %o", async selection => {
      expect((await POST(request({ action: "create", ...selection }))).status).toBe(400);
      expect(mocks.createDemoSession).not.toHaveBeenCalled();
    },
  );
  it("passes only bounded synthetic send fields and reports malformed requests", async () => {
    expect((await POST(request({ action: "send", sessionId: "a", requestId: "b", text: "Hello" }))).status).toBe(202);
    expect(mocks.sendDemoMessage).toHaveBeenCalledWith(expect.anything(), { sessionId: "a", requestId: "b", text: "Hello" });
    expect((await POST(request({ text: "x".repeat(17000) }))).status).toBe(413);
    expect((await POST(request({ action: "activate_instagram" }))).status).toBe(400);
  });
  it("does not accept client supplied models/endpoints and forwards only the selected choice",async()=>{
    expect((await POST(request({action:"create",mode:"real",choice:"gemini-flash",model:"paid",baseUrl:"https://evil.invalid"}))).status).toBe(400);
    expect(mocks.createDemoSession).not.toHaveBeenCalled();
    mocks.createDemoSession.mockResolvedValue({id:"synthetic"});
    expect((await POST(request({action:"create",mode:"real",choice:"groq-oss"}))).status).toBe(201);
    expect(mocks.createDemoSession).toHaveBeenCalledWith(expect.anything(),"real","groq-oss");
  });
  it("does not return internal failures or raw provider payloads", async () => {
    mocks.getDemoState.mockRejectedValue(new Error("private provider payload"));
    const response = await GET(new Request("http://localhost:3000/api/demo/customer"));
    expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("private provider payload");
  });
});
