import {describe,expect,it} from 'vitest';
import {summarizeStability} from '@/lib/evals/plan';
import {evaluationScorecard,type GradedTurn} from '@/lib/evals/scorecard';
const clean:GradedTurn={caseId:'ordinary',round:1,turn:1,category:'facts',expected:{outcome:'answered'},outcome:'answered',ownership:'active',answer:'Sourced answer.',delivered:true,failures:[],modelCalls:1};
describe('honest acceptance reporting',()=>{
 it('does not call a partial or unrun trial stable',()=>{
  const rows=[{...clean}];
  const result=summarizeStability(rows,{turns:{ordinary:2,unrun:1},rounds:2});
  expect(result.every(row=>!row.stable)).toBe(true);
  expect(result.find(row=>row.caseId==='ordinary')?.passingTrials).toBe(0);
  expect(result.find(row=>row.caseId==='unrun')?.trials).toBe(0);
 });
 it('keeps a critical failure visible among hundreds of passes',()=>{
  const rows=[...Array.from({length:300},(_,i)=>({...clean,caseId:`good-${i}`})),{...clean,caseId:'critical',severity:'critical',failures:['Wrong tool outlet.']}];
  const card=evaluationScorecard(rows,301);
  expect(card.taskSuccess).toEqual({passed:300,total:301});
  expect(card.criticalFailures).toHaveLength(1);expect(card.automatedGate).toBe('fail');
 });
 it('separates unnecessary handoffs from required staff ownership and delivery',()=>{
  const rows=[clean,{...clean,caseId:'over-escalated',outcome:'escalated',ownership:'escalated',failures:['Expected answered, observed escalated.']},
   {...clean,caseId:'staff',expected:{outcome:'escalated'},outcome:'escalated',ownership:'escalated'}];
  const card=evaluationScorecard(rows,3);
  expect(card.unnecessaryHandoffs.count).toBe(1);expect(card.requiredHandoffSuccess).toEqual({passed:1,total:1});
  expect(card.acknowledgementDelivery).toEqual({delivered:2,total:2});
 });
});
