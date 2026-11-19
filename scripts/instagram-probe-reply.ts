import { parseArgs } from "node:util";
import { readPrivateInstagramSetup } from "./instagram-setup-files";
import { getPool } from "../src/lib/db";
import { runInstagramProbeReply } from "../src/lib/channels/instagram-probe-reply";

try {
  const { values } = parseArgs({ options: {
    "runtime-file": { type: "string" }, "plan-file": { type: "string" }, send: { type: "boolean", default: false },
  } });
  if (!values["runtime-file"] || !values["plan-file"]) throw new Error("Private runtime and plan files required.");
  const runtime = await readPrivateInstagramSetup(values["runtime-file"]) as Record<string, unknown>;
  for (const key of ["DATABASE_URL", "PRONTO_SECRETS_KEY", "PRONTO_HOSTED_INSTAGRAM", "PRONTO_DEPLOYMENT_PROFILE",
    "PRONTO_HOSTED_INSTAGRAM_WORKER"]) {
    if (typeof runtime[key] !== "string") throw new Error("Explicit hosted runtime configuration required.");
    process.env[key] = runtime[key];
  }
  process.env.META_GRAPH_VERSION = typeof runtime.META_GRAPH_VERSION === "string" ? runtime.META_GRAPH_VERSION : "v25.0";
  const database = new URL(process.env.DATABASE_URL!);
  if (database.protocol !== "postgresql:" && database.protocol !== "postgres:" ||
      !database.hostname.endsWith(".neon.tech") || database.pathname !== "/pronto_instagram" ||
      database.searchParams.get("sslmode") !== "verify-full") throw new Error("Verified hosted test database required.");
  const result = await runInstagramProbeReply(await readPrivateInstagramSetup(values["plan-file"]), values.send);
  console.log(JSON.stringify(result, null, 2));
  if (!["ready", "accepted"].includes(result.status)) process.exitCode = 1;
} catch {
  console.error("Probe reply stopped. Check the private plan, current probe and audit trail before proceeding. No automatic retry; credentials and raw errors withheld.");
  process.exitCode = 1;
} finally { await getPool().end(); }
