import { describe, expect, it } from "vitest";
import { requiresStaffFollowUp } from "@/lib/agent/decision-consistency";
import type { GroundedAnswerDecision } from "@/lib/llm/types";
const decision = (answer: string, reasonDetail = "A response."): GroundedAnswerDecision =>
  ({ action: "answer", answer, reasonDetail, reasonCode: "test", confidence: 0.9, citedChunkIds: [] });
describe("staff follow-up ownership", () => {
  it.each(["The price isn’t verified. I’ll ask our team to confirm it.",
    "I will check with our team.", "I’ll refer this to our team.",
    "I cannot verify the price. Please contact our team."])("requires real handoff for a staff follow-up: %s", answer => {
    expect(requiresStaffFollowUp(decision(answer))).toBe(true);
  });
  it("detects an explicit contradiction between an answer action and a handoff explanation", () => {
    expect(requiresStaffFollowUp(decision("Please check with our team.", "The unknown price must be escalated to our team."))).toBe(true);
  });
  it("requires ownership for an unresolved price even when the answer never mentions staff", () => {
    expect(requiresStaffFollowUp({ ...decision("The Red Pesto Rigatoni price isn’t verified in the information I have."),
      reasonCode: "price_unverified" })).toBe(true);
    expect(requiresStaffFollowUp({ ...decision("I cannot verify current availability; please check Chope."),
      reasonCode: "availability_unverified" }, true)).toBe(false);
    expect(requiresStaffFollowUp({ ...decision("Our standard hours are 10am to 10pm; holiday exceptions are not confirmed."),
      reasonCode: "opening_hours" })).toBe(false);
  });
  it("preserves supported facts and read-only booking referrals", () => {
    expect(requiresStaffFollowUp(decision("We have vegetarian options. Ask our team about ingredients."))).toBe(false);
    expect(requiresStaffFollowUp(decision("I cannot verify availability; check and confirm on Chope."), true)).toBe(false);
  });
  it("does not let booking context exempt a simultaneous unknown price",()=>{
    expect(requiresStaffFollowUp({...decision('The cake price is not verified. Please check Chope for your table.'),reasonCode:'price_unverified'},true)).toBe(true);
    expect(requiresStaffFollowUp({...decision('价格尚未核实。'),reasonCode:'price_unverified'},true)).toBe(true);
  });
});
