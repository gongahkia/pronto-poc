import {describe,expect,it} from 'vitest';
import {summarizeUsage,usageCsv,usageMonth,type MeteredEvent} from '@/lib/analytics/usage';
const event=(changes:Partial<MeteredEvent>={}):MeteredEvent=>({id:'event',provider:'groq',model:'model',operation:'generation',input_tokens:100,output_tokens:80,created_at:new Date('2026-10-26T00:00:00Z'),metadata:{usageSource:'provider',reasoningTokens:40},...changes});
describe('business usage accounting',()=>{
 it('counts delivered replies independently of generation, planning, intake and analysis',()=>{
  const result=summarizeUsage([event(),event({metadata:{usageSource:'provider',purpose:'reservation_query'}}),event({metadata:{usageSource:'provider',purpose:'handoff_intake'}}),event({metadata:{usageSource:'provider',purpose:'analytics_synthesis'}})],usageMonth('2026-10'),1);
  expect(result.deliveredReplies).toBe(1);expect(result.generationCalls).toBe(4);expect(result.internalCalls).toBe(3);expect(result.breakdown).toHaveLength(4);
 });
 it('counts self-serve extraction, voice and rule checks as internal setup work',()=>{
  const result=summarizeUsage(['extract','voice','faithfulness'].map(purpose=>event({metadata:{usageSource:'provider',purpose:'selfserve_'+purpose}})),usageMonth('2026-10'),0);
  expect(result.generationCalls).toBe(3);expect(result.internalCalls).toBe(3);expect(result.deliveredReplies).toBe(0);expect(result.breakdown.map(row=>row.purpose)).toEqual(['Business setup']);
 });
 it('keeps reasoning inside output totals and missing usage unknown',()=>{
  const result=summarizeUsage([event(),event({input_tokens:9,output_tokens:3,metadata:{usageSource:'estimate'}})],usageMonth('2026-10'),1);
  expect(result.providerInputTokens).toBe(100);expect(result.providerOutputTokens).toBe(80);expect(result.reasoningTokens).toBe(40);expect(result.reasoningReportedCalls).toBe(1);
  expect(result.estimatedInputTokens).toBe(9);expect(result.estimatedOutputTokens).toBe(3);expect(result.estimatedCalls).toBe(1);
  expect(summarizeUsage([event({metadata:{usageSource:'provider'}})],usageMonth('2026-10'),0).reasoningReportedCalls).toBe(0);
 });
 it('handles UTC month boundaries and prevents unsafe export cells',()=>{
  expect(usageMonth('2026-12').until).toBe('2027-01-01T00:00:00.000Z');expect(()=>usageMonth('2026-13')).toThrow();
  const csv=usageCsv([event({model:'=SUM(1,2)',metadata:{usageSource:'provider',purpose:'a"b'}})]);
  expect(csv).toContain('"\'=SUM(1,2)"');expect(csv).toContain('"a""b"');expect(csv).toContain('reasoning_tokens_included_in_output');
 });
});
