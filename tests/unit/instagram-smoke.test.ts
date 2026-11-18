import { describe, expect, it, vi } from "vitest";
import { checkInstagramTestCredentials } from "@/lib/channels/instagram-smoke";

const env = {
  PRONTO_INSTAGRAM_TEST_ACCOUNT_ID: "12345", PRONTO_INSTAGRAM_TEST_APP_ID: "67890",
  PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN: "fixture-private-token",
  PRONTO_INSTAGRAM_TEST_APP_SECRET: "fixture-private-secret",
  PRONTO_META_TEST_ACCOUNT: "1", PRONTO_META_READ_APPROVED: "1",
};
const valid = { is_valid: true, app_id: "67890", expires_at: 0, data_access_expires_at: 0,
  scopes: ["instagram_basic", "instagram_manage_messages"] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Instagram environment smoke check", () => {
  it("checks local configuration without opening the network", async () => {
    const fetchFn = vi.fn();
    const report = await checkInstagramTestCredentials(env, { fetchFn });
    expect(report.status).toBe("configured");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN);
    expect(JSON.stringify(report)).not.toContain(env.PRONTO_INSTAGRAM_TEST_APP_SECRET);
  });

  it.each([
    { PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN: "" },
    { PRONTO_INSTAGRAM_TEST_APP_ID: "not-an-id" },
    { PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN: "token with spaces" },
    { PRONTO_INSTAGRAM_TEST_ACCOUNT_ID: "replace-with-account" },
    { META_GRAPH_VERSION: "v20.0" },
    { META_GRAPH_VERSION: "v27.0/elsewhere" },
    { PRONTO_INSTAGRAM_TEST_CONFIG_ID: "invalid" },
  ])("rejects incomplete or malformed inputs before requesting Meta", async overrides => {
    const fetchFn = vi.fn();
    expect((await checkInstagramTestCredentials({ ...env, ...overrides }, { live: true, fetchFn })).status).toBe("failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    { PRONTO_META_TEST_ACCOUNT: "0" }, { PRONTO_META_READ_APPROVED: "0" }, { PRONTO_SKIP_LIVE_HEALTH: "1" },
  ])("requires explicit test-account/read authorization", async overrides => {
    const fetchFn = vi.fn();
    expect((await checkInstagramTestCredentials({ ...env, ...overrides }, { live: true, fetchFn })).status).toBe("failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("verifies app, scopes and exact account with bounded read-only requests", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ data: valid }))
      .mockResolvedValueOnce(json({ id: "12345", username: "fixture-account" }));
    const report = await checkInstagramTestCredentials(env, { live: true, fetchFn });
    expect(report.status).toBe("passed");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [debugUrl, debugOptions] = fetchFn.mock.calls[0];
    expect(debugUrl.origin).toBe("https://graph.facebook.com");
    expect(debugUrl.pathname).toBe("/v25.0/debug_token");
    expect(debugUrl.searchParams.get("input_token")).toBe(env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN);
    expect(debugOptions.headers.Authorization).toBe("Bearer 67890|fixture-private-secret");
    const [profileUrl, profileOptions] = fetchFn.mock.calls[1];
    expect(profileUrl.pathname).toBe("/v25.0/12345");
    expect(profileOptions.headers.Authorization).toBe("Bearer fixture-private-token");
    for (const [, options] of fetchFn.mock.calls) {
      expect(options).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
    }
    const output = JSON.stringify(report);
    for (const secret of [env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN, env.PRONTO_INSTAGRAM_TEST_APP_SECRET, "fixture-account"])
      expect(output).not.toContain(secret);
  });

  it.each([
    { is_valid: false }, { app_id: "foreign-app" }, { expires_at: 1 }, { data_access_expires_at: 1 },
    { scopes: ["instagram_basic"] }, { scopes: ["instagram_business_basic", "instagram_business_manage_messages"] },
  ])("stops before account reads when token evidence fails", async overrides => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ data: { ...valid, ...overrides } }));
    const report = await checkInstagramTestCredentials(env, { live: true, fetchFn });
    expect(report.status).toBe("failed");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a different account identity", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ data: valid })).mockResolvedValueOnce(json({ id: "other" }));
    expect((await checkInstagramTestCredentials(env, { live: true, fetchFn })).status).toBe("failed");
  });

  it("reports omitted expiry as unknown rather than inventing an expiry", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ data: { ...valid, expires_at: undefined } }))
      .mockResolvedValueOnce(json({ id: "12345" }));
    const report = await checkInstagramTestCredentials(env, { live: true, fetchFn });
    expect(report.checks).toContainEqual({ name: "expires_at", status: "unknown", detail: expect.any(String) });
  });

  it("withholds raw provider messages and surfaces only numeric error codes", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ error: {
      code: 190, error_subcode: 463, message: env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN,
    } }, 400));
    const report = await checkInstagramTestCredentials(env, { live: true, fetchFn });
    expect(report.status).toBe("failed");
    expect(report.checks.at(-1)?.detail).toContain("code 190; subcode 463");
    expect(JSON.stringify(report)).not.toContain(env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], { data: null }])("rejects malformed debug responses", async body => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json(body));
    expect((await checkInstagramTestCredentials(env, { live: true, fetchFn })).status).toBe("failed");
  });

  it("does not expose token-bearing transport errors or retry them", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error(`https://graph.facebook.com/?input_token=${env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN}`));
    const report = await checkInstagramTestCredentials(env, { live: true, fetchFn });
    expect(report.status).toBe("failed");
    expect(JSON.stringify(report)).not.toContain(env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
