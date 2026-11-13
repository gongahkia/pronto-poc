// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeProviderError, providerRetryAfter, ProviderRequestError, LlmConfigurationError } from "@/lib/llm/errors";
import { processingFailure } from "@/lib/agent/processing-error";
import { TurnBudgetExceededError } from "@/lib/agent/turn-budget";

describe("operational failure classification", () => {
  it('retries transient generated JSON failures but keeps bad requests and identity failures terminal',()=>{
    const error=normalizeProviderError('groq',{status:400,error:{code:'json_validate_failed',message:'PRIVATE MODEL OUTPUT'}});
    expect(error).toMatchObject({code:'malformed_response',retryable:true});expect(JSON.stringify(error)).not.toContain('PRIVATE');
    expect(normalizeProviderError('groq',{status:400,error:{code:'invalid_request_error'}})).toMatchObject({code:'invalid_response',retryable:false});
    expect(new ProviderRequestError('groq','output_truncated')).toMatchObject({retryable:true});
    expect(new ProviderRequestError('groq','invalid_response')).toMatchObject({retryable:false});
  });
  it("distinguishes rate limits from exhausted billing/quota and retains only sanitized retry hints", () => {
    const rate = normalizeProviderError("groq", { status: 429, headers: new Headers({ "retry-after": "32" }), error: { message: "SECRET", code: "rate_limit_exceeded" } });
    expect(rate).toMatchObject({ code: "rate_limited", retryable: true, retryAfterSeconds: 32 });
    expect(JSON.stringify(rate)).not.toContain("SECRET");
    expect(normalizeProviderError("openai", { status: 429, error: { code: "insufficient_quota" } })).toMatchObject({ code: "quota_exhausted", retryable: false });
  });
  it.each([[401,"authentication",false],[400,"invalid_response",false],[503,"unavailable",true],[408,"timeout",true]] as const)("classifies HTTP %s", (status,code,retryable) => {
    expect(normalizeProviderError("groq", {status})).toMatchObject({code,retryable});
  });
  it("handles HTTP-date retry headers and rejects invalid or excessive values", () => {
    expect(providerRetryAfter("Thu, 01 Jan 2026 00:01:00 GMT", Date.parse("2026-01-01T00:00:00Z"))).toBe(60);
    expect(providerRetryAfter("9999999")).toBe(3600);
    for (const value of ["garbage", "-3", 0, null, {}]) expect(providerRetryAfter(value)).toBeUndefined();
  });
  it("never automatically repeats configuration and turn-budget failures", () => {
    expect(processingFailure(new LlmConfigurationError("groq","missing key"))).toMatchObject({code:"configuration",retryable:false});
    expect(processingFailure(new TurnBudgetExceededError("calls"))).toMatchObject({code:"turn_budget_calls",retryable:false});
    expect(processingFailure(new ProviderRequestError("groq","timeout"))).toMatchObject({code:"timeout",retryable:true});
  });
});
