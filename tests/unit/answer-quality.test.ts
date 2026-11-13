import { describe, expect, it } from "vitest";
import { gradeQualityTurn, type QualityObservation } from "@/lib/evals/answer-quality";
const actual: QualityObservation = {outcome:"answered",reason:"grounded_answer",answer:"We close at 11pm.",citations:["valid-source"],calls:1,tokens:500,ownership:"active",queuedBodies:[]};
describe("independent answer-quality grader",()=>{
  it('requires a real pending issue and staff flag for issue-scoped review without weakening full pauses',()=>{
    const reply={...actual,outcome:'escalated',answer:'Our team will review this.',citations:[]};
    expect(gradeQualityTurn({outcome:'escalated',handoffMode:'review'},reply)).not.toEqual([]);
    expect(gradeQualityTurn({outcome:'escalated',handoffMode:'review'},{...reply,ownerActionRequired:true,pendingStaffReview:true})).toEqual([]);
    expect(gradeQualityTurn({outcome:'escalated'},{...reply,ownerActionRequired:true,pendingStaffReview:true})).not.toEqual([]);
  });
  it("fails the wrong fact even with correct routing and a citation",()=>{
    expect(gradeQualityTurn({outcome:"answered",contains:["10pm"],excludes:["11pm"]},actual)).toHaveLength(2);
  });
  it("checks queued text, ownership and shared budgets",()=>{
    expect(gradeQualityTurn({outcome:"failed",excludes:["11pm"]},{...actual,outcome:"failed",answer:"",ownership:"escalated",calls:4,tokens:13000,queuedBodies:[actual.answer]})).toHaveLength(4);
  });
  it("passes a factually expected answer within its budget",()=>{
    expect(gradeQualityTurn({outcome:"answered",contains:["10pm"],excludes:["11pm"]},{...actual,answer:"We close at 10pm."})).toEqual([]);
  });
});
