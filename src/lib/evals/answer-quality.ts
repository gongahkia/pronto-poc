export type QualityExpectation = {
  outcome: "answered" | "escalated" | "failed";
  reason?: string;
  contains?: string[];
  excludes?: string[];
  minCitations?: number;
  maxCalls?: number;
  maxTokens?: number;
  handoffMode?: 'review' | 'pause';
};
export type QualityObservation = {
  outcome: string; reason: string; answer: string; citations: string[];
  calls: number; tokens: number; ownership: string; queuedBodies: string[];
  ownerActionRequired?: boolean; pendingStaffReview?: boolean;
};
// Routing and citation presence alone cannot pass an answer-quality evaluation.
// Match required/forbidden answer content independently of the runtime validator.
export function gradeQualityTurn(expected: QualityExpectation, actual: QualityObservation): string[] {
  const failures: string[] = [];
  if (actual.outcome !== expected.outcome) failures.push(`outcome: expected ${expected.outcome}, got ${actual.outcome}`);
  if (expected.reason && actual.reason !== expected.reason) failures.push(`reason: expected ${expected.reason}, got ${actual.reason}`);
  const text = actual.answer.toLowerCase();
  for (const value of expected.contains ?? []) if (!text.includes(value.toLowerCase())) failures.push(`missing answer content: ${value}`);
  for (const value of expected.excludes ?? []) if ([actual.answer,...actual.queuedBodies].join("\n").toLowerCase().includes(value.toLowerCase())) failures.push(`forbidden answer content: ${value}`);
  if (actual.citations.length < (expected.minCitations ?? (expected.outcome === "answered" ? 1 : 0))) failures.push("missing evidence citations");
  if (actual.calls > (expected.maxCalls ?? 3)) failures.push("turn call limit exceeded");
  if (actual.tokens > (expected.maxTokens ?? 12000)) failures.push("turn token limit exceeded");
  if (expected.outcome === "failed" && actual.ownership !== "active") failures.push("operational failure transferred ownership");
  if (expected.outcome === 'escalated') {
    if (expected.handoffMode === 'review') {
      if (actual.ownership !== 'active' || !actual.ownerActionRequired || !actual.pendingStaffReview)
        failures.push('staff review must remain open while supported follow-ups are allowed');
    } else if (actual.ownership !== 'escalated') failures.push('business handoff did not transfer ownership');
  }
  return failures;
}
