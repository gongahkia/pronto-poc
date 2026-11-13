export class LlmConfigurationError extends Error {
  constructor(public readonly provider: string, detail: string) {
    super(`${provider} LLM provider is not configured: ${detail}`);
    this.name = "LlmConfigurationError";
  }
}

export type ProviderFailure = "quota_exhausted" | "rate_limited" | "authentication" | "timeout" | "unavailable" | "invalid_response" | "malformed_response" | "output_truncated";
// Never retain provider payloads, headers, keys or prompts in an Error message.
export class ProviderRequestError extends Error {
  constructor(public readonly provider: string, public readonly code: ProviderFailure,
    public readonly status?: number, public readonly retryAfterSeconds?: number) {
    super(`${provider}: ${code}${status ? ` (HTTP ${status})` : ""}. No provider or mock fallback was used.`);
    this.name = "ProviderRequestError";
  }
  get retryable(): boolean { return ["rate_limited", "timeout", "unavailable", "malformed_response", "output_truncated"].includes(this.code); }
}

export function providerRetryAfter(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric) ? numeric : (Date.parse(String(value)) - now) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, Math.ceil(seconds)) : undefined;
}
export function normalizeProviderError(provider: string, error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  const info = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = Number(info.status) || undefined;
  const name = error instanceof Error ? [error, (error as Error & { cause?: unknown }).cause].filter(value => value instanceof Error)
    .map(value => `${value.name} ${value.constructor.name}`).join(" ") : "";
  const payload = info.error && typeof info.error === "object" ? info.error as Record<string, unknown> : {};
  // Inspect only finite provider codes/types, never copy free-form provider messages.
  const code = [info.code, info.type, payload.code, payload.type].filter(value => typeof value === "string").join(" ");
  const quota = /insufficient_quota|quota_exhausted|billing_hard_limit|billing_not_active|daily_quota|daily_limit/i.test(code);
  const headers = info.headers;
  const retryAfter = headers && typeof headers === "object" && "get" in headers && typeof headers.get === "function"
    ? headers.get("retry-after") : headers && typeof headers === "object" ? (headers as Record<string,unknown>)["retry-after"] : undefined;
  const generatedJsonFailure = provider === 'groq' && /\bjson_validate_failed\b/.test(code);
  const failure: ProviderFailure = quota ? "quota_exhausted" : generatedJsonFailure ? 'malformed_response' : status === 429 ? "rate_limited" :
    status === 401 || status === 403 ? "authentication" : /Abort|Timeout/.test(name) || status === 408 ? "timeout" :
    /SyntaxError|ZodError/.test(name) || status && status >= 400 && status < 500 ? "invalid_response" : "unavailable";
  return new ProviderRequestError(provider, failure, status, providerRetryAfter(retryAfter));
}
