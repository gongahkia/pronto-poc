import { describe, expect, it, vi } from "vitest";
import { manageInstagramSubscription } from "@/lib/channels/instagram-subscription";
import { prepareInstagramSetup } from "@/lib/channels/instagram-setup";

const env = { PRONTO_INSTAGRAM_TEST_ACCOUNT_ID: "12345", PRONTO_INSTAGRAM_TEST_APP_ID: "67890",
  PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN: "fixture-private-token", PRONTO_INSTAGRAM_TEST_APP_SECRET: "fixture-private-secret",
  PRONTO_META_READ_APPROVED: "1", PRONTO_META_TEST_ACCOUNT: "1", PRONTO_META_SUBSCRIBE_APPROVED: "1" };
const connection = async () => (await prepareInstagramSetup(env, { clientId: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000002", callbackOrigin: "https://test-callback.example" })).connection;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function transport(fields: unknown = ["comments"], override?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) {
  let subscribed = false;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), replaced = override?.(url, init);
    if (replaced) return replaced;
    if (url.host === "test-callback.example") return new Response(url.searchParams.get("hub.challenge"));
    if (url.pathname.endsWith("/debug_token")) return json({ data: { is_valid: true, app_id: "67890", expires_at: 0,
      data_access_expires_at: 0, scopes: ["instagram_basic", "instagram_manage_messages"] } });
    if (url.pathname.endsWith("/12345")) return json({ id: "12345" });
    if (url.pathname.endsWith("/12345/subscribed_apps")) {
      if (init?.method === "POST") { subscribed = true; return json({ success: true }); }
      return json({ data: fields === undefined ? [] : [{ id: "67890", subscribed_fields: subscribed ? ["comments", "messages"] : fields }] });
    }
    throw new Error("Unexpected test request");
  });
}

describe("Instagram account subscription setup", () => {
  it("inspects using only GETs and never calls the callback or sends DMs", async () => {
    const fetchFn = transport();
    const report = await manageInstagramSubscription(env, await connection(), { fetchFn });
    expect(report).toMatchObject({ status: "inspected", messagesSubscribed: false, mutationAttempted: false });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchFn.mock.calls) {
      expect(new URL(String(url)).host).toBe("graph.facebook.com"); expect(init?.method).toBe("GET");
    }
  });

  it("requires explicit mutation approval before any requests", async () => {
    const fetchFn = transport();
    expect(await manageInstagramSubscription({ ...env, PRONTO_META_SUBSCRIBE_APPROVED: "0" }, await connection(), { fetchFn, subscribe: true }))
      .toMatchObject({ status: "failed", mutationAttempted: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("can inspect the environment's exact app/account before a callback is chosen", async () => {
    const fetchFn = transport();
    expect(await manageInstagramSubscription(env, undefined, { fetchFn })).toMatchObject({ status: "inspected", mutationAttempted: false });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    fetchFn.mockClear();
    expect(await manageInstagramSubscription(env, undefined, { fetchFn, subscribe: true })).toMatchObject({ status: "failed", mutationAttempted: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses mixed account/app files and missing read authorization", async () => {
    const fetchFn = transport();
    expect((await manageInstagramSubscription(env, { ...await connection(), appId: "999" }, { fetchFn })).status).toBe("failed");
    expect((await manageInstagramSubscription({ ...env, PRONTO_META_READ_APPROVED: "0" }, await connection(), { fetchFn })).status).toBe("failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("verifies the callback, preserves existing fields and confirms the account subscription", async () => {
    const setup = await connection(), fetchFn = transport();
    const report = await manageInstagramSubscription(env, setup, { fetchFn, subscribe: true });
    expect(report).toMatchObject({ status: "subscribed", callbackVerified: true, mutationAttempted: true, messagesSubscribed: true });
    const mutations = fetchFn.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(mutations).toHaveLength(1);
    const [url, init] = mutations[0];
    expect(String(url)).toBe("https://graph.facebook.com/v25.0/12345/subscribed_apps");
    expect((init?.body as URLSearchParams).get("subscribed_fields")).toBe("comments,messages");
    expect(init?.headers).toEqual({ Authorization: "Bearer fixture-private-token" });
    const [, callbackOptions] = fetchFn.mock.calls.find(([url]) => new URL(String(url)).host === "test-callback.example")!;
    expect(callbackOptions?.headers).toBeUndefined();
    const output = JSON.stringify(report);
    for (const secret of [env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN, env.PRONTO_INSTAGRAM_TEST_APP_SECRET, setup.verifyToken])
      expect(output).not.toContain(secret);
  });

  it("does not repeat a subscription that already includes messages", async () => {
    const fetchFn = transport(["messages", "comments"]);
    expect(await manageInstagramSubscription(env, await connection(), { fetchFn, subscribe: true }))
      .toMatchObject({ status: "inspected", messagesSubscribed: true, mutationAttempted: false });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not mutate after a failed callback challenge", async () => {
    const fetchFn = transport(["comments"], url => url.host === "test-callback.example" ? new Response("wrong") : undefined);
    expect(await manageInstagramSubscription(env, await connection(), { fetchFn, subscribe: true }))
      .toMatchObject({ status: "failed", mutationAttempted: false, callbackVerified: false });
    expect(fetchFn.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it.each([null, ["comments", 12]])("refuses to overwrite uninterpretable field lists", async fields => {
    const fetchFn = transport(fields);
    expect(await manageInstagramSubscription(env, await connection(), { fetchFn, subscribe: true }))
      .toMatchObject({ status: "failed", mutationAttempted: false });
  });

  it("does not treat an incomplete page as an absent subscription or follow external paging URLs", async () => {
    const fetchFn = transport([], url => url.pathname.endsWith("/subscribed_apps")
      ? json({ data: [], paging: { next: "https://untrusted.example/?access_token=private" } }) : undefined);
    expect(await manageInstagramSubscription(env, await connection(), { fetchFn, subscribe: true }))
      .toMatchObject({ status: "failed", mutationAttempted: false });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("reports an uncertain mutation without retrying or leaking transport errors", async () => {
    const fetchFn = transport(["comments"], (_url, init) => {
      if (init?.method === "POST") throw new Error(env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN);
      return undefined;
    });
    const report = await manageInstagramSubscription(env, await connection(), { fetchFn, subscribe: true });
    expect(report).toMatchObject({ status: "uncertain", mutationAttempted: true });
    expect(fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain(env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN);
  });

  it("does not call a provider acceptance response verified without a successful read-back", async () => {
    let posts = 0;
    const fetchFn = transport(["comments"], (url, init) => {
      if (init?.method === "POST") { posts++; return json({ success: true }); }
      if (posts && url.pathname.endsWith("/subscribed_apps")) return json({ error: { code: 190 } }, 400);
      return undefined;
    });
    expect(await manageInstagramSubscription(env, await connection(), { fetchFn, subscribe: true }))
      .toMatchObject({ status: "uncertain", mutationAttempted: true, messagesSubscribed: false });
  });
});
