import {it,expect} from 'vitest';
import {semanticReviewData,type SemanticTurn} from '@/lib/evals/semantic-review';
const base:SemanticTurn={caseId:'booking',conversationId:'own',round:1,turn:1,customer:'Book tomorrow at 7pm.',answer:'Please complete your booking on Chope.',outcome:'answered',ownership:'active',expected:{reservation:{date:'tomorrow'}}};
it('gives the critic the restaurant date on both sides of midnight',()=>{
 const before=semanticReviewData({...base,evaluatedAt:'2026-11-09T15:59:00Z'},[]);
 const after=semanticReviewData({...base,evaluatedAt:'2026-11-09T16:01:00Z'},[]);
 expect(before.businessClockAtTurn).toBe('2026-11-09 23:59 +08:00 (Asia/Singapore)');
 expect(before.expectedReservationDate).toBe('2026-11-10');
 expect(after.businessClockAtTurn).toBe('2026-11-10 00:01 +08:00 (Asia/Singapore)');
 expect(after.expectedReservationDate).toBe('2026-11-11');
});
it('keeps the inherited booking date while showing the current local clock',()=>{
 const data=semanticReviewData({...base,customer:'Same date and time, make it four.',evaluatedAt:'2026-11-09T16:01:00Z',dateReferenceAt:'2026-11-09T15:59:00Z'},[]);
 expect(data.expectedReservationDate).toBe('2026-11-10');
 expect(data.businessClockAtTurn).toContain('2026-11-10 00:01');
});
it('includes only earlier history from the same case, trial and conversation',()=>{
 const current={...base,turn:2};
 const data=semanticReviewData(current,[base,{...base,round:2,customer:'other trial'},{...base,conversationId:'foreign',customer:'other conversation'},{...base,turn:3,customer:'future message'}]);
 expect(data.history).toEqual([{customer:base.customer,assistant:base.answer}]);
});
