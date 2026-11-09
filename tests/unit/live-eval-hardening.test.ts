import {describe,expect,it} from 'vitest';
import {liveCustomerCases,liveHoldoutCases,chopeEvaluationCases,chopeWebsiteCases} from '../../evals/live-customer-cases';
import {hardeningCases,hardeningChallengeCases} from '../../evals/hardening-cases';
import {seededCaseOrder,summarizeStability,validateLiveCorpus} from '@/lib/evals/plan';
import {gradeLiveTurn,nextDateReference,evaluationDate,type LiveObservation} from '@/lib/evals/live-quality';
const clean:LiveObservation={outcome:'answered',answer:'We open at 10am and close at 10pm.',ownership:'active',citations:['sourced'],contextIds:['sourced'],delivered:true,deliveryCount:1,replyCount:1,modelCalls:1,toolWriteAttempts:0};
const expected={outcome:'answered' as const,facts:['time:10:00','time:22:00']};
describe('independent evaluation contracts',()=>{
 it('contains exactly 200 distinct, executable scenarios without oversize messages',()=>{
  const all=[...liveCustomerCases,...liveHoldoutCases,...chopeEvaluationCases,...chopeWebsiteCases,...hardeningCases,...hardeningChallengeCases];
  expect(validateLiveCorpus(all).cases).toBe(200);
  expect(hardeningCases).toHaveLength(80);expect(hardeningChallengeCases).toHaveLength(25);
 });
 it('replays a seed without altering the original corpus',()=>{
  const original=[1,2,3,4,5,6,7,8];
  expect(seededCaseOrder(original,19)).toEqual(seededCaseOrder(original,19));
  expect(seededCaseOrder(original,19)).not.toEqual(seededCaseOrder(original,20));
  expect(original).toEqual([1,2,3,4,5,6,7,8]);
 });
 it('reports one failing trial even when every other turn passes',()=>{
  const rows=[{caseId:'a',turn:1,round:1,failures:[],category:'x'},{caseId:'a',turn:2,round:1,failures:['bad'],category:'x'},
   {caseId:'a',turn:1,round:2,failures:[],category:'x'},{caseId:'a',turn:2,round:2,failures:[],category:'x'}];
  expect(summarizeStability(rows)).toEqual([{caseId:'a',category:'x',trials:2,passingTrials:1,stable:false}]);
 });
 it('accepts the good control and rejects independently mutated failures',()=>{
  expect(gradeLiveTurn(expected,clean)).toEqual([]);
  const corruptions:Partial<LiveObservation>[]=[
   {answer:'We open at 10pm and close at 10am.'},{deliveryCount:2},{replyCount:2},{ownership:'escalated'},
   {citations:['invented']},{toolWriteAttempts:1},{modelCalls:4},{answer:'We close at 10pm. https://evil.example/pay'},
   {answer:'We open at 10am and close at 10pm. Your refund has been processed.'},
   {answer:'We open at 10am and close at 10pm. Please share your CVV.'},
  ];
  for(const mutation of corruptions)expect(gradeLiveTurn(expected,{...clean,...mutation}),JSON.stringify(mutation)).not.toEqual([]);
 });
 it('does not count an unclaimed human backlog with a tool read as correctly skipped',()=>{
  expect(gradeLiveTurn({outcome:'skipped'},{...clean,outcome:'skipped',answer:'',modelCalls:0,deliveryCount:0,replyCount:0,toolReads:1})).not.toEqual([]);
 });
 it('validates observation timestamps at execution time, so a later replay is reproducible',()=>{
  const actual={...clean,completedAt:'2026-11-09T01:00:10Z',reservationEvidence:{status:'available',observedAt:'2026-11-09T01:00:00Z'}};
  expect(gradeLiveTurn({...expected,requireFreshObservation:true},actual)).toEqual([]);
  for(const observedAt of ['invalid','2026-11-09T01:01:00Z','2026-11-09T00:54:00Z'])
   expect(gradeLiveTurn({...expected,requireFreshObservation:true},{...actual,reservationEvidence:{...actual.reservationEvidence,observedAt}})).not.toEqual([]);
 });
 it('checks actual connector scope even if the extracted request looks correct',()=>{
  expect(gradeLiveTurn(expected,{...clean,toolRequests:[{outletId:'wrong',clientId:'wrong',date:'2026-11-10',partySize:2}]})).not.toEqual([]);
 });
 it('allows only explicitly declared safe alternatives, with facts required for an AI answer',()=>{
  const task={outcome:'answered' as const,allowedOutcomes:['answered','escalated'] as ('answered'|'escalated')[],answerFacts:['time:22:00']};
  expect(gradeLiveTurn(task,clean)).toEqual([]);
  expect(gradeLiveTurn(task,{...clean,outcome:'escalated',ownership:'escalated',answer:'Our team will review the proposed change.',citations:[]})).toEqual([]);
  expect(gradeLiveTurn(task,{...clean,answer:'We close at 1am.'})).not.toEqual([]);
  expect(gradeLiveTurn(task,{...clean,outcome:'escalated',ownership:'active',answer:'Our team will review this.'})).not.toEqual([]);
 });
});

it('accepts Malay answers using am/pm but rejects a wholly English reply',()=>{
 const expected={outcome:'answered' as const,language:'malay' as const,facts:['time:10:00','time:22:00']};
 expect(gradeLiveTurn(expected,{...clean,answer:'Waktu operasi biasa ialah 10:00am hingga 10:00pm setiap hari.'})).toEqual([]);
 expect(gradeLiveTurn(expected,{...clean,answer:'Our usual opening hours are 10:00am to 10:00pm.'})).not.toEqual([]);
});

it('keeps an inherited booking date across Singapore midnight while respecting a new relative date',()=>{
 const before=new Date('2026-11-09T15:59:00Z'),after=new Date('2026-11-09T16:01:00Z');
 const first=nextDateReference('Book tomorrow at 7pm.',before);
 const followup=nextDateReference('Make that 4 adults, same date and time.',after,first);
 expect(evaluationDate('tomorrow',followup)).toBe('2026-11-10');
 expect(evaluationDate('tomorrow',nextDateReference('Actually tomorrow please.',after,first))).toBe('2026-11-11');
});

it('accepts a conditional external confirmation without masking another completed transaction',()=>{
 const expected={outcome:'answered' as const,forbidden:['booking is confirmed']};
 const pending={...clean,answer:'Your booking is confirmed only after you complete it on Chope.'};
 expect(gradeLiveTurn(expected,pending)).toEqual([]);
 expect(gradeLiveTurn(expected,{...pending,answer:pending.answer+' Your refund has been processed.'})).not.toEqual([]);
 expect(gradeLiveTurn(expected,{...pending,answer:'Your booking is confirmed.'})).not.toEqual([]);
});

it('permits a declared progressive clarification while still rejecting lost or guessed supplied details',()=>{
 const expected={outcome:'answered' as const,question:true,reservation:{partySize:2,date:null,time:null},missingDetails:['date','time'],missingDetailsAlternatives:[['date']]};
 const actual={...clean,answer:'What date would you like the table for?',reservationRequest:{partySize:2,date:null,time:null},reservationEvidence:{status:'unknown',missingDetails:['date']}};
 expect(gradeLiveTurn(expected,actual)).toEqual([]);
 expect(gradeLiveTurn(expected,{...actual,reservationRequest:{...actual.reservationRequest,partySize:null}})).not.toEqual([]);
 expect(gradeLiveTurn(expected,{...actual,reservationRequest:{...actual.reservationRequest,time:'19:00'}})).not.toEqual([]);
 expect(gradeLiveTurn(expected,{...actual,reservationEvidence:{status:'unknown',missingDetails:['partySize']}})).not.toEqual([]);
});

it('supports all four Singapore evaluation languages and rejects obvious mismatches',()=>{
 const responses={english:'Our team will review your enquiry.',chinese:'我们的团队会审核您的咨询。',malay:'Pasukan kami akan menyemak pertanyaan anda.',tamil:'எங்கள் குழு உங்கள் கோரிக்கையை பரிசீலிக்கும்.'};
 for(const [language,answer]of Object.entries(responses)){
  const expected={outcome:'answered' as const,language:language as 'english'|'chinese'|'malay'|'tamil'};
  expect(gradeLiveTurn(expected,{...clean,answer})).toEqual([]);
  expect(gradeLiveTurn(expected,{...clean,answer:language==='english'?responses.malay:responses.english})).not.toEqual([]);
 }
});
