import type { GroundedAnswerDecision } from "@/lib/llm/types";

// A customer-facing promise to involve staff must transfer actual ownership.
// This check only tightens routing; it never authorizes a business action.
export function requiresStaffFollowUp(decision: GroundedAnswerDecision, reservationContext = false, customerMessage = ""): boolean {
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
  const unresolvedReason = /(?:^|_)(?:unverified|unknown|unconfirmed|unavailable|missing|insufficient|not_verified|not_confirmed|not_provided|not_listed|not_found|not_available|not_in_sources)(?:_|$)/i.test(decision.reasonCode);
  const admitsUnknownFact = !availabilityOnly && unresolvedReason &&
    (/\b(?:not|isn['’]t|aren['’]t)\s+(?:currently\s+)?(?:verified|confirmed)|\b(?:can['’]t|cannot|unable to)\s+(?:verify|confirm)|\b(?:no|missing|insufficient)\s+(?:verified|confirmed|approved|current)\s+information\b/i.test(answer) ||
      /(?:price|fee|policy|dietary|ingredients|certification|discount)/i.test(decision.reasonCode));
  // Free-form reason codes are diagnostic, not a routing authority. Recognize
  // an admission about a fact the customer actually requested, even when the
  // model invents another reason-code spelling. An unasked holiday/price
  // caveat must not turn a supported hours/menu-link answer into a handoff.
  const factFamilies = [
    {requested:/\b(?:how much|prices?|pricing|costs?|fees?|charges?|corkage|deposits?|discounts?|promotions?)\b/i,
      stated:/\b(?:prices?|pricing|costs?|fees?|charges?|corkage|deposits?|discounts?|promotions?)\b/i},
    {requested:/\b(?:polic(?:y|ies)|payments?|pay|cash|cards?|pets?|dogs?|wheelchair|accessib\w*|parking|wi[ -]?fi|password|high[ -]?chairs?|strollers?|bring|takeaway|delivery|halal|vegan|dairy|gluten|ingredients?|allerg\w*|certif\w*|cutoffs?)\b/i,
      stated:/\b(?:polic(?:y|ies)|payments?|cash|cards?|pets?|dogs?|wheelchair|accessib\w*|parking|wi[ -]?fi|password|chairs?|strollers?|takeaway|delivery|halal|vegan|dairy|gluten|ingredients?|allerg\w*|dietary|certif\w*|cutoffs?|fees?|charges?|corkage)\b/i},
  ];
  const unknownAdmissions=[
    /\b(?:not|isn['’]t|aren['’]t)\s+(?:(?:currently|yet|explicitly)\s+)?(?:verified|confirmed|known|provided|listed|specified|published|documented|included)\b/i,
    /\b(?:can['’]t|cannot|unable to|haven['’]t been able to)\s+(?:verify|confirm|find|provide|determine)\b/i,
    /\b(?:I|we)\s+(?:do not|don['’]t)\s+(?:currently\s+)?have\s+(?:(?:the|any|that|current|verified|approved)\s+)*(?:information|details|prices|pricing)\b/i,
    /\b(?:no|missing|insufficient)\s+(?:(?:verified|confirmed|approved|current)\s+)?(?:information|details)\b/i,
    /\b(?:information|details|prices?|pricing|costs?|fees?)\s+(?:is|are)?\s*(?:not|isn['’]t|aren['’]t)\s+(?:currently\s+)?available\b/i,
  ];
  const requestedUnknownFact = !availabilityOnly && factFamilies.some(family=>family.requested.test(customerMessage)&&
    answer.split(/(?<=[.!?;])\s+|\n/u).some(sentence=>family.stated.test(sentence)&&unknownAdmissions.some(pattern=>pattern.test(sentence))));
  return promised || explainsHandoff || unresolved || admitsUnknownFact || requestedUnknownFact;
}
