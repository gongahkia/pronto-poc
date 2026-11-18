import { mkdtemp, readFile, rm, stat, chmod, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareInstagramSetup, validateInstagramConnection } from "@/lib/channels/instagram-setup";
import { readPrivateInstagramSetup, writeInstagramSetupFiles } from "../../scripts/instagram-setup-files";

const env = { PRONTO_INSTAGRAM_TEST_ACCOUNT_ID: "12345", PRONTO_INSTAGRAM_TEST_APP_ID: "67890",
  PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN: "fixture-private-token", PRONTO_INSTAGRAM_TEST_APP_SECRET: "fixture-private-secret" };
const input = { clientId: "00000000-0000-4000-8000-000000000001", channelId: "00000000-0000-4000-8000-000000000002",
  callbackOrigin: "https://test-callback.example" };
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("Instagram private setup preparation", () => {
  it("generates a draft operator form and matching callback, without putting API credentials in Keith's message", async () => {
    const result = await prepareInstagramSetup(env, input);
    expect(result.form).toMatchObject({ clientId: input.clientId, channelId: input.channelId, status: "draft", externalId: "12345",
      "settings.authMode": "unified_login", "credentials.accessToken": env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN,
      "credentials.appSecret": env.PRONTO_INSTAGRAM_TEST_APP_SECRET });
    expect(result.connection.callbackUrl).toBe(`https://test-callback.example/api/webhooks/instagram/${input.channelId}`);
    expect(result.form["settings.verifyToken"]).toBe(result.connection.verifyToken);
    expect(result.handoff).toContain(result.connection.verifyToken);
    expect(result.handoff).not.toContain(env.PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN);
    expect(result.handoff).not.toContain(env.PRONTO_INSTAGRAM_TEST_APP_SECRET);
    expect(result.connection.verifyToken).not.toBe((await prepareInstagramSetup(env, input)).connection.verifyToken);
  });

  it.each(["http://example.test", "https://user:password@example.test", "https://example.test/path", "https://example.test?x=1"])(
    "rejects an unsafe callback origin: %s", async callbackOrigin => {
      await expect(prepareInstagramSetup(env, { ...input, callbackOrigin })).rejects.toThrow();
    });

  it("rejects missing credentials or malformed tenant/channel identifiers", async () => {
    await expect(prepareInstagramSetup({ ...env, PRONTO_INSTAGRAM_TEST_ACCESS_TOKEN: "" }, input)).rejects.toThrow(/incomplete/);
    await expect(prepareInstagramSetup(env, { ...input, clientId: "not-a-tenant" })).rejects.toThrow(/identity/);
    await expect(prepareInstagramSetup(env, { ...input, channelId: "../other" })).rejects.toThrow();
  });

  it("retains optional configuration metadata", async () => {
    const result = await prepareInstagramSetup({ ...env, PRONTO_INSTAGRAM_TEST_CONFIG_ID: "345", PRONTO_INSTAGRAM_TEST_BUSINESS_ID: "456" }, input);
    expect(result.form).toMatchObject({ "credentials.configId": "345", "credentials.businessId": "456" });
  });

  it("rejects a tampered callback path or embedded query", async () => {
    const { connection } = await prepareInstagramSetup(env, input);
    expect(() => validateInstagramConnection({ ...connection, callbackUrl: "https://other.test/" })).toThrow();
    expect(() => validateInstagramConnection({ ...connection, callbackUrl: connection.callbackUrl + "?token=bad" })).toThrow();
    expect(() => validateInstagramConnection({ ...connection, verifyToken: "short" })).toThrow();
  });

  it("writes owned private files in a fresh ignored directory and refuses insecure reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "pronto-instagram-unit-")); directories.push(root);
    const bundle = await prepareInstagramSetup(env, input), directory = await writeInstagramSetupFiles(bundle, root);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of ["connection.json", "channel-form.json", "keith-private.txt"])
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    expect(await readPrivateInstagramSetup(join(directory, "connection.json"))).toEqual(bundle.connection);
    expect(JSON.parse(await readFile(join(directory, "channel-form.json"), "utf8"))).toEqual(bundle.form);
    const again = await writeInstagramSetupFiles(bundle, root);
    expect(again).not.toBe(directory);
    await chmod(join(directory, "connection.json"), 0o644);
    await expect(readPrivateInstagramSetup(join(directory, "connection.json"))).rejects.toThrow(/private/);
    await symlink(join(directory, "channel-form.json"), join(directory, "link.json"));
    await expect(readPrivateInstagramSetup(join(directory, "link.json"))).rejects.toThrow();
  });

  it("does not follow output symlinks into tracked directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pronto-instagram-unit-")); directories.push(root);
    await mkdir(join(root, "src")); await symlink(join(root, "src"), join(root, "output"));
    await expect(writeInstagramSetupFiles(await prepareInstagramSetup(env, input), root)).rejects.toThrow(/symlinks/);
  });
});
