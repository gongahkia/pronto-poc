import type { GroundedAnswerDecision } from "@/lib/llm/types";

// A customer-facing promise to involve staff must transfer actual ownership.
// This check only tightens routing; it never authorizes a business action.
export function requiresStaffFollowUp(decision: GroundedAnswerDecision, reservationContext = false): boolean {
  if (decision.action !== "answer") return false;
  const answer = decision.answer ?? "";
  const availabilityOnly=reservationContext && /\b(?:availability|table|slot|booking|chope)\b/i.test(answer) &&
    !/\b(?:price|fee|charge|ingredients?|certification|policy|discount|vegan|halal)\b/i.test(answer) &&
    !/(?:price|fee|policy|dietary|ingredients|certification|discount)/i.test(decision.reasonCode);
  const promised = /\b(?:i|we)(?:['’]ll|\s+will)\s+(?:(?:ask|contact|notify|consult|alert)\s+(?:our|the)\s+team|(?:check|confirm)\s+with\s+(?:our|the)\s+team|(?:refer|pass|forward|escalate|hand)\b[^.!?\n]{0,80}\b(?:our|the)\s+team)/i.test(answer);
  const explainsHandoff = /\b(?:must|needs? to|should)\s+(?:be\s+)?(?:escalated|handed (?:over|off)|referred to (?:our|the) team)\b/i.test(decision.reasonDetail);
  const unresolved = !availabilityOnly && /\b(?:our|the) team\b/i.test(answer) &&
    /\b(?:not|isn['’]t|aren['’]t)\s+(?:currently\s+)?(?:verified|confirmed|available)|\b(?:can['’]t|cannot|unable to)\s+(?:verify|confirm)\b/i.test(answer);
  // A model can correctly admit missing evidence yet contradict that admission
  // with action=answer and omit any mention of staff. Its declared unresolved
  // reason plus an admission of uncertainty still requires actual ownership.
  const unresolvedReason = /(?:^|_)(?:unverified|unknown|unconfirmed|missing|insufficient|not_found|not_available|not_in_sources)(?:_|$)/i.test(decision.reasonCode);
  const admitsUnknownFact = !availabilityOnly && unresolvedReason &&
    (/\b(?:not|isn['’]t|aren['’]t)\s+(?:currently\s+)?(?:verified|confirmed)|\b(?:can['’]t|cannot|unable to)\s+(?:verify|confirm)|\b(?:no|missing|insufficient)\s+(?:verified|confirmed|approved|current)\s+information\b/i.test(answer) ||
      /(?:price|fee|policy|dietary|ingredients|certification|discount)/i.test(decision.reasonCode));
  return promised || explainsHandoff || unresolved || admitsUnknownFact;
}
