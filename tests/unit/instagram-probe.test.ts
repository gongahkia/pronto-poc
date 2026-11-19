import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instagramProbeConfig, matchesInstagramProbe } from "@/lib/channels/instagram-probe";
import type { Channel } from "@/lib/types";

const now = Date.now(), phrase = "pronto-test " + "a".repeat(32);
const probe = { id: randomUUID(), nonceHash: createHash("sha256").update(phrase).digest("hex"),
  startedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() };
const channel: Channel = { id: randomUUID(), client_id: randomUUID(), kind: "instagram", name: "Probe", status: "draft",
  external_id: "account", credentials: {}, settings: { authMode: "unified_login", instagramProbe: probe },
  last_health_check_at: null, last_health_status: null, last_health_error: null, last_outbound_at: null, last_outbound_error: null };

describe("receive-only Instagram probe boundary", () => {
  beforeEach(() => {
    vi.stubEnv("PRONTO_HOSTED_INSTAGRAM", "1"); vi.stubEnv("PRONTO_DEPLOYMENT_PROFILE", "standard");
    vi.stubEnv("PRONTO_HOSTED_INSTAGRAM_WORKER", "0");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("allows only the exact nonce during the configured test window", () => {
    expect(instagramProbeConfig(channel, now)).toEqual(probe);
    expect(matchesInstagramProbe(phrase, probe)).toBe(true);
    for (const text of ["hello", phrase + " ", "pronto-test " + "b".repeat(32), "a".repeat(32)])
      expect(matchesInstagramProbe(text, probe)).toBe(false);
  });
  it.each([
    { id: "not-a-uuid" }, { nonceHash: "short" }, { startedAt: "invalid" },
    { startedAt: new Date(now + 1).toISOString() }, { expiresAt: new Date(now).toISOString() },
    { expiresAt: new Date(now + 3 * 3600000).toISOString() },
  ])("rejects malformed, future, expired or unbounded probe windows", changes => {
    expect(instagramProbeConfig({ ...channel, settings: { ...channel.settings, instagramProbe: { ...probe, ...changes } } }, now)).toBeNull();
  });
  it("keeps disabled, active and non-Unified Login channels outside the probe path", () => {
    for (const status of ["active", "disabled"] as const) expect(instagramProbeConfig({ ...channel, status }, now)).toBeNull();
    expect(instagramProbeConfig({ ...channel, settings: { ...channel.settings, authMode: "facebook_login" } }, now)).toBeNull();
    expect(instagramProbeConfig({ ...channel, kind: "email" }, now)).toBeNull();
  });
  it.each([
    ["PRONTO_HOSTED_INSTAGRAM", "0"], ["PRONTO_DEPLOYMENT_PROFILE", "protected-demo"], ["PRONTO_HOSTED_INSTAGRAM_WORKER", "1"],
  ])("requires the isolated hosted profile with the worker off: %s", (key, value) => {
    vi.stubEnv(key, value); expect(instagramProbeConfig(channel, now)).toBeNull();
  });
});
