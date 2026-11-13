import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";

describe("proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects protected page routes without a session cookie", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_BASE_URL", "https://approved.trycloudflare.com");

    const response = proxy(new NextRequest("http://localhost/operator", {
      headers: { "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "http" },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://approved.trycloudflare.com/login");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("returns 401 for protected API routes without a session cookie", async () => {
    const response = proxy(new NextRequest("http://localhost/api/client/settings"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthenticated." });
  });

  it("propagates a nonce to downstream request headers and CSP", () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = proxy(
      new NextRequest("http://localhost/client", {
        headers: { cookie: "pronto_session=session-value" },
      }),
    );
    const nonce = response.headers.get("x-nonce");

    expect(nonce).toBeTruthy();
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(response.headers.get('x-middleware-request-content-security-policy')).toContain(`'nonce-${nonce}'`);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    );
  });

  it("sets production CSP without unsafe-eval and denies framing", () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = proxy(new NextRequest("http://localhost/login"));
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("does not upgrade local development form submissions", () => {
    vi.stubEnv("NODE_ENV", "development");

    const response = proxy(new NextRequest("http://127.0.0.1:3000/login"));
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("form-action 'self' http://localhost:* http://127.0.0.1:*");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("keeps static asset exclusions in the matcher", () => {
    expect(config.matcher[0]).toContain("_next/static");
    expect(config.matcher[0]).toContain("_next/image");
    expect(config.matcher[0]).toContain("favicon.ico");
    expect(config.matcher[0]).toContain("svg|png|jpg|jpeg|gif|webp|ico");
  });

  it('allows the configured Huddle connection and popup without adding wildcard HTTP access', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED', '1'); vi.stubEnv('PRONTO_HUDDLE_ENABLED', '1');
    vi.stubEnv('PRONTO_HUDDLE_SERVER_URL', 'http://localhost:4310');
    vi.stubEnv('PRONTO_HUDDLE_PROJECT_ID', '11111111-1111-4111-8111-111111111111');
    const response = proxy(new NextRequest('http://localhost:3000/login'));
    expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self' https: http://localhost:4310;");
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups');
    vi.stubEnv('PRONTO_HUDDLE_SERVER_URL', 'http://localhost:4310/;connect-src *');
    const invalid = proxy(new NextRequest('http://localhost:3000/login'));
    expect(invalid.headers.get('Content-Security-Policy')).not.toContain('4310');
    expect(invalid.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });
});
