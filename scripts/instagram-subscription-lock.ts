import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { InstagramSubscriptionReport } from "../src/lib/channels/instagram-subscription";
import { instagramSetupDirectory, readPrivateInstagramSetup } from "./instagram-setup-files";

type State = { schema: "pronto.instagram-operation.v1"; key: string;
  status: "in_progress" | "uncertain" | "finished"; updatedAt: string };
const failed = (detail: string): InstagramSubscriptionReport => ({ status: "failed", messagesSubscribed: false,
  mutationAttempted: false, callbackVerified: false, detail });

export async function withInstagramSubscriptionLock(env: Record<string, string | undefined>,
  perform: () => Promise<InstagramSubscriptionReport>, options: { project?: string; reconcile?: boolean } = {}) {
  const appId = env.PRONTO_INSTAGRAM_TEST_APP_ID?.trim(), accountId = env.PRONTO_INSTAGRAM_TEST_ACCOUNT_ID?.trim();
  if (!appId || !accountId || !/^\d+$/.test(appId) || !/^\d+$/.test(accountId)) return failed("Configure the exact test app and account IDs.");
  const directory = join(await instagramSetupDirectory(options.project), "operations");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== process.getuid?.() || directoryStat.mode & 0o077)
    throw new Error("Instagram operations directory must be owned, private and not a symlink.");
  const key = createHash("sha256").update(`${appId}:${accountId}`).digest("hex"), lockPath = join(directory, `${key}.lock`);
  const statePath = join(directory, `${key}.json`);
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
      return failed("Another local subscription operation holds the lock. Inspect/reconcile a crashed process before removing a stale lock.");
    throw error;
  }
  const owned = await lock.stat();
  const save = async (status: State["status"]) => {
    const temporary = join(directory, `.${key}-${randomUUID()}`), file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ schema: "pronto.instagram-operation.v1", key, status, updatedAt: new Date().toISOString() } satisfies State));
      await file.close(); await rename(temporary, statePath);
    } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let state: unknown;
    try { state = await readPrivateInstagramSetup(statePath); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
    if (state !== undefined && (!state || typeof state !== "object" || (state as State).schema !== "pronto.instagram-operation.v1" ||
      (state as State).key !== key || !["in_progress", "uncertain", "finished"].includes((state as State).status)))
      return failed("Local subscription state is invalid; inspect it before proceeding.");
    if (state && (state as State).status !== "finished" && !options.reconcile)
      return failed("A prior local subscription attempt is unresolved. Run inspect, then reconcile confirmed success before retrying.");
    if (!options.reconcile) await save("in_progress");
    let result: InstagramSubscriptionReport;
    try { result = await perform(); }
    catch {
      if (!options.reconcile) await save("uncertain");
      return { ...failed("Subscription operation ended unexpectedly. Inspect before retrying."), status: "uncertain" as const };
    }
    if (options.reconcile) {
      if (result.status === "inspected" && result.messagesSubscribed) { await save("finished"); return result; }
      return failed("Inspection did not confirm an enabled messages subscription. Uncertain state is retained for manual reconciliation.");
    }
    await save(result.status === "uncertain" ? "uncertain" : "finished");
    return result;
  } finally {
    await lock.close();
    if ((await lstat(lockPath)).ino === owned.ino) await unlink(lockPath);
  }
}
