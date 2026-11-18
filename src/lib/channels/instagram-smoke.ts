import { isSupportedMetaGraphVersion } from "@/lib/env";
import { isGraphObject as record, requestInstagramGraph } from "./instagram-graph";

const requiredFields = [
  "PRONTO_INSTAGRAM_TEST_ACCOUNT_ID", "PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN",
  "PRONTO_INSTAGRAM_TEST_APP_ID", "PRONTO_INSTAGRAM_TEST_APP_SECRET",
] as const;
const requiredPermissions = ["instagram_basic", "instagram_manage_messages"];

type Check = { name: string; status: "pass" | "fail" | "unknown"; detail: string };
export type InstagramSmokeReport = {
  mode: "inspect" | "read";
  status: "configured" | "passed" | "failed";
  checks: Check[];
  limitations: string[];
};

// this checker never opens a database, starts inference, or sends a message.
export async function checkInstagramTestCredentials(
  env: Record<string, string | undefined>,
  options: { live?: boolean; fetchFn?: typeof fetch; now?: number } = {},
): Promise<InstagramSmokeReport> {
  const report: InstagramSmokeReport = {
    mode: options.live ? "read" : "inspect", status: "failed", checks: [],
    limitations: ["This check does not verify webhook delivery, DM sending, App Review, or Pronto channel activation."],
  };
  const add = (name: string, passed: boolean, detail: string) => {
    report.checks.push({ name, status: passed ? "pass" : "fail", detail });
    return passed;
  };
  for (const key of requiredFields) {
    const value = env[key]?.trim();
    const valid = Boolean(value && !/\s|replace-with|placeholder|^<.*>$/i.test(value) &&
      (!key.endsWith("_ID") || /^\d+$/.test(value)));
    add(key, valid, valid ? "Present; value withheld." : "Missing, placeholder, or invalid format.");
  }
  const version = env.META_GRAPH_VERSION?.trim() || "v25.0";
  add("Graph version", isSupportedMetaGraphVersion(version),
    isSupportedMetaGraphVersion(version) ? `Configured ${version}; provider acceptance checked only in read mode.` : "Invalid or unsupported Graph version.");
  for (const key of ["PRONTO_INSTAGRAM_TEST_CONFIG_ID", "PRONTO_INSTAGRAM_TEST_BUSINESS_ID"]) {
    add(key, !env[key]?.trim() || /^\d+$/.test(env[key]!.trim()),
      env[key]?.trim() ? "Optional ID supplied; value withheld." : "Optional for this smoke check; not supplied.");
  }
  if (report.checks.some(check => check.status === "fail")) return report;
  if (!options.live) {
    report.status = "configured";
    report.limitations.push("Local presence/format checks only; token validity and permissions remain unverified.");
    return report;
  }
  if (!add("Read authorization", env.PRONTO_META_TEST_ACCOUNT === "1" &&
    env.PRONTO_META_READ_APPROVED === "1" && env.PRONTO_SKIP_LIVE_HEALTH !== "1",
    "Read mode requires PRONTO_META_TEST_ACCOUNT=1, PRONTO_META_READ_APPROVED=1, and live health checks enabled.")) return report;

  const token = env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN!.trim();
  const appId = env.PRONTO_INSTAGRAM_TEST_APP_ID!.trim();
  const accountId = env.PRONTO_INSTAGRAM_TEST_ACCOUNT_ID!.trim();
  const fetchFn = options.fetchFn ?? fetch;
  const get = (path: string, query: Record<string, string>, token: string) =>
    requestInstagramGraph({ version, path, token, query, fetchFn });

  // Meta requires input_token in this endpoint's query; never print the URL/body.
  const debug = await get("debug_token", { input_token: token }, `${appId}|${env.PRONTO_INSTAGRAM_TEST_APP_SECRET!.trim()}`);
  if (!debug.ok) { add("Token inspection", false, debug.detail); return report; }
  const data = record(debug.body.data) ? debug.body.data : {};
  if (!add("Token validity", data.is_valid === true, data.is_valid === true
    ? "Meta reports a valid token." : "Meta did not report a valid token; obtain a valid token from the app setup.")) return report;
  if (!add("Token app", data.app_id === appId, data.app_id === appId
    ? "Token belongs to the configured app." : "Token does not belong to the configured app.")) return report;
  const now = options.now ?? Date.now();
  for (const key of ["expires_at", "data_access_expires_at"]) {
    const expiry = data[key];
    if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry < 0) {
      report.checks.push({ name: key, status: "unknown", detail: "Meta did not provide an interpretable expiry." });
    } else if (!add(key, expiry === 0 || expiry * 1000 > now,
      expiry === 0 ? "Meta reports no scheduled expiry; revocation remains possible." :
        expiry * 1000 > now ? "Reported expiry is in the future." : "Reported expiry is in the past.")) return report;
  }
  const scopes = Array.isArray(data.scopes) ? data.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const missing = requiredPermissions.filter(scope => !scopes.includes(scope));
  if (!add("Messaging permissions", !missing.length, missing.length
    ? `Missing Unified Login permissions: ${missing.join(", ")}.` : "instagram_basic and instagram_manage_messages granted.")) return report;
  const profile = await get(accountId, { fields: "id,username" }, token);
  if (!profile.ok) { add("Account access", false, profile.detail); return report; }
  if (!add("Account access", profile.body.id === accountId, profile.body.id === accountId
    ? "Token can read the configured Instagram account; identity matches." : "Meta returned a different account identity.")) return report;
  report.status = "passed";
  report.limitations.push("These reads do not establish the token's onboarding flow or business-portfolio ownership.");
  return report;
}
