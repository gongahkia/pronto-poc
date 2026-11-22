import { describe, it, expect } from "vitest";
import { sourceProgress } from "@/lib/self-serve/progress";
const base = { status: "processing", job_status: "pending", attempts: 0, available_at: null, processing_counts: null };
describe("source processing progress", () => {
  it("shows stage counts without claiming that checked comparisons publish a source", () => {
    expect(sourceProgress({ ...base, processing_counts: { phase: "extract", cursor: 1, segments: 3 } }))
      .toMatchObject({ stage: "Extracting business rules", completed: 1, total: 3 });
    expect(sourceProgress({ ...base, processing_counts: { phase: "verify", verifyCursor: 6, rules: 10 } }))
      .toMatchObject({ stage: "Checking source accuracy", completed: 6, total: 10 });
    expect(sourceProgress({ ...base, processing_counts: { phase: "judge", judgeCursor: 24, pairs: 24 } }))
      .toMatchObject({ stage: "Finalising checked rules", completed: 24, total: 24 });
  });
  it("keeps failed or missing work distinct from completion and reports retry timing", () => {
    expect(sourceProgress({ ...base, job_status: null }).stage).toBe("Processing status unavailable");
    expect(sourceProgress({ ...base, status: "failed" }).stage).toBe("Processing stopped");
    expect(sourceProgress({ ...base, attempts: 1, available_at: "2026-11-22T02:00:00Z" }, Date.parse("2026-11-22T01:00:00Z")))
      .toMatchObject({ stage: "Waiting to retry", retryAt: "2026-11-22T02:00:00.000Z" });
    expect(sourceProgress({ ...base, processing_counts: { phase: "judge", pairs: "invalid" } }).total).toBeNull();
  });
});
