import { randomBytes } from "node:crypto";
import { isGraphObject, requestInstagramGraph } from "./instagram-graph";
import { validateInstagramConnection } from "./instagram-setup";
import { checkInstagramTestCredentials } from "./instagram-smoke";

export type InstagramSubscriptionReport = {
  status: "inspected" | "subscribed" | "failed" | "uncertain";
  messagesSubscribed: boolean; mutationAttempted: boolean; callbackVerified: boolean; detail: string;
};

export async function manageInstagramSubscription(env: Record<string, string | undefined>, setup: unknown,
  options: { subscribe?: boolean; fetchFn?: typeof fetch } = {}): Promise<InstagramSubscriptionReport> {
  const report: InstagramSubscriptionReport = { status: "failed", messagesSubscribed: false,
    mutationAttempted: false, callbackVerified: false, detail: "Instagram setup could not be validated." };
  let connection: ReturnType<typeof validateInstagramConnection>;
  try { connection = validateInstagramConnection(setup); } catch { return report; }
  if (connection.appId !== env.PRONTO_INSTAGRAM_TEST_APP_ID?.trim() ||
      connection.accountId !== env.PRONTO_INSTAGRAM_TEST_ACCOUNT_ID?.trim()) {
    report.detail = "Setup file and environment identify different apps or accounts."; return report;
  }
  if (options.subscribe && env.PRONTO_META_SUBSCRIBE_APPROVED !== "1") {
    report.detail = "Account subscription requires PRONTO_META_SUBSCRIBE_APPROVED=1."; return report;
  }
  const smoke = await checkInstagramTestCredentials(env, { live: true, fetchFn: options.fetchFn });
  if (smoke.status !== "passed") { report.detail = "Credential/read-authorization check failed; run instagram:smoke --read for sanitized details."; return report; }
  const request = (form?: Record<string, string>) => requestInstagramGraph({
    version: env.META_GRAPH_VERSION?.trim() || "v25.0", path: `${connection.accountId}/subscribed_apps`,
    token: env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN!.trim(), fetchFn: options.fetchFn,
    ...(form ? { form } : { query: { fields: "id,subscribed_fields", limit: "100" } }),
  });
  const inspect = async () => {
    const response = await request();
    if (!response.ok) return { ok: false as const, detail: response.detail };
    if (!Array.isArray(response.body.data) || response.body.data.some(item => !isGraphObject(item) || typeof item.id !== "string"))
      return { ok: false as const, detail: "Meta returned an invalid subscription list." };
    const own = response.body.data.filter(item => item.id === connection.appId);
    if (own.length > 1 || !own.length && isGraphObject(response.body.paging) && response.body.paging.next)
      return { ok: false as const, detail: "Subscription results are ambiguous or incomplete; no changes made." };
    const fields: unknown = own[0]?.subscribed_fields ?? (own.length ? null : []);
    if (!Array.isArray(fields) || !fields.every(field => typeof field === "string" && /^[a-z_]{1,80}$/.test(field)))
      return { ok: false as const, detail: "Meta did not return interpretable subscribed fields; cannot safely preserve them." };
    return { ok: true as const, fields: fields as string[] };
  };
  const before = await inspect();
  if (!before.ok) { report.detail = before.detail; return report; }
  report.messagesSubscribed = before.fields.includes("messages");
  if (!options.subscribe || report.messagesSubscribed) {
    report.status = "inspected";
    report.detail = report.messagesSubscribed ? "This app is subscribed to account messages; live delivery remains unverified."
      : "This app is not subscribed to account messages. No changes made.";
    return report;
  }
  const callback = new URL(connection.callbackUrl), challenge = randomBytes(16).toString("hex");
  callback.searchParams.set("hub.mode", "subscribe");
  callback.searchParams.set("hub.verify_token", connection.verifyToken);
  callback.searchParams.set("hub.challenge", challenge);
  try {
    // only the verify token goes to the pinned callback; never send Meta credentials.
    const response = await (options.fetchFn ?? fetch)(callback, { method: "GET", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(8_000) });
    if (!response.ok || await response.text() !== challenge) {
      report.detail = "Callback verification failed; no subscription attempted."; return report;
    }
    report.callbackVerified = true;
  } catch { report.detail = "Callback could not be verified; no subscription attempted."; return report; }
  report.mutationAttempted = true;
  const applied = await request({ subscribed_fields: [...new Set([...before.fields, "messages"])].join(",") });
  if (!applied.ok) {
    report.status = applied.uncertain ? "uncertain" : "failed";
    report.detail = applied.detail; return report;
  }
  if (applied.body.success !== true) {
    report.status = "uncertain"; report.detail = "Meta did not confirm subscription success. Inspect before any retry."; return report;
  }
  const after = await inspect();
  if (!after.ok || !after.fields.includes("messages")) {
    report.status = "uncertain"; report.detail = "Subscription request was accepted but read-back did not confirm messages. Inspect before any retry."; return report;
  }
  report.status = "subscribed"; report.messagesSubscribed = true;
  report.detail = "Account messages subscription confirmed. Pronto channel activation and live DM delivery remain separate.";
  return report;
}
