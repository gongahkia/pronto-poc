// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostedInstagramCommands, superviseHostedInstagram } from "../../scripts/hosted-instagram";

const env = {
  NODE_ENV: "production" as const, PRONTO_HOSTED_INSTAGRAM: "1", PRONTO_HOSTED_INSTAGRAM_WORKER: "0",
  PRONTO_DEPLOYMENT_PROFILE: "standard", PRONTO_CUSTOMER_DEMO_ENABLED: "0", PRONTO_DEMO_ONLY_DELIVERY: "0",
  PRONTO_HUDDLE_ENABLED: "0", PRONTO_USE_MOCK_AI: "0", PRONTO_CHOPE_LIVE_READS: "0", CHOPE_LIVE_READ_APPROVED: "0",
  APP_BASE_URL: "https://instagram.example.test", DATABASE_URL: "postgres://runtime:private@unit.neon.tech/pronto_instagram?sslmode=verify-full",
  AUTH_SECRET: "unit-authentication-key-1234567890-abcdef", PRONTO_SECRETS_KEY: "unit-encryption-key-1234567890-abcdef",
};
afterEach(() => vi.useRealTimers());

describe("hosted Instagram process configuration", () => {
  it("starts only the web process until the worker is explicitly enabled", () => {
    expect(hostedInstagramCommands(env).map(command => command.name)).toEqual(["web"]);
    expect(hostedInstagramCommands({ ...env, PRONTO_HOSTED_INSTAGRAM_WORKER: "1" }).map(command => command.name))
      .toEqual(["web", "worker"]);
  });

  it.each([
    { PRONTO_HOSTED_INSTAGRAM: "0" }, { PRONTO_DEPLOYMENT_PROFILE: "protected-demo" },
    { PRONTO_CUSTOMER_DEMO_ENABLED: "1" }, { PRONTO_DEMO_ONLY_DELIVERY: "1" },
    { PRONTO_TEST_DATABASE_URL: env.DATABASE_URL }, { PRONTO_HOSTED_INSTAGRAM_WORKER: "yes" },
    { DATABASE_URL: "postgres://runtime:private@unit.neon.tech/pronto_instagram?sslmode=require" },
    { DATABASE_URL: "postgres://runtime:private@unit.neon.tech/pronto_test?sslmode=verify-full" },
    { APP_BASE_URL: "http://instagram.example.test" }, { AUTH_SECRET: "change-me" }, { PORT: "0" },
  ])("rejects unsafe deployment settings: %j", changes => {
    expect(() => hostedInstagramCommands({ ...env, ...changes })).toThrow();
  });

  it("uses the assigned port and bounded heaps without enabling a demo", () => {
    const [web, worker] = hostedInstagramCommands({ ...env, PORT: "12345", PRONTO_HOSTED_INSTAGRAM_WORKER: "1" });
    expect(web.env).toMatchObject({ HOSTNAME: "0.0.0.0", PORT: "12345", PRONTO_CUSTOMER_DEMO_ENABLED: "0" });
    expect(web.args).toContain("--max-old-space-size=192");
    expect(worker.args).toContain("--max-old-space-size=128");
  });
});

describe("hosted Instagram process supervision", () => {
  function fakeChild() { return Object.assign(new EventEmitter(), { kill: vi.fn() }); }

  it("stops the web process when the worker fails and returns a failure", async () => {
    const web = fakeChild(), worker = fakeChild(), report = vi.fn();
    const spawnChild = vi.fn().mockReturnValueOnce(web).mockReturnValueOnce(worker);
    const service = superviseHostedInstagram(hostedInstagramCommands({ ...env, PRONTO_HOSTED_INSTAGRAM_WORKER: "1" }), { spawnChild, report });
    worker.emit("exit", 7);
    expect(web.kill).toHaveBeenCalledWith("SIGTERM");
    web.emit("exit", 0);
    await expect(service.done).resolves.toBe(7);
    expect(JSON.stringify(report.mock.calls)).not.toContain("postgres://");
  });

  it("stops an already running web process if spawning the worker fails", async () => {
    const web = fakeChild();
    const spawnChild = vi.fn().mockReturnValueOnce(web).mockImplementationOnce(() => { throw new Error("private spawn error"); });
    const report = vi.fn();
    const service = superviseHostedInstagram(hostedInstagramCommands({ ...env, PRONTO_HOSTED_INSTAGRAM_WORKER: "1" }), { spawnChild, report });
    expect(web.kill).toHaveBeenCalledWith("SIGTERM");
    web.emit("exit", 0);
    await expect(service.done).resolves.toBe(1);
    expect(JSON.stringify(report.mock.calls)).not.toContain("private spawn error");
  });

  it("handles an asynchronous spawn failure without hanging", async () => {
    const web = fakeChild();
    const service = superviseHostedInstagram(hostedInstagramCommands(env), { spawnChild: vi.fn().mockReturnValue(web), report: vi.fn() });
    web.emit("error", new Error("private failure"));
    await expect(service.done).resolves.toBe(1);
  });

  it("gives both processes time to stop, then kills a stuck child", async () => {
    vi.useFakeTimers();
    const web = fakeChild(), worker = fakeChild();
    const spawnChild = vi.fn().mockReturnValueOnce(web).mockReturnValueOnce(worker);
    const service = superviseHostedInstagram(hostedInstagramCommands({ ...env, PRONTO_HOSTED_INSTAGRAM_WORKER: "1" }), { spawnChild, report: vi.fn(), shutdownMs: 100 });
    service.stop();
    expect(worker.kill).toHaveBeenCalledWith("SIGTERM");
    web.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.kill).toHaveBeenCalledWith("SIGKILL");
    worker.emit("exit", null);
    await expect(service.done).resolves.toBe(0);
  });
});
