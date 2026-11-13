import net from "node:net";
import { beforeAll, beforeEach, vi } from "vitest";
import { testDatabaseUrl, verifyTestDatabase } from "../../scripts/test-db-safety";

const dbEnabled = process.env.PRONTO_RUN_DB_TESTS === "1";
let allowedDatabase: URL | null = null;
if (dbEnabled) {
  allowedDatabase = new URL(testDatabaseUrl());
} else {
  // An accidental unmocked query must not use the application's local default.
  process.env.DATABASE_URL = "postgres://blocked:blocked@127.0.0.1:1/pronto_test";
}
process.env.PRONTO_USE_MOCK_AI = "1";
// Existing agent tests drive jobs synchronously; quiet-window tests opt in explicitly.
process.env.PRONTO_DEMO_REPLY_QUIET_MS = "0";

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args: unknown[]) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const target = values[0];
  const port =
    typeof target === "number" ? target :
    target && typeof target === "object" && "port" in target ? Number(target.port) : NaN;
  const host =
    typeof target === "number" && typeof values[1] === "string" ? values[1] :
    target && typeof target === "object" && "host" in target ? String(target.host) : "localhost";
  const allowed = allowedDatabase &&
    port === Number(allowedDatabase.port) &&
    ["localhost", "127.0.0.1", "::1"].includes(host);
  const localMail = process.env.PRONTO_TEST_LOCAL_MAIL === "1" &&
    process.env.PRONTO_LOCAL_EMAIL_ENABLED === "1" && [1025, 8025].includes(port) &&
    ["localhost", "127.0.0.1", "::1"].includes(host);
  if (!allowed && !localMail) {
    throw new Error(`External network blocked by Pronto test harness: ${host}:${port}`);
  }
  return (originalConnect as (...values: unknown[]) => net.Socket).apply(this, args);
};

const blockedFetch = async () => {
  throw new Error("External fetch blocked by Pronto test harness. Inject a fake fetch explicitly.");
};
vi.stubGlobal("fetch", blockedFetch);
// A test may call vi.unstubAllGlobals(); restore the default before the next test.
beforeEach(() => vi.stubGlobal("fetch", blockedFetch));

beforeAll(async () => {
  if (dbEnabled) await verifyTestDatabase();
});
