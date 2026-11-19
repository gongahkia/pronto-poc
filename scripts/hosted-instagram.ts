import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

type HostedCommand = { name: "web" | "worker"; args: string[]; env: NodeJS.ProcessEnv };
type SpawnChild = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: "inherit" }) => ChildProcess;
type HostedEvent = { event: string; component?: string };

export function hostedInstagramCommands(env: NodeJS.ProcessEnv): HostedCommand[] {
  if (env.NODE_ENV !== "production" || env.PRONTO_HOSTED_INSTAGRAM !== "1" ||
      env.PRONTO_DEPLOYMENT_PROFILE !== "standard" ||
      env.PRONTO_CUSTOMER_DEMO_ENABLED !== "0" || env.PRONTO_DEMO_ONLY_DELIVERY !== "0" ||
      env.PRONTO_USE_MOCK_AI !== "0" ||
      env.PRONTO_CHOPE_LIVE_READS !== "0" || env.CHOPE_LIVE_READ_APPROVED !== "0" ||
      env.PRONTO_DISABLE_TENANT_SQL_GATE === "1" || env.PRONTO_TEST_DATABASE_URL ||
      !["0", "1"].includes(env.PRONTO_HOSTED_INSTAGRAM_WORKER ?? ""))
    throw new Error("Hosted Instagram requires its explicit isolated production configuration.");
  const origin = new URL(env.APP_BASE_URL ?? "");
  const database = new URL(env.DATABASE_URL ?? "");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      !["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname.endsWith(".neon.tech") ||
      database.pathname !== "/pronto_instagram" || !database.username || !database.password ||
      database.searchParams.get("sslmode") !== "verify-full")
    throw new Error("Hosted Instagram requires HTTPS and its separate Neon database with verified TLS.");
  for (const name of ["AUTH_SECRET", "PRONTO_SECRETS_KEY"]) {
    const value = env[name] ?? "";
    if (value.length < 32 || new Set(value).size < 12 || /placeholder|change-me|replace-with/i.test(value))
      throw new Error("Hosted Instagram requires strong private authentication and encryption keys.");
  }
  const port = env.PORT || "10000";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("Invalid hosted application port.");
  return [
    { name: "web", args: ["--max-old-space-size=192", ".next/standalone/server.js"],
      env: { ...env, HOSTNAME: "0.0.0.0", PORT: port } },
    ...(env.PRONTO_HOSTED_INSTAGRAM_WORKER === "1"
      ? [{ name: "worker" as const, args: ["--max-old-space-size=128", "--import", "tsx", "scripts/worker.ts"], env }]
      : []),
  ];
}

export function superviseHostedInstagram(commands: HostedCommand[], {
  spawnChild = spawn, shutdownMs = 30000, report = event => console.log(JSON.stringify(event)),
}: { spawnChild?: SpawnChild; shutdownMs?: number; report?: (event: HostedEvent) => void } = {}) {
  const children = new Set<ChildProcess>();
  let stopping = false, exitCode = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: (value: number) => void;
  const done = new Promise<number>(resolve => { resolveDone = resolve; });
  const finish = () => {
    if (stopping && children.size === 0) { clearTimeout(timer); resolveDone(exitCode); }
  };
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const child of children) child.kill("SIGTERM");
    timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, shutdownMs);
    finish();
  };
  for (const command of commands) {
    try {
      const child = spawnChild(process.execPath, command.args, { env: command.env, stdio: "inherit" });
      children.add(child);
      child.once("error", () => {
        report({ event: "hosted_instagram.child_failed", component: command.name });
        children.delete(child); stop(1); finish();
      });
      child.once("exit", code => {
        children.delete(child);
        report({ event: "hosted_instagram.child_stopped", component: command.name });
        if (!stopping) stop(code || 1);
        finish();
      });
    } catch {
      report({ event: "hosted_instagram.child_failed", component: command.name });
      stop(1); break;
    }
  }
  if (!commands.some(command => command.name === "worker"))
    report({ event: "hosted_instagram.worker_disabled" });
  return { done, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const service = superviseHostedInstagram(hostedInstagramCommands(process.env));
    const shutdown = () => service.stop();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    process.exitCode = await service.done;
  } catch {
    console.error(JSON.stringify({ event: "hosted_instagram.configuration_failed" }));
    process.exitCode = 1;
  }
}
