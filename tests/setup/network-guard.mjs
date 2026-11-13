import net from "node:net";

const raw = process.env.PRONTO_TEST_DATABASE_URL;
if (!raw || raw !== process.env.DATABASE_URL) {
  throw new Error("E2E network guard requires the explicit isolated test database URL.");
}
const database = new URL(raw);
if (
  !["localhost", "127.0.0.1", "::1"].includes(database.hostname) ||
  database.pathname !== "/pronto_test" ||
  !database.port
) {
  throw new Error("E2E network guard requires a loopback pronto_test database.");
}

const allowedPorts = new Set([Number(database.port), 3000]);
if (process.env.PRONTO_TEST_LOCAL_MAIL === "1" && process.env.PRONTO_LOCAL_EMAIL_ENABLED === "1") {
  allowedPorts.add(1025);
  allowedPorts.add(8025);
}
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
// Next's build worker uses an ephemeral loopback TCP port for local IPC.
// Build/dev-server children may opt in; the E2E driver itself keeps fixed ports.
const allowBuildIpc = process.env.PRONTO_TEST_ALLOW_BUILD_IPC === "1";
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const target = values[0];
  if (typeof target === "string" || (target && typeof target === "object" && "path" in target)) {
    // Playwright uses local Unix-domain IPC for its browser process.
    return originalConnect.apply(this, args);
  }
  const port = typeof target === "number" ? target :
    target && typeof target === "object" && "port" in target ? Number(target.port) : NaN;
  const host = typeof target === "number" && typeof values[1] === "string" ? values[1] :
    target && typeof target === "object" && "host" in target ? String(target.host) : "localhost";
  if (!loopbackHosts.has(host) || !(allowedPorts.has(port) || (allowBuildIpc && port >= 1024))) {
    throw new Error(`External network blocked by Pronto E2E harness: ${host}:${port}`);
  }
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!loopbackHosts.has(url.hostname) || !allowedPorts.has(Number(url.port))) {
    throw new Error(`External fetch blocked by Pronto E2E harness: ${url.hostname}`);
  }
  return originalFetch(input, init);
};
