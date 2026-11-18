import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withInstagramSubscriptionLock } from "../../scripts/instagram-subscription-lock";
import type { InstagramSubscriptionReport } from "@/lib/channels/instagram-subscription";

const env = { PRONTO_INSTAGRAM_TEST_APP_ID: "12345", PRONTO_INSTAGRAM_TEST_ACCOUNT_ID: "67890" };
const done: InstagramSubscriptionReport = { status: "subscribed", messagesSubscribed: true,
  mutationAttempted: true, callbackVerified: true, detail: "Fixture complete." };
const directories: string[] = [];
async function root() { const directory = await mkdtemp(join(tmpdir(), "pronto-subscription-lock-")); directories.push(directory); return directory; }
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("local Instagram subscription concurrency guard", () => {
  it("runs one operation per app/account while another invocation receives a busy result", async () => {
    const project = await root();
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const perform = vi.fn(async () => { started(); await blocked; return done; });
    const first = withInstagramSubscriptionLock(env, perform, { project });
    try {
      await entered;
      expect(await withInstagramSubscriptionLock(env, perform, { project })).toMatchObject({ status: "failed", mutationAttempted: false });
      expect(perform).toHaveBeenCalledTimes(1);
    } finally { release(); await first; }
    expect((await withInstagramSubscriptionLock(env, async () => done, { project })).status).toBe("subscribed");
  });

  it("does not serialize unrelated accounts behind one account's operation", async () => {
    const project = await root();
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const first = withInstagramSubscriptionLock(env, async () => { started(); await blocked; return done; }, { project });
    try {
      await entered;
      expect((await withInstagramSubscriptionLock({ ...env, PRONTO_INSTAGRAM_TEST_ACCOUNT_ID: "99999" }, async () => done, { project })).status).toBe("subscribed");
    } finally { release(); await first; }
  });

  it("persists uncertainty across invocations and only reconciles read-confirmed success", async () => {
    const project = await root();
    await withInstagramSubscriptionLock(env, async () => ({ ...done, status: "uncertain" }), { project });
    const attempt = vi.fn(async () => done);
    expect((await withInstagramSubscriptionLock(env, attempt, { project })).status).toBe("failed");
    expect(attempt).not.toHaveBeenCalled();
    expect((await withInstagramSubscriptionLock(env, async () => ({ ...done, status: "inspected", messagesSubscribed: false,
      mutationAttempted: false }), { project, reconcile: true })).status).toBe("failed");
    expect((await withInstagramSubscriptionLock(env, attempt, { project })).status).toBe("failed");
    await withInstagramSubscriptionLock(env, async () => ({ ...done, status: "inspected", mutationAttempted: false }), { project, reconcile: true });
    expect((await withInstagramSubscriptionLock(env, attempt, { project })).status).toBe("subscribed");
    const directory = join(project, "output/instagram-setup/operations"), files = await readdir(directory);
    expect(files.every(file => file.endsWith(".json"))).toBe(true);
    expect(JSON.parse(await readFile(join(directory, files[0]), "utf8")).status).toBe("finished");
  });

  it("retains an unresolved record after an unexpected exception instead of automatically repeating the operation", async () => {
    const project = await root();
    expect((await withInstagramSubscriptionLock(env, async () => { throw new Error("private-token-never-display"); }, { project })).status).toBe("uncertain");
    const attempt = vi.fn(async () => done);
    expect((await withInstagramSubscriptionLock(env, attempt, { project })).status).toBe("failed");
    expect(attempt).not.toHaveBeenCalled();
  });
});
